/**
 * ReplayTraceWriter
 * Writes JSONL trace events for regression (Background Replay) test execution.
 * One file per run: test_logs/regressions/{YYYY-MM-DD}_{HH-MM-SS}_{testId}.jsonl
 * (override base dir via env REGRESSION_LOGS_DIR / legacy REPLAY_LOGS_DIR).
 *
 * Based on LiteTraceWriter pattern with mode='replay' (kept for back-compat
 * with existing JSONL readers).
 *
 * Features:
 * - Append-only JSONL format (crash-safe, streamable)
 * - Automatic redaction of sensitive fields (passwords, tokens, auth headers)
 * - Truncation of large payloads with hash preservation
 * - File size guard to prevent disk exhaustion (100MB)
 * - Non-blocking write queue
 *
 * Event Types:
 * - run_start: Beginning of replay run
 * - step_start: Before executeCommand
 * - step_completed: Step succeeded
 * - step_failed: Step failed
 * - run_end: End of replay run
 */

import { logger } from '@/utils/core/logger';
import { REPLAY_TRACE_CONFIG } from '@/config/testing/playwright-tuning';
import { localTraceFilenameParts } from '@/utils/helpers/trace-filename';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ReplayTraceEvent {
  ts: string;
  testId: string;
  mode: 'replay';
  step: number;
  totalSteps: number;
  eventType: string;
  payload: Record<string, any>;
}

export interface ReplayTraceWriterConfig {
  testId: string;
  maxFileSizeBytes?: number;
  maxPayloadChars?: number;
  runId?: string;
  logsDir?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_FILE_SIZE = REPLAY_TRACE_CONFIG.maxFileSizeBytes;
const DEFAULT_MAX_PAYLOAD_CHARS = REPLAY_TRACE_CONFIG.maxPayloadChars;
const DEFAULT_LOGS_DIR = REPLAY_TRACE_CONFIG.logsDir;
const SENSITIVE_PATTERNS = REPLAY_TRACE_CONFIG.sensitivePatterns;
const SUMMARY_EVENTS: Set<string> = new Set(REPLAY_TRACE_CONFIG.summaryEvents);

// ═══════════════════════════════════════════════════════════════════════════
// REPLAY TRACE WRITER
// ═══════════════════════════════════════════════════════════════════════════

export class ReplayTraceWriter {
  private testId: string;
  private runId: string;
  private filePath: string;
  private maxFileSizeBytes: number;
  private maxPayloadChars: number;
  private currentFileSize: number = 0;
  private isFileSizeLimitReached: boolean = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private isClosed: boolean = false;
  /**
   * Phase 2.5 — pairs of (raw, json-escaped) substrings to mask before
   * writing the JSONL line. Populated via `setRedactValues`. Empty
   * means no redaction (cheap fast path). Both forms are needed because
   * payloads are JSON.stringify'd before write, so a secret containing
   * special chars (`"`, `\`, control bytes) appears in escaped form on
   * disk and a raw substring search wouldn't find it.
   */
  private redactPairs: Array<{ raw: string; escaped: string }> = [];

  constructor(config: ReplayTraceWriterConfig) {
    this.testId = config.testId;
    this.runId = config.runId || ReplayTraceWriter.generateRunId();
    this.maxFileSizeBytes = config.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE;
    this.maxPayloadChars = config.maxPayloadChars || DEFAULT_MAX_PAYLOAD_CHARS;

    const logsDir = config.logsDir || DEFAULT_LOGS_DIR;

    // Ensure logs directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // File path: test_logs/regressions/{YYYY-MM-DD}_{HH-MM-SS}_{testId}.jsonl
    // (folder override: REGRESSION_LOGS_DIR / legacy REPLAY_LOGS_DIR)
    // Local wall-clock (not UTC) so the filename matches when you saw it.
    const { datePart, timePart } = localTraceFilenameParts();
    const safeTestId = ReplayTraceWriter.sanitizeFilePart(this.testId);
    this.filePath = path.join(logsDir, `${datePart}_${timePart}_${safeTestId}.jsonl`);

    logger.info('[REPLAY_TRACE] Writer initialized', {
      testId: this.testId,
      runId: this.runId,
      filePath: this.filePath,
    });
  }

  /**
   * Phase 2.5 — register the secret values we must mask before writing
   * any line. Idempotent; pass `[]` to disable redaction. Computes the
   * JSON-escaped form once so the post-stringify replace finds secrets
   * even when they contain `"` / `\` / control chars (real-world JWTs
   * with `+` and `/` are fine without escaping; service-account JSON
   * blobs are not).
   */
  public setRedactValues(values: readonly string[]): void {
    if (!values || values.length === 0) {
      this.redactPairs = [];
      return;
    }
    // Sort longest-first so a long secret containing a shorter one as a
    // substring is masked entirely.
    const sorted = [...values].filter((v) => typeof v === 'string' && v.length >= 4).sort((a, b) => b.length - a.length);
    this.redactPairs = sorted.map((raw) => {
      // JSON.stringify("...") → "\"...\"" — slice off the surrounding quotes.
      const escaped = JSON.stringify(raw).slice(1, -1);
      return { raw, escaped };
    });
  }

  /**
   * Phase 2.5 — apply registered redactions to a serialised JSONL line.
   * Replaces both raw and JSON-escaped forms of each secret with `***`.
   * No-op when nothing registered.
   */
  private redactLine(line: string): string {
    if (this.redactPairs.length === 0) return line;
    let out = line;
    for (const { raw, escaped } of this.redactPairs) {
      if (escaped !== raw && out.includes(escaped)) {
        out = out.split(escaped).join('***');
      }
      if (out.includes(raw)) {
        out = out.split(raw).join('***');
      }
    }
    return out;
  }

  /**
   * Write a replay trace event.
   * Non-blocking: queues writes to prevent race conditions.
   */
  public write(event: { eventType: string; step: number; totalSteps: number; payload: Record<string, any> }): void {
    if (this.isClosed) {
      return;
    }

    if (this.isFileSizeLimitReached && !SUMMARY_EVENTS.has(event.eventType)) {
      return;
    }

    const completeEvent: ReplayTraceEvent = {
      ts: new Date().toISOString(),
      testId: this.testId,
      mode: 'replay',
      step: event.step,
      totalSteps: event.totalSteps,
      eventType: event.eventType,
      payload: this.sanitizePayload(event.payload),
    };

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const line = this.redactLine(JSON.stringify(completeEvent) + '\n');
        const lineSize = Buffer.byteLength(line, 'utf8');

        if (this.currentFileSize + lineSize > this.maxFileSizeBytes && !this.isFileSizeLimitReached) {
          this.isFileSizeLimitReached = true;
          const warningLine = JSON.stringify({
            ts: new Date().toISOString(),
            testId: this.testId,
            mode: 'replay',
            step: 0,
            totalSteps: 0,
            eventType: 'log_truncated',
            payload: {
              reason: 'File size limit reached',
              maxSizeMB: Math.round(this.maxFileSizeBytes / 1024 / 1024),
            },
          }) + '\n';
          await fs.promises.appendFile(this.filePath, warningLine, 'utf8');
          this.currentFileSize += Buffer.byteLength(warningLine, 'utf8');

          if (!SUMMARY_EVENTS.has(event.eventType)) {
            return;
          }
        }

        await fs.promises.appendFile(this.filePath, line, 'utf8');
        this.currentFileSize += lineSize;
      } catch (error) {
        logger.error('[REPLAY_TRACE] Failed to write event', {
          testId: this.testId,
          eventType: event.eventType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Flush all pending writes and close the writer.
   */
  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    const CLOSE_TIMEOUT_MS = 10_000;
    try {
      await Promise.race([
        this.writeQueue,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Replay trace writer close timed out')), CLOSE_TIMEOUT_MS),
        ),
      ]);
    } catch (error) {
      logger.warn('[REPLAY_TRACE] Writer close timeout', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('[REPLAY_TRACE] Writer closed', {
      testId: this.testId,
      filePath: this.filePath,
      finalSizeKB: Math.round(this.currentFileSize / 1024),
    });
  }

  public getFilePath(): string {
    return this.filePath;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private static generateRunId(): string {
    return crypto.randomBytes(4).toString('hex');
  }

  private static sanitizeFilePart(input: string): string {
    const safe = (input || 'unknown')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80);
    return safe.length > 0 ? safe : 'unknown';
  }

  private sanitizePayload(payload: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (SENSITIVE_PATTERNS.some(p => p.test(key))) {
        sanitized[key] = '[REDACTED]';
        continue;
      }
      if (value === null || value === undefined) {
        sanitized[key] = value;
      } else if (typeof value === 'string') {
        sanitized[key] = this.truncateString(value);
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map(item =>
          typeof item === 'object' && item !== null
            ? this.sanitizePayload(item)
            : typeof item === 'string'
            ? this.truncateString(item)
            : item,
        );
      } else if (typeof value === 'object') {
        sanitized[key] = this.sanitizePayload(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private truncateString(str: string): string | { truncated: string; hash: string; originalLength: number } {
    if (str.length <= this.maxPayloadChars) {
      return str;
    }
    return {
      truncated: str.slice(0, this.maxPayloadChars),
      hash: crypto.createHash('sha256').update(str, 'utf8').digest('hex'),
      originalLength: str.length,
    };
  }
}
