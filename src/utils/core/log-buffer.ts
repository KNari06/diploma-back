/**
 * In-memory ring buffer for Winston log entries.
 *
 * Backs the System Logs tab in the AI activity modal. Holds the last
 * `MAX_BUFFER_SIZE` entries, evicting oldest first. Cheap to query, never
 * touches disk. Lost on process restart — that's fine; this is for live
 * operational visibility, not historical audit.
 *
 * Why ring buffer instead of tailing files: file tailing requires file system
 * access from the API process AND log files don't exist in dev (logs only
 * stream to console there). Ring buffer works identically in dev and prod.
 */

const MAX_BUFFER_SIZE = 1_000;

export interface BufferedLogEntry {
  /** Monotonic id (incrementing). Used as the polling cursor. */
  seq: number;
  /** ISO timestamp at the moment the entry was buffered. */
  timestamp: string;
  /** Winston level. */
  level: 'error' | 'warn' | 'info' | 'http' | 'debug' | string;
  /** First-line summary. */
  message: string;
  /** Free-form structured fields the caller passed in. */
  meta?: Record<string, unknown>;
  /**
   * Which process produced the log line. 'api' is the main HTTP server,
   * 'worker' is the BullMQ worker, 'scheduler' is the cron-style scheduler.
   * Lets the operator filter / tell sources apart in the UI.
   */
  source?: 'api' | 'worker' | 'scheduler' | string;
}

class LogBuffer {
  private entries: BufferedLogEntry[] = [];
  private nextSeq = 1;
  private listeners = new Set<(entry: BufferedLogEntry) => void>();

  /**
   * Register a listener invoked for every entry pushed (after seq is assigned
   * and the eviction pass has run). Returns an unsubscribe function.
   * Listener errors are caught — never break the logger.
   */
  subscribe(fn: (entry: BufferedLogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  push(entry: Omit<BufferedLogEntry, 'seq'>): void {
    const stored: BufferedLogEntry = { ...entry, seq: this.nextSeq++ };
    this.entries.push(stored);
    if (this.entries.length > MAX_BUFFER_SIZE) {
      this.entries.splice(0, this.entries.length - MAX_BUFFER_SIZE);
    }
    for (const fn of this.listeners) {
      try {
        fn(stored);
      } catch {
        // Listener must never break logging.
      }
    }
  }

  /**
   * Return entries with `seq > sinceSeq`, newest first, capped at `limit`.
   * Optional level filter — exact match.
   */
  query(opts: { sinceSeq?: number; limit?: number; level?: string } = {}): BufferedLogEntry[] {
    const sinceSeq = opts.sinceSeq ?? 0;
    const level = opts.level;
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));

    let out: BufferedLogEntry[] = [];
    // Walk from newest to oldest, stopping at the cursor or limit.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.seq <= sinceSeq) break;
      if (level && e.level !== level) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Highest seq currently in the buffer (or 0 if empty). */
  latestSeq(): number {
    return this.entries.length === 0 ? 0 : this.entries[this.entries.length - 1].seq;
  }

  size(): number {
    return this.entries.length;
  }
}

export const logBuffer = new LogBuffer();
