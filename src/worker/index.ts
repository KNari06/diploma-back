import { VideoStreamRegistry } from '@/agent/playwright/artifacts/video-stream-registry';
import { createRunKey, TestRunRegistry } from '@/agent/playwright/core/test-run-registry';
import { env } from '@/config/environment/env';
import { connection, QUEUE_NAMES, testRunQueue } from '@/config/infrastructure/queues';
import { GitWebhookJobHandler } from '@/jobs/git-webhook.job';
import { AIAnalysisJobHandler, NotificationJobHandler, WebhookJobHandler } from '@/jobs/ai-analysis.job';
import { ManualTestResultJobHandler, ManualTestRunJobHandler } from '@/jobs/manual-test-run.job';
import { logger } from '@/utils/core/logger';
import { Worker } from 'bullmq';

// Validate worker configuration
const getValidatedConcurrency = (): number => {
  if (!connection || typeof connection !== 'object') {
    throw new Error('Invalid Redis connection configuration');
  }

  if (!Number.isFinite(env.QUEUE_CONCURRENCY) || env.QUEUE_CONCURRENCY < 1 || env.QUEUE_CONCURRENCY > 100) {
    logger.warn('[WORKER] Invalid QUEUE_CONCURRENCY, using default: 5', {
      provided: env.QUEUE_CONCURRENCY,
      default: 5,
    });
    return 5;
  }

  return Math.floor(env.QUEUE_CONCURRENCY);
};

const queueConcurrency = Math.max(1, Math.min(100, getValidatedConcurrency())); // Clamp between 1-100

// Worker configuration
// ✅ FIX: Increased lockDuration to 6 minutes (> Lite timeout of 5 min) to prevent false stalled detection
const workerOptions = {
  connection,
  prefix: env.QUEUE_PREFIX,
  concurrency: queueConcurrency,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
  lockDuration: 301000, // ~5 minutes - must exceed Lite Engine timeout (5 min) to prevent stalled restart
  stalledInterval: 90000, // 1.5 minutes - stalled jobs check (increased to reduce false positives)
  maxStalledCount: 1, // Max 1 stalled before permanent fail (reduced since we disabled BullMQ retry)
};

// Create workers for each queue
logger.info(`Creating TestRun worker for queue: ${QUEUE_NAMES.TEST_RUN}`);

const testRunWorker = new Worker(
  QUEUE_NAMES.TEST_RUN,
  async (job) => {
    // Validate job
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    const startTime = Date.now();
    logger.info(`[TEST_RUN_WORKER] 🔄 Processing job: ${job.id}`, {
      testId: job.data?.testId,
      url: job.data?.url,
      browser: job.data?.browser,
      intelligentMode: job.data?.intelligentMode,
      retryCount: job.data?.retryCount || 0,
      jobAttempts: job.attemptsMade,
    });

    try {
      // Validate handler exists
      if (!ManualTestRunJobHandler || typeof ManualTestRunJobHandler.process !== 'function') {
        throw new Error('ManualTestRunJobHandler.process is not a function');
      }

      const result = await ManualTestRunJobHandler.process(job);
      const duration = Date.now() - startTime;

      logger.info(`[TEST_RUN_WORKER] ✅ Job completed successfully: ${job.id}`, {
        testId: job.data?.testId,
        browser: job.data?.browser,
        duration: `${duration}ms`,
        attemptsMade: job.attemptsMade,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // ✅ FIX: Enhanced error logging with full context
      logger.error(`[TEST_RUN_WORKER] ❌ Job failed: ${job.id}`, {
        testId: job.data?.testId,
        url: job.data?.url,
        browser: job.data?.browser,
        intelligentMode: job.data?.intelligentMode,
        retryCount: job.data?.retryCount || 0,
        jobAttempts: job.attemptsMade,
        duration: `${duration}ms`,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
        jobData: job.data ? JSON.stringify(job.data).substring(0, 200) : 'N/A',
      });
      throw error;
    }
  },
  workerOptions
);

logger.info(`TestRun worker created successfully`);

const testResultWorker = new Worker(
  QUEUE_NAMES.TEST_RESULT,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[TEST_RESULT_WORKER] Processing job: ${job.id}`);

    if (!ManualTestResultJobHandler || typeof ManualTestResultJobHandler.process !== 'function') {
      throw new Error('ManualTestResultJobHandler.process is not a function');
    }

    return await ManualTestResultJobHandler.process(job);
  },
  workerOptions
);

const aiAnalysisWorker = new Worker(
  QUEUE_NAMES.AI_ANALYSIS,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[AI_ANALYSIS_WORKER] Processing job: ${job.id}`, {
      testId: job.data?.testId,
      testResultId: job.data?.testResultId ?? job.data?.resultId,
    });

    if (!AIAnalysisJobHandler || typeof AIAnalysisJobHandler.process !== 'function') {
      throw new Error('AIAnalysisJobHandler.process is not a function');
    }

    return await AIAnalysisJobHandler.process(job);
  },
  workerOptions
);

const notificationWorker = new Worker(
  QUEUE_NAMES.NOTIFICATION,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[NOTIFICATION_WORKER] Processing job: ${job.id}`);

    if (!NotificationJobHandler || typeof NotificationJobHandler.process !== 'function') {
      throw new Error('NotificationJobHandler.process is not a function');
    }

    return await NotificationJobHandler.process(job);
  },
  workerOptions
);

const webhookWorker = new Worker(
  QUEUE_NAMES.WEBHOOK,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[WEBHOOK_WORKER] Processing job: ${job.id}`, {
      url: job.data?.url,
      event: job.data?.event,
    });

    if (!WebhookJobHandler || typeof WebhookJobHandler.process !== 'function') {
      throw new Error('WebhookJobHandler.process is not a function');
    }

    return await WebhookJobHandler.process(job);
  },
  workerOptions
);

const gitWebhookWorker = new Worker(
  QUEUE_NAMES.GIT_WEBHOOK,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[GIT_WEBHOOK_WORKER] Processing job: ${job.id}`, {
      provider: job.data?.provider,
      deliveryId: job.data?.deliveryId,
    });

    if (!GitWebhookJobHandler || typeof GitWebhookJobHandler.process !== 'function') {
      throw new Error('GitWebhookJobHandler.process is not a function');
    }

    return await GitWebhookJobHandler.process(job as any);
  },
  workerOptions
);

// Worker event listeners
const setupWorkerEvents = (worker: Worker, workerName: string) => {
  worker.on('ready', () => {
    logger.info(`✅ ${workerName} worker ready and waiting for jobs`);
  });

  worker.on('active', (job) => {
    if (!job || !job.id) {
      logger.warn(`[${workerName}] Received invalid job in 'active' event`);
      return;
    }

    logger.info(`🔄 [${workerName}] Job started: ${job.id}`, {
      testId: job.data?.testId,
      intelligentMode: job.data?.intelligentMode,
    });
  });

  worker.on('completed', (job) => {
    if (!job || !job.id) {
      logger.warn(`[${workerName}] Received invalid job in 'completed' event`);
      return;
    }
    logger.info(`✅ ${workerName} worker completed job: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    if (!job) {
      logger.error(`❌ [${workerName}] Job failed but job is null/undefined`, {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return;
    }

    logger.error(`❌ [${workerName}] Job failed: ${job.id}`, {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      attemptsMade: job.attemptsMade,
      jobData: job.data ? JSON.stringify(job.data).substring(0, 200) : 'N/A',
    });
  });

  worker.on('error', (err) => {
    logger.error(`❌ ${workerName} worker ERROR:`, {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });

  worker.on('stalled', async (jobId) => {
    logger.warn(`⚠️ ${workerName} worker stalled job: ${jobId}`);

    // Only abort the specific stalled test run, not all runs
    if (workerName === 'TestRun') {
      try {
        // Get the job to extract testId and browser
        const job = await testRunQueue.getJob(jobId);
        if (job && job.data) {
          const { testId, browser } = job.data as { testId?: string; browser?: string };

          if (testId && browser) {
            const runKey = createRunKey(testId, browser);

            logger.warn('[WORKER] Aborting only stalled test run', {
              jobId,
              testId,
              browser,
              runKey,
            });

            // Abort only the stalled run
            await TestRunRegistry.abortRun(runKey, 'error', 0);

            // Stop video stream for this run only
            await VideoStreamRegistry.stopByRunKey(runKey, 'error');

            logger.info('[WORKER] Stalled test run aborted', {
              jobId,
              testId,
              browser,
              runKey,
            });
          } else if (testId) {
            // Fallback: if browser is missing, abort by testId
            logger.warn('[WORKER] Aborting stalled test by testId (browser unknown)', {
              jobId,
              testId,
            });
            await TestRunRegistry.abortByTestId(testId, 'error', 0);
            await VideoStreamRegistry.stopByTestId(testId, 'error');
          } else {
            logger.warn('[WORKER] Stalled job missing testId, cannot abort specific run', {
              jobId,
              jobData: JSON.stringify(job.data).substring(0, 200),
            });
          }
        } else {
          logger.warn('[WORKER] Could not retrieve stalled job data', {
            jobId,
            hasJob: !!job,
          });
        }
      } catch (error) {
        logger.error('[WORKER] Error handling stalled job', {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
};

// Setup event listeners for all workers
setupWorkerEvents(testRunWorker, 'TestRun');
setupWorkerEvents(testResultWorker, 'TestResult');
setupWorkerEvents(aiAnalysisWorker, 'AIAnalysis');
setupWorkerEvents(notificationWorker, 'Notification');
setupWorkerEvents(webhookWorker, 'Webhook');
setupWorkerEvents(gitWebhookWorker, 'GitWebhook');

// Graceful shutdown
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  // Prevent multiple shutdown attempts
  if (isShuttingDown) {
    logger.warn(`[WORKER] Shutdown already in progress, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  logger.info(`[WORKER] Received ${signal}. Starting graceful shutdown...`);

  const SHUTDOWN_TIMEOUT = 30000; // 30 seconds
  const shutdownTimeout = setTimeout(() => {
    logger.error('[WORKER] Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  try {
    // Use Promise.allSettled to ensure all workers close even if one fails
    const closeResults = await Promise.allSettled([
      testRunWorker.close(),
      testResultWorker.close(),
      aiAnalysisWorker.close(),
      notificationWorker.close(),
      webhookWorker.close(),
      gitWebhookWorker.close(),
      // Abort all active test runs (closes contexts, stops video streams)
      (async () => {
        try {
          const activeRuns = TestRunRegistry.getCount();
          if (activeRuns > 0) {
            logger.info('[WORKER] Aborting test runs', { activeRuns });
            await TestRunRegistry.abortAll('shutdown');
          }
        } catch (error) {
          logger.error('[WORKER] Failed to abort test runs', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
      // Stop any remaining video streams (as backup)
      (async () => {
        try {
          const activeStreams = VideoStreamRegistry.getCount();
          if (activeStreams > 0) {
            logger.info('[WORKER] Stopping remaining video streams', { activeStreams });
            await VideoStreamRegistry.stopAll('shutdown');
          }
        } catch (error) {
          logger.error('[WORKER] Failed to stop video streams', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
      // Close all browsers to free server resources
      (async () => {
        try {
          const { browserPool } = await import('@/agent');
          await browserPool.closeAll();
          logger.info('[WORKER] All browsers closed');
        } catch (error) {
          logger.error('[WORKER] Failed to close browsers', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
    ]);

    // Log any failures but continue shutdown
    closeResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const workerNames = ['testRun', 'testResult', 'aiAnalysis', 'notification', 'webhook', 'testRunRegistry', 'videoStreams', 'browserPool'];
        logger.warn(`[WORKER] Failed to close ${workerNames[index]}`, {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });

    clearTimeout(shutdownTimeout);
    logger.info('[WORKER] Worker shutdown completed');
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logger.error('[WORKER] Error during worker shutdown:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Note: process-level handlers are registered in `src/utils/logger.ts`.
// Duplicating them here can cause double-logging and, in worst cases, JSON serialization crashes.

logger.info('🚀 QAIT Worker started');
logger.info(`📊 Concurrency: ${queueConcurrency}`);
logger.info(`🔧 Environment: ${env.NODE_ENV}`);
logger.info(`🔌 Redis: ${env.REDIS_HOST}:${env.REDIS_PORT}`);
logger.info(`📋 Listening to queues: ${Object.values(QUEUE_NAMES).join(', ')}`);

// Test Redis connection
(async () => {
  try {
    const Redis = await import('ioredis');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const testRedis = new Redis.default(connection as any);

    // Test with timeout
    const pingPromise = testRedis.ping();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Redis ping timeout')), 5000)
    );

    await Promise.race([pingPromise, timeoutPromise]);
    logger.info('[WORKER] ✅ Redis connection test PASSED');
    await testRedis.quit();
  } catch (error) {
    logger.error('[WORKER] ❌ Redis connection test FAILED', {
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    // Don't exit - workers will fail gracefully if Redis is unavailable
  }
})();

export {
  aiAnalysisWorker,
  gitWebhookWorker,
  notificationWorker,
  testResultWorker,
  testRunWorker,
  webhookWorker
};
