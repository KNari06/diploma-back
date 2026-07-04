/**
 * LiteTraceWriter
 * Writes JSONL (newline-delimited JSON) trace events for Lite test execution
 * Always-on tracing to test_logs/<testId>.jsonl for debugging and AI analysis
 *
 * Features:
 * - Append-only JSONL format (crash-safe, streamable)
 * - Automatic redaction of sensitive fields (passwords, tokens, auth headers)
 * - Truncation of large payloads with hash preservation
 * - File size guard to prevent disk exhaustion
 * - Span tracking for correlation between events
 *
 * Usage:
 * 1. Each Lite test automatically creates test_logs/<testId>_<date>_<runId>.jsonl
 * 2. File contains one JSON object per line (JSONL format)
 * 3. Events are ordered chronologically with iteration context
 *
 * Event Types:
 * - run_start / run_end: Test lifecycle
 * - iteration_start / iteration_end: Each iteration boundary
 * - snapshot: LiteSnapshot + formatted snapshot for AI
 * - ai_prompt / ai_response: Main decision AI (gemini-2.5-flash-lite)
 * - ai_auditor_prompt / ai_auditor_response: Goal validation AI (gpt-5.4-mini)
 * - ai_strategy_initialized / ai_strategy_failed: Strategy init
 * - action_execute_start / action_execute_end: Action execution boundaries
 * - action_validation / action_execution_start / action_execution_end / action_fallback / action_modal_check: Detailed action steps
 * - state_diff: Before/after state comparison
 * - validation: Outcome classification
 * - error: Any collected errors
 *
 * Reading trace files:
 * - Each line is a valid JSON object
 * - Use jq for filtering: `cat test_logs/<testId>.jsonl | jq 'select(.eventType == "ai_response")'`
 * - Use grep for quick search: `grep "ai_prompt" test_logs/<testId>.jsonl`
 * - Feed to AI for analysis: entire file is self-contained context
 *
 * Redaction:
 * - Sensitive field patterns (password, token, auth, etc.) are replaced with [REDACTED]
 * - Input values in actions are masked
 * - Headers/cookies are filtered
 *
 * Truncation:
 * - Large payloads (>50k chars) are truncated with hash
 * - File size limit (100MB default) triggers summary-only mode
 */

import { logger } from '@/utils/core/logger';
import { localTraceFilenameParts } from '@/utils/helpers/trace-filename';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface TraceEvent {
  ts: string; // ISO timestamp
  testId: string;
  mode: 'lite';
  iteration?: number;
  stage: string;
  eventType: string;
  spanId: string;
  parentSpanId?: string;
  payload: Record<string, any>;
}

export interface TraceWriterConfig {
  testId: string;
  maxFileSizeBytes?: number; // Default: 100MB
  maxPayloadChars?: number; // Default: 50k chars per field
  /** Optional run identifier for correlating a specific execution (auto-generated if omitted) */
  runId?: string;
  /** Optional logs directory (defaults to <cwd>/test_logs) */
  logsDir?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_PAYLOAD_CHARS = 50_000; // 50k chars per field
const DEFAULT_LOGS_DIR = path.join(process.cwd(), 'test_logs');

// Sensitive field patterns (case-insensitive)
//
// Note: patterns must be precise — `/auth/i` matched harmless field names
// like `hasAuthBinding`, `authReset`, `authMethod`, redacting valuable
// diagnostic data. Same for `/session/i` swallowing `previewSessionId`,
// `chatSessionId`, `sessionCreatedAt`. We now whitelist the safe siblings
// before the broad pattern check so they survive.
//
// April 2026: discovered when session_context payload arrived as
// `{ previewSessionId: "[REDACTED]", authReset: "[REDACTED]", hasAuthBinding: "[REDACTED]" }`
// — these are not secrets; previewSessionId is the correlation key for the
// whole trace, authReset is a 'always'|'never' flag, hasAuthBinding is a bool.
const SAFE_FIELD_NAMES = new Set([
  // Session identity / metadata — UUIDs and timestamps, not secrets
  'previewSessionId',
  'sessionId',
  'mobileSessionId',
  'chatSessionId',
  'sessionCreatedAt',
  'sessionStartedAt',
  'isSessionOwned',
  'sessionStorageKeyCount',
  // Auth binding flags / resets — booleans and enum strings, not secrets
  'authReset',
  'hasAuthBinding',
  'authMethod',
  'authState',
  'isAuthenticated',
  'authResource',
  // Common no-secret auth-adjacent counts/flags
  'authCheckpointCount',
  // Page-health flags — booleans/counts, not secrets. `sessionLost` matches
  // the broad /session/i pattern but is just "did the flow get logged out".
  'sessionLost',
  'hasServerError',
]);

const SENSITIVE_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /authorization/i,
  /cookie/i,
  /api[_-]?key/i,
  /auth/i,
  /bearer/i,
  /session/i,
  /credentials?/i,
];

// ═══════════════════════════════════════════════════════════════════════════
// LITE TRACE WRITER
// ═══════════════════════════════════════════════════════════════════════════

export class LiteTraceWriter {
  private testId: string;
  private runId: string;
  private filePath: string;
  private logsDir: string;
  private maxFileSizeBytes: number;
  private maxPayloadChars: number;
  private currentFileSize: number = 0;
  private isFileSizeLimitReached: boolean = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private isClosed: boolean = false;
  private spanCounter: number = 0;
  private rootSpanId: string;

  /**
   * Create a new trace writer for a test
   * Ensures test_logs/ directory exists and initializes the trace file
   *
   * @param config - Writer configuration (testId, limits)
   */
  constructor(config: TraceWriterConfig) {
    this.testId = config.testId;
    this.runId = config.runId || LiteTraceWriter.generateRunId();
    this.maxFileSizeBytes = config.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE;
    this.maxPayloadChars = config.maxPayloadChars || DEFAULT_MAX_PAYLOAD_CHARS;
    this.logsDir = config.logsDir || DEFAULT_LOGS_DIR;

    // Ensure logs directory exists
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // Create file path: test_logs/<date>_<time>_<testId>.jsonl
    // Date+time first for easy sorting; testId last for identification.
    // Local wall-clock (not UTC) so the filename matches when you saw it.
    const { datePart, timePart } = localTraceFilenameParts();
    const safeTestId = LiteTraceWriter.sanitizeFilePart(this.testId);
    this.filePath = path.join(this.logsDir, `${datePart}_${timePart}_${safeTestId}.jsonl`);

    // Generate root span ID
    this.rootSpanId = this.generateSpanId();

    logger.info('[LITE_TRACE] Writer initialized', {
      testId: this.testId,
      runId: this.runId,
      filePath: this.filePath,
      logsDir: this.logsDir,
      maxFileSizeMB: Math.round(this.maxFileSizeBytes / 1024 / 1024),
    });
  }

  /**
   * Write a trace event to the JSONL file
   * Non-blocking: queues writes to prevent race conditions
   *
   * @param event - Event to write (without ts/testId/mode/spanId which are added automatically)
   */
  public write(event: Omit<TraceEvent, 'ts' | 'testId' | 'mode' | 'spanId'> & { spanId?: string }): void {
    if (this.isClosed) {
      logger.warn('[LITE_TRACE] Attempted to write to closed trace writer', {
        testId: this.testId,
        eventType: event.eventType,
      });
      return;
    }

    // If file size limit reached, only write summary events
    if (this.isFileSizeLimitReached && !this.isSummaryEvent(event.eventType)) {
      return;
    }

    // Build complete event
    const completeEvent: TraceEvent = {
      ts: new Date().toISOString(),
      testId: this.testId,
      mode: 'lite',
      iteration: event.iteration,
      stage: event.stage,
      eventType: event.eventType,
      spanId: event.spanId || this.generateSpanId(),
      parentSpanId: event.parentSpanId,
      payload: this.sanitizePayload(event.payload),
    };

    // Queue the write
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const line = JSON.stringify(completeEvent) + '\n';
        const lineSize = Buffer.byteLength(line, 'utf8');

        // Check if adding this line would exceed file size limit
        if (this.currentFileSize + lineSize > this.maxFileSizeBytes && !this.isFileSizeLimitReached) {
          this.isFileSizeLimitReached = true;

          // Write truncation warning
          const warningEvent: TraceEvent = {
            ts: new Date().toISOString(),
            testId: this.testId,
            mode: 'lite',
            stage: 'trace_system',
            eventType: 'log_truncated',
            spanId: this.generateSpanId(),
            payload: {
              reason: 'File size limit reached',
              maxSizeMB: Math.round(this.maxFileSizeBytes / 1024 / 1024),
              currentSizeMB: Math.round(this.currentFileSize / 1024 / 1024),
              message: 'Only summary events will be logged from now on',
            },
          };
          const warningLine = JSON.stringify(warningEvent) + '\n';
          await fs.promises.appendFile(this.filePath, warningLine, 'utf8');
          this.currentFileSize += Buffer.byteLength(warningLine, 'utf8');

          logger.warn('[LITE_TRACE] File size limit reached, switching to summary-only mode', {
            testId: this.testId,
            currentSizeMB: Math.round(this.currentFileSize / 1024 / 1024),
          });

          // Don't write the current event if it's not a summary event
          if (!this.isSummaryEvent(event.eventType)) {
            return;
          }
        }

        // Write to file
        await fs.promises.appendFile(this.filePath, line, 'utf8');
        this.currentFileSize += lineSize;
      } catch (error) {
        logger.error('[LITE_TRACE] Failed to write event', {
          testId: this.testId,
          eventType: event.eventType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Flush all pending writes and close the writer
   * Call this at the end of the test (success/failure/cancellation)
   */
  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;

    // Wait for all pending writes with timeout to prevent infinite hangs
    const CLOSE_TIMEOUT_MS = 10_000;
    try {
      await Promise.race([
        this.writeQueue,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Trace writer close timed out')), CLOSE_TIMEOUT_MS)
        ),
      ]);
    } catch (error) {
      logger.warn('[LITE_TRACE] Writer close timeout or error, some events may be lost', {
        testId: this.testId,
        runId: this.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('[LITE_TRACE] Writer closed', {
      testId: this.testId,
      runId: this.runId,
      finalSizeMB: Math.round(this.currentFileSize / 1024 / 1024),
      truncated: this.isFileSizeLimitReached,
    });
  }

  /**
   * Get the run ID for this trace file (unique per execution).
   */
  public getRunId(): string {
    return this.runId;
  }

  /**
   * Get the trace file path for this run.
   */
  public getFilePath(): string {
    return this.filePath;
  }

  /**
   * Get the root span ID for this test
   * Use this as parentSpanId for top-level events
   */
  public getRootSpanId(): string {
    return this.rootSpanId;
  }

  /**
   * Generate a new span ID for event correlation
   */
  public generateSpanId(): string {
    this.spanCounter++;
    return `span_${this.testId.slice(0, 8)}_${this.spanCounter}`;
  }

  /**
   * Generate a short run ID safe for filenames.
   * Uses timestamp + random suffix to avoid collisions across parallel runs.
   */
  private static generateRunId(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = crypto.randomBytes(3).toString('hex'); // 6 hex chars
    return `${ts}_${rand}`;
  }

  /**
   * Sanitize a string for safe use in filenames (prevents path traversal and invalid chars).
   * Keeps only [a-zA-Z0-9_-], replaces everything else with '_', and caps length.
   */
  private static sanitizeFilePart(input: string): string {
    const safe = (input || 'unknown')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80);
    return safe.length > 0 ? safe : 'unknown';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if event type is a summary event (always written even when file size limit reached).
   *
   * `trace_summary` was added in May 2026 — the editor-trace path writes it
   * as the LAST event on `close()` so upload-side `parsed_data` reads
   * pre-aggregated stats without re-scanning the JSONL. If the file hits
   * its size cap before close fires, dropping the summary would leave
   * `parsed_data` empty for that session. The line is small (~500 bytes
   * of bucket counts) and survives the cap by design.
   */
  private isSummaryEvent(eventType: string): boolean {
    return [
      'run_start',
      'run_end',
      'iteration_start',
      'iteration_end',
      'error',
      'log_truncated',
      'trace_summary',
    ].includes(eventType);
  }

  /**
   * Sanitize payload: redact secrets, truncate large values, add hashes
   * Recursively processes nested objects and arrays
   *
   * @param payload - Raw payload object
   * @returns Sanitized payload
   */
  private sanitizePayload(payload: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(payload)) {
      // Whitelist takes precedence — auth/session-adjacent metadata that's
      // explicitly not a secret survives even though the broad regex would
      // match (e.g. previewSessionId, authReset, hasAuthBinding).
      const isSafe = SAFE_FIELD_NAMES.has(key);
      const isSensitive = !isSafe && SENSITIVE_PATTERNS.some(pattern => pattern.test(key));

      if (isSensitive) {
        // Redact sensitive fields
        sanitized[key] = '[REDACTED]';
        continue;
      }

      // Process value based on type
      if (value === null || value === undefined) {
        sanitized[key] = value;
      } else if (typeof value === 'string') {
        sanitized[key] = this.truncateString(value);
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map((item) =>
          typeof item === 'object' && item !== null
            ? this.sanitizePayload(item)
            : typeof item === 'string'
            ? this.truncateString(item)
            : item
        );
      } else if (typeof value === 'object') {
        sanitized[key] = this.sanitizePayload(value);
      } else {
        // Primitives (number, boolean, etc.)
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Truncate a string and add hash if truncated
   *
   * @param str - String to truncate
   * @param key - Key name (for logging context)
   * @returns Truncated string or object with truncated + hash
   */
  private truncateString(str: string): string | { truncated: string; hash: string; originalLength: number } {
    const redacted = this.redactString(str);
    if (redacted.length <= this.maxPayloadChars) {
      return redacted;
    }

    // Truncate and add hash for correlation
    const truncated = redacted.slice(0, this.maxPayloadChars);
    const hash = this.hashString(str);

    return {
      truncated,
      hash,
      originalLength: redacted.length,
    };
  }

  /**
   * Redact secrets based on string content (not only keys).
   * Handles Bearer tokens, JWT-like strings, and sensitive query params in URLs/text.
   */
  private redactString(input: string): string {
    let out = input;

    // 1) Authorization headers / Bearer tokens
    out = out.replace(/Bearer\s+[A-Za-z0-9\-_.=]+/g, 'Bearer [REDACTED]');
    out = out.replace(/Basic\s+[A-Za-z0-9\/=+]+/g, 'Basic [REDACTED]');

    // 2) JWT-like token strings (best-effort)
    out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT_REDACTED]');

    // 3) Mask sensitive query params in URLs (only if parseable)
    if (out.startsWith('http://') || out.startsWith('https://')) {
      try {
        const url = new URL(out);
        const sensitiveParams = [
          'token',
          'access_token',
          'refresh_token',
          'api_key',
          'apikey',
          'key',
          'secret',
          'password',
          'auth',
          'session',
        ];
        for (const p of sensitiveParams) {
          if (url.searchParams.has(p)) {
            url.searchParams.set(p, '[REDACTED]');
          }
        }
        out = url.toString();
      } catch {
        // ignore URL parsing failures
      }
    }

    // 4) Mask common key=value secrets in any text
    out = out.replace(
      /\b(token|access_token|refresh_token|api[_-]?key|apikey|key|secret|password)=([^&\s]+)/gi,
      (_m, k) => `${String(k)}=[REDACTED]`
    );

    return out;
  }

  /**
   * Compute SHA-256 hash of a string
   * Used for correlation when content is truncated
   *
   * @param str - String to hash
   * @returns Hex-encoded hash
   */
  private hashString(str: string): string {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
  }
}
