import os from 'os';
import { Queue, Worker } from 'bullmq';
import { env } from '@/config/environment/env';
import { browserPool } from '@/agent/browser/browser-pool';
import { logger } from '@/utils/core/logger';

/** Max browser contexts before refusing to scale up */
const MAX_CONTEXTS_THRESHOLD = 15;

export class QueueMonitor {
  private intervalId: NodeJS.Timeout | null = null;

  start(worker: Worker, queue: Queue): void {
    if (this.intervalId) return;

    logger.info('[QueueMonitor] Starting dynamic concurrency scaling', {
      min: env.TEST_RUN_CONCURRENCY_MIN,
      max: env.TEST_RUN_CONCURRENCY_MAX,
      intervalMs: env.SCALE_CHECK_INTERVAL_MS,
      maxMemoryPercent: env.SCALE_MAX_MEMORY_PERCENT,
    });

    this.intervalId = setInterval(async () => {
      try {
        const [waiting, active] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
        ]);

        const memPercent = this._getMemPercent();
        const contexts = browserPool.getTotalContextCount();
        const newConcurrency = this._decide(waiting, memPercent, contexts);
        const current = worker.concurrency ?? env.TEST_RUN_CONCURRENCY_MIN;

        if (newConcurrency !== current) {
          worker.concurrency = newConcurrency;
          logger.info(`[QueueMonitor] Scaled concurrency: ${current} → ${newConcurrency}`, {
            waiting,
            active,
            contexts,
            memPercent: memPercent.toFixed(1) + '%',
          });
        }
      } catch (error) {
        logger.warn('[QueueMonitor] Scale check failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, env.SCALE_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[QueueMonitor] Stopped');
    }
  }

  private _decide(waiting: number, memPercent: number, contexts: number): number {
    const min = env.TEST_RUN_CONCURRENCY_MIN;
    const max = env.TEST_RUN_CONCURRENCY_MAX;

    // RAM guard — drop to min if memory is too high
    if (memPercent > env.SCALE_MAX_MEMORY_PERCENT) {
      logger.warn(`[QueueMonitor] RAM guard triggered (${memPercent.toFixed(1)}%), holding at min concurrency`);
      return min;
    }

    // Tiered scaling based on queue depth
    let desired: number;
    if (waiting === 0)       desired = min;
    else if (waiting <= 10)  desired = 5;
    else if (waiting <= 50)  desired = 10;
    else                     desired = max;

    // Context guard — cap desired concurrency if too many contexts are open
    // Unlike RAM guard, this does NOT drop to min — it just prevents scaling UP further
    if (contexts >= MAX_CONTEXTS_THRESHOLD && desired > contexts) {
      logger.info(`[QueueMonitor] Context guard: capping concurrency at ${contexts} (${contexts} contexts open)`);
      desired = contexts;
    }

    // Clamp to min/max bounds
    return Math.max(min, Math.min(max, desired));
  }

  private _getMemPercent(): number {
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    return ((totalRam - freeRam) / totalRam) * 100;
  }
}

export const queueMonitor = new QueueMonitor();
