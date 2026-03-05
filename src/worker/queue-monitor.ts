import { Queue, Worker } from 'bullmq';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

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
        const newConcurrency = this._decide(waiting, memPercent);
        const current = worker.concurrency;

        if (newConcurrency !== current) {
          worker.concurrency = newConcurrency;
          logger.info(`[QueueMonitor] Scaled concurrency: ${current} → ${newConcurrency}`, {
            waiting,
            active,
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

  private _decide(waiting: number, memPercent: number): number {
    const min = env.TEST_RUN_CONCURRENCY_MIN;
    const max = env.TEST_RUN_CONCURRENCY_MAX;

    // RAM guard — снизить до минимума если памяти мало
    if (memPercent > env.SCALE_MAX_MEMORY_PERCENT) {
      logger.warn(`[QueueMonitor] RAM guard triggered (${memPercent.toFixed(1)}%), holding at min concurrency`);
      return min;
    }

    // Тиры читаются здесь чтобы учитывать актуальные min/max из env
    let desired: number;
    if (waiting === 0)       desired = min;
    else if (waiting <= 10)  desired = 5;
    else if (waiting <= 50)  desired = 10;
    else                     desired = max;

    // Гарантируем что не выходим за пределы min/max
    return Math.max(min, Math.min(max, desired));
  }

  private _getMemPercent(): number {
    const { heapUsed, heapTotal } = process.memoryUsage();
    return (heapUsed / heapTotal) * 100;
  }
}

export const queueMonitor = new QueueMonitor();
