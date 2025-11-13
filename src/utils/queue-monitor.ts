import { testRunQueue, QUEUE_NAMES } from '@/config/queues';
import { logger } from '@/utils/logger';

/**
 * Queue Monitor - отслеживание состояния очереди и jobs
 */
export class QueueMonitor {
  /**
   * Получить детальную информацию о состоянии очереди
   */
  static async getQueueStatus() {
    try {
      const counts = await testRunQueue.getJobCounts();

      logger.info('📊 [QUEUE_MONITOR] Queue Status', {
        queue: QUEUE_NAMES.TEST_RUN,
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        delayed: counts.delayed || 0,
        paused: counts.paused || 0,
      });

      return counts;
    } catch (error) {
      logger.error('❌ [QUEUE_MONITOR] Failed to get queue status', { error });
      return null;
    }
  }

  /**
   * Получить список waiting jobs (первые 10)
   */
  static async getWaitingJobs() {
    try {
      const jobs = await testRunQueue.getWaiting(0, 9);

      logger.info('⏳ [QUEUE_MONITOR] Waiting Jobs', {
        count: jobs.length,
        jobs: jobs.map(job => ({
          id: job.id,
          testId: job.data?.testId,
          browser: job.data?.browser,
          intelligentMode: job.data?.intelligentMode,
          addedAt: job.timestamp,
        })),
      });

      return jobs;
    } catch (error) {
      logger.error('❌ [QUEUE_MONITOR] Failed to get waiting jobs', { error });
      return [];
    }
  }

  /**
   * Получить список active jobs
   */
  static async getActiveJobs() {
    try {
      const jobs = await testRunQueue.getActive(0, 9);

      logger.info('🔄 [QUEUE_MONITOR] Active Jobs', {
        count: jobs.length,
        jobs: jobs.map(job => ({
          id: job.id,
          testId: job.data?.testId,
          browser: job.data?.browser,
          intelligentMode: job.data?.intelligentMode,
          processedOn: job.processedOn,
        })),
      });

      return jobs;
    } catch (error) {
      logger.error('❌ [QUEUE_MONITOR] Failed to get active jobs', { error });
      return [];
    }
  }

  /**
   * Получить список failed jobs (последние 10)
   */
  static async getFailedJobs() {
    try {
      const jobs = await testRunQueue.getFailed(0, 9);

      logger.info('❌ [QUEUE_MONITOR] Failed Jobs', {
        count: jobs.length,
        jobs: jobs.map(job => ({
          id: job.id,
          testId: job.data?.testId,
          browser: job.data?.browser,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
        })),
      });

      return jobs;
    } catch (error) {
      logger.error('❌ [QUEUE_MONITOR] Failed to get failed jobs', { error });
      return [];
    }
  }

  /**
   * Получить конкретный job по ID
   */
  static async getJob(jobId: string) {
    try {
      const job = await testRunQueue.getJob(jobId);

      if (!job) {
        logger.warn('⚠️ [QUEUE_MONITOR] Job not found', { jobId });
        return null;
      }

      const state = await job.getState();

      logger.info('🔍 [QUEUE_MONITOR] Job Details', {
        id: job.id,
        state,
        testId: job.data?.testId,
        browser: job.data?.browser,
        intelligentMode: job.data?.intelligentMode,
        attempts: job.attemptsMade,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
      });

      return { job, state };
    } catch (error) {
      logger.error('❌ [QUEUE_MONITOR] Failed to get job', { error, jobId });
      return null;
    }
  }

  /**
   * Мониторинг очереди - вызывай после добавления job
   */
  static async monitorAfterJobAdd(jobId: string, testId: string) {
    logger.info('🔍 [QUEUE_MONITOR] Starting monitoring for job', { jobId, testId });

    // Подожди немного и проверь состояние
    setTimeout(async () => {
      await this.getQueueStatus();
      await this.getJob(jobId);

      const waiting = await this.getWaitingJobs();
      const active = await this.getActiveJobs();

      if (waiting.length === 0 && active.length === 0) {
        logger.warn('⚠️ [QUEUE_MONITOR] Job disappeared! Not in waiting or active', { jobId, testId });
      }
    }, 2000); // 2 секунды
  }

  /**
   * Периодический мониторинг очереди (для debugging)
   */
  static startPeriodicMonitoring(intervalMs: number = 10000) {
    logger.info('🔄 [QUEUE_MONITOR] Starting periodic monitoring', { intervalMs });

    return setInterval(async () => {
      const status = await this.getQueueStatus();

      if (status) {
        // Если есть waiting jobs, но нет active - что-то не так
        if (status.waiting > 0 && status.active === 0) {
          logger.warn('⚠️ [QUEUE_MONITOR] Jobs waiting but none active! Worker may be down.', status);
        }

        // Если много failed jobs
        if (status.failed > 5) {
          logger.warn('⚠️ [QUEUE_MONITOR] Many failed jobs detected!', status);
          await this.getFailedJobs();
        }
      }
    }, intervalMs);
  }

  /**
   * Остановить периодический мониторинг
   */
  static stopPeriodicMonitoring(intervalId: NodeJS.Timeout) {
    clearInterval(intervalId);
    logger.info('🛑 [QUEUE_MONITOR] Stopped periodic monitoring');
  }
}
