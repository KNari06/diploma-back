/**
 * ReplayTraceWriter
 * Writes JSONL trace events for replay test execution.
 * One file per replay run: test_logs/replay/{YYYY-MM-DD}_{testId}_{runId}.jsonl
 *
 * Based on LiteTraceWriter pattern with mode='replay'.
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

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_PAYLOAD_CHARS = 50_000;
const DEFAULT_LOGS_DIR = path.join(process.cwd(), 'test_logs', 'replay');

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

/** Summary events that are always written even when file size limit is reached */
const SUMMARY_EVENTS = new Set(['run_start', 'run_end', 'step_failed']);

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

    // File path: test_logs/replay/{YYYY-MM-DD}_{HH-MM-SS}_{testId}.jsonl
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10);
    const timePart = now.toISOString().slice(11, 19).replace(/:/g, '-'); // HH-MM-SS
    const safeTestId = ReplayTraceWriter.sanitizeFilePart(this.testId);
    this.filePath = path.join(logsDir, `${datePart}_${timePart}_${safeTestId}.jsonl`);

    logger.info('[REPLAY_TRACE] Writer initialized', {
      testId: this.testId,
      runId: this.runId,
      filePath: this.filePath,
    });
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
        const line = JSON.stringify(completeEvent) + '\n';
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
