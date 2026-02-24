import { EventEmitter } from 'events';

import { connection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';
import Redis from 'ioredis';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CHANNEL = 'execution:completion';

/**
 * Cross-process execution completion emitter.
 *
 * Uses Redis pub/sub to signal execution completion from worker processes
 * to the main process where executeTestCasesAsync() waits for dependent tests.
 *
 * Lifecycle:
 *   1. Main process calls startSubscriber() at startup → subscribes to Redis channel
 *   2. executeTestCasesAsync() calls waitForCompletion() → waits on local EventEmitter
 *   3. Worker completes test → signalCompletion() → publishes to Redis + local emit
 *   4. Main process Redis subscriber receives message → local emit → waiter resolves
 *
 * Fallback: If Redis is unavailable, local emit still works for single-process deployment.
 */
class ExecutionCompletionEmitter extends EventEmitter {
  private static instance: ExecutionCompletionEmitter;
  private subscriber: Redis | null = null;
  private publisher: Redis | null = null;
  private isSubscribed = false;

  private constructor() {
    super();
    this.setMaxListeners(500);
  }

  static getInstance(): ExecutionCompletionEmitter {
    if (!this.instance) {
      this.instance = new ExecutionCompletionEmitter();
    }
    return this.instance;
  }

  /**
   * Wait for a specific execution to reach a terminal status.
   * Returns the final status ('passed' | 'failed' | 'skipped' | 'cancelled').
   */
  waitForCompletion(executionId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve) => {
      const eventName = `exec:${executionId}`;

      const timer = setTimeout(() => {
        this.removeAllListeners(eventName);
        logger.warn('[EXEC_COMPLETION_EMITTER] Timed out waiting for execution', {
          executionId,
          timeoutMs,
        });
        resolve('failed');
      }, timeoutMs);

      // once() auto-removes after first signal — safe for duplicate Redis + local emit
      this.once(eventName, (status: string) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
  }

  /**
   * Signal that an execution has completed.
   * Publishes to Redis (cross-process) AND emits locally (same-process fallback).
   */
  signalCompletion(executionId: string, status: string): void {
    const eventName = `exec:${executionId}`;

    // 1. Local emit (same-process fallback, also handles single-process deployment)
    this.emit(eventName, status);

    // 2. Redis publish (cross-process — reaches main process subscriber)
    this.publishToRedis(executionId, status).catch(() => {
      // Non-fatal: local emit already fired. Redis failure only affects cross-process.
    });
  }

  /**
   * Start Redis subscriber for cross-process execution signals.
   * Call once at main process startup (alongside WebSocket Redis subscriber).
   */
  async startSubscriber(): Promise<void> {
    if (this.isSubscribed) return;

    try {
      this.subscriber = new Redis(connection as any);

      this.subscriber.on('error', () => {
        // Suppress — ioredis auto-reconnects
      });

      await this.subscriber.subscribe(CHANNEL);

      this.subscriber.on('message', (_channel: string, message: string) => {
        try {
          const { executionId, status } = JSON.parse(message);
          if (executionId && status) {
            logger.debug('[EXEC_COMPLETION_EMITTER] Received cross-process signal', {
              executionId,
              status,
            });
            // Emit locally so waitForCompletion() resolves
            this.emit(`exec:${executionId}`, status);
          }
        } catch {
          // Malformed message — skip
        }
      });

      this.isSubscribed = true;
      logger.info('[EXEC_COMPLETION_EMITTER] Redis subscriber started', { channel: CHANNEL });
    } catch (error) {
      logger.warn('[EXEC_COMPLETION_EMITTER] Failed to start Redis subscriber (falling back to local emit)', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Non-fatal — local emit still works for single-process
    }
  }

  /**
   * Stop Redis subscriber (for graceful shutdown).
   */
  async stopSubscriber(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(CHANNEL);
        this.subscriber.disconnect();
      } catch { /* best effort */ }
      this.subscriber = null;
      this.isSubscribed = false;
    }
    if (this.publisher) {
      try { this.publisher.disconnect(); } catch { /* best effort */ }
      this.publisher = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  private async publishToRedis(executionId: string, status: string): Promise<void> {
    try {
      if (!this.publisher) {
        this.publisher = new Redis(connection as any);
        this.publisher.on('error', () => { /* suppress */ });
      }

      const msg = JSON.stringify({ executionId, status });
      await this.publisher.publish(CHANNEL, msg);
    } catch (error) {
      logger.debug('[EXEC_COMPLETION_EMITTER] Redis publish failed (local emit still works)', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const executionCompletionEmitter = ExecutionCompletionEmitter.getInstance();
