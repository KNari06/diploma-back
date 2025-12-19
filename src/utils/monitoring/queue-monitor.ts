import { QUEUE_NAMES, testRunQueue } from '@/config/infrastructure/queues';
import { logger } from '../core/logger';

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

      // Validate counts object
      if (!counts || typeof counts !== 'object') {
        logger.warn('⚠️ [QUEUE_MONITOR] Invalid counts returned', { counts });
        return {
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          paused: 0,
        };
      }

      // Safely extract counts with fallback to 0
      const safeCounts = {
        waiting: Number.isFinite(counts.waiting) ? Math.max(0, counts.waiting) : 0,
        active: Number.isFinite(counts.active) ? Math.max(0, counts.active) : 0,
        completed: Number.isFinite(counts.completed) ? Math.max(0, counts.completed) : 0,
        failed: Number.isFinite(counts.failed) ? Math.max(0, counts.failed) : 0,
        delayed: Number.isFinite(counts.delayed) ? Math.max(0, counts.delayed) : 0,
        paused: Number.isFinite(counts.paused) ? Math.max(0, counts.paused) : 0,
      };

      logger.info('📊 [QUEUE_MONITOR] Queue Status', {
        queue: QUEUE_NAMES.TEST_RUN,
        ...safeCounts,
      });

      return counts; // Return original counts object for compatibility
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

      // Validate jobs array
      if (!Array.isArray(jobs)) {
        logger.warn('⚠️ [QUEUE_MONITOR] Invalid jobs array returned', { jobs });
        return [];
      }

      logger.info('⏳ [QUEUE_MONITOR] Waiting Jobs', {
        count: jobs.length,
        jobs: jobs
          .filter(job => job && typeof job === 'object')
          .map(job => ({
            id: job.id || 'unknown',
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

      // Validate jobs array
      if (!Array.isArray(jobs)) {
        logger.warn('⚠️ [QUEUE_MONITOR] Invalid jobs array returned', { jobs });
        return [];
      }

      logger.info('🔄 [QUEUE_MONITOR] Active Jobs', {
        count: jobs.length,
        jobs: jobs
          .filter(job => job && typeof job === 'object')
          .map(job => ({
            id: job.id || 'unknown',
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

      // Validate jobs array
      if (!Array.isArray(jobs)) {
        logger.warn('⚠️ [QUEUE_MONITOR] Invalid jobs array returned', { jobs });
        return [];
      }

      logger.info('❌ [QUEUE_MONITOR] Failed Jobs', {
        count: jobs.length,
        jobs: jobs
          .filter(job => job && typeof job === 'object')
          .map(job => ({
            id: job.id || 'unknown',
            testId: job.data?.testId,
            browser: job.data?.browser,
            failedReason: job.failedReason,
            attemptsMade: Number.isFinite(job.attemptsMade) ? job.attemptsMade : 0,
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
    // Validate input
    if (!jobId || typeof jobId !== 'string' || jobId.trim().length === 0) {
      logger.warn('⚠️ [QUEUE_MONITOR] Invalid jobId', { jobId });
      return null;
    }

    try {
      const job = await testRunQueue.getJob(jobId.trim());

      if (!job) {
        logger.warn('⚠️ [QUEUE_MONITOR] Job not found', { jobId });
        return null;
      }

      let state: string;
      try {
        state = await job.getState();
      } catch (stateError) {
        logger.warn('⚠️ [QUEUE_MONITOR] Failed to get job state', { jobId, error: stateError });
        state = 'unknown';
      }

      logger.info('🔍 [QUEUE_MONITOR] Job Details', {
        id: job.id || jobId,
        state,
        testId: job.data?.testId,
        browser: job.data?.browser,
        intelligentMode: job.data?.intelligentMode,
        attempts: Number.isFinite(job.attemptsMade) ? job.attemptsMade : 0,
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
    // Validate inputs
    if (!jobId || typeof jobId !== 'string' || jobId.trim().length === 0) {
      logger.warn('⚠️ [QUEUE_MONITOR] Invalid jobId in monitorAfterJobAdd', { jobId });
      return;
    }

    if (!testId || typeof testId !== 'string' || testId.trim().length === 0) {
      logger.warn('⚠️ [QUEUE_MONITOR] Invalid testId in monitorAfterJobAdd', { testId });
      return;
    }

    logger.info('🔍 [QUEUE_MONITOR] Starting monitoring for job', { jobId, testId });

    // Подожди немного и проверь состояние
    // Use setTimeout with error handling for async callback
    setTimeout(async () => {
      try {
        await this.getQueueStatus();

        const jobInfo = await this.getJob(jobId);

        // Job might be in completed, failed, or delayed state, not just waiting/active
        if (!jobInfo) {
          // Try to check all states
          const waiting = await this.getWaitingJobs();
          const active = await this.getActiveJobs();
          const failed = await this.getFailedJobs();

          const jobInAnyState =
            waiting.some(j => j?.id === jobId) ||
            active.some(j => j?.id === jobId) ||
            failed.some(j => j?.id === jobId);

          if (!jobInAnyState) {
            logger.warn('⚠️ [QUEUE_MONITOR] Job not found in any state after 2s', {
              jobId,
              testId,
              note: 'Job may be completed, delayed, or removed',
            });
          }
        }
      } catch (error) {
        logger.error('❌ [QUEUE_MONITOR] Error in monitorAfterJobAdd callback', { error, jobId, testId });
      }
    }, 2000); // 2 секунды
  }

  /**
   * Периодический мониторинг очереди (для debugging)
   */
  static startPeriodicMonitoring(intervalMs: number = 10000) {
    // Validate and clamp interval
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
      logger.warn('⚠️ [QUEUE_MONITOR] Invalid intervalMs, using default', { intervalMs, default: 10000 });
      intervalMs = 10000;
    }
    // Clamp between 1 second and 5 minutes
    intervalMs = Math.max(1000, Math.min(intervalMs, 300000));

    logger.info('🔄 [QUEUE_MONITOR] Starting periodic monitoring', { intervalMs });

    return setInterval(async () => {
      try {
        const status = await this.getQueueStatus();

        if (status) {
          // Validate status properties
          const waiting = Number.isFinite(status.waiting) ? status.waiting : 0;
          const active = Number.isFinite(status.active) ? status.active : 0;
          const failed = Number.isFinite(status.failed) ? status.failed : 0;

          // Если есть waiting jobs, но нет active - что-то не так
          if (waiting > 0 && active === 0) {
            logger.warn('⚠️ [QUEUE_MONITOR] Jobs waiting but none active! Worker may be down.', {
              waiting,
              active,
              note: 'Check if workers are running',
            });
          }

          // Если много failed jobs
          if (failed > 5) {
            logger.warn('⚠️ [QUEUE_MONITOR] Many failed jobs detected!', { failed, threshold: 5 });
            await this.getFailedJobs();
          }
        }
      } catch (error) {
        logger.error('❌ [QUEUE_MONITOR] Error in periodic monitoring', { error });
        // Don't throw - keep monitoring even if one check fails
      }
    }, intervalMs);
  }

  /**
   * Остановить периодический мониторинг
   */
  static stopPeriodicMonitoring(intervalId: NodeJS.Timeout | null | undefined) {
    if (!intervalId) {
      logger.warn('⚠️ [QUEUE_MONITOR] Invalid intervalId in stopPeriodicMonitoring', { intervalId });
      return;
    }

    try {
      clearInterval(intervalId);
      logger.info('🛑 [QUEUE_MONITOR] Stopped periodic monitoring');
    } catch (error) {
      logger.error('❌ [QUEUE_MONITOR] Failed to stop periodic monitoring', { error, intervalId });
    }
  }
}
