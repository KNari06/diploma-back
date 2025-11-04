import { env } from '@/config/env';
import { connection, QUEUE_NAMES } from '@/config/queues';
import { AIAnalysisJobHandler, NotificationJobHandler, WebhookJobHandler } from '@/jobs/ai-analysis.job';
import { ManualTestResultJobHandler, ManualTestRunJobHandler } from '@/jobs/manual-test-run.job';
import { logger } from '@/utils/logger';
import { Worker } from 'bullmq';

// Worker configuration
const workerOptions = {
  connection,
  concurrency: env.QUEUE_CONCURRENCY,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
  lockDuration: 300000, // 5 minutes - для долгих Playwright тестов
  stalledInterval: 60000, // 1 minute - проверка stalled jobs
  maxStalledCount: 2, // Максимум 2 stalled перед permanent fail
};

// Create workers for each queue
logger.info(`Creating TestRun worker for queue: ${QUEUE_NAMES.TEST_RUN}`);

const testRunWorker = new Worker(
  QUEUE_NAMES.TEST_RUN,
  async (job) => {
    // This should execute when job is picked up
    logger.info(`🎯 [CRITICAL] TestRun worker picked up job: ${job.id}`);

    try {
      logger.info(`[WRAPPER] Received job: ${job.id}`, {
        jobData: JSON.stringify(job.data).substring(0, 200),
      });
      logger.info(`Processing manual test run job: ${job.id}`);

      // Check if handler exists
      if (!ManualTestRunJobHandler || typeof ManualTestRunJobHandler.process !== 'function') {
        throw new Error('ManualTestRunJobHandler.process is not a function!');
      }

      const result = await ManualTestRunJobHandler.process(job);
      logger.info(`[WRAPPER] Job completed successfully: ${job.id}`);
      return result;
    } catch (error) {
      logger.error(`[WRAPPER] Job handler threw error: ${job.id}`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
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
    logger.info(`Processing manual test result job: ${job.id}`);
    return await ManualTestResultJobHandler.process(job);
  },
  workerOptions
);

const aiAnalysisWorker = new Worker(
  QUEUE_NAMES.AI_ANALYSIS,
  async (job) => {
    logger.info(`Processing AI analysis job: ${job.id}`);
    return await AIAnalysisJobHandler.process(job);
  },
  workerOptions
);

const notificationWorker = new Worker(
  QUEUE_NAMES.NOTIFICATION,
  async (job) => {
    logger.info(`Processing notification job: ${job.id}`);
    return await NotificationJobHandler.process(job);
  },
  workerOptions
);

const webhookWorker = new Worker(
  QUEUE_NAMES.WEBHOOK,
  async (job) => {
    logger.info(`Processing webhook job: ${job.id}`);
    return await WebhookJobHandler.process(job);
  },
  workerOptions
);

// Worker event listeners
const setupWorkerEvents = (worker: Worker, workerName: string) => {
  worker.on('ready', () => {
    logger.info(`✅ ${workerName} worker ready and waiting for jobs`);
  });

  worker.on('active', (job) => {
    logger.info(`🔄 ${workerName} worker ACTIVE (started processing): ${job.id}`);
  });

  worker.on('completed', (job, result) => {
    logger.info(`✅ ${workerName} worker completed job: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`❌ ${workerName} worker FAILED job: ${job?.id}`, {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      jobData: job?.data ? JSON.stringify(job.data).substring(0, 200) : 'N/A',
    });
  });

  worker.on('error', (err) => {
    logger.error(`❌ ${workerName} worker ERROR:`, {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });

  worker.on('stalled', (jobId) => {
    logger.warn(`⚠️ ${workerName} worker stalled job: ${jobId}`);
  });
};

// Setup event listeners for all workers
setupWorkerEvents(testRunWorker, 'TestRun');
setupWorkerEvents(testResultWorker, 'TestResult');
setupWorkerEvents(aiAnalysisWorker, 'AIAnalysis');
setupWorkerEvents(notificationWorker, 'Notification');
setupWorkerEvents(webhookWorker, 'Webhook');

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful worker shutdown...`);

  try {
    await Promise.all([
      testRunWorker.close(),
      testResultWorker.close(),
      aiAnalysisWorker.close(),
      notificationWorker.close(),
      webhookWorker.close(),
    ]);

    logger.info('All workers closed successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Error during worker shutdown:', error);
    process.exit(1);
  }
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('🚨 Uncaught exception in worker:', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  // Don't exit immediately - let it retry
  // process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('🚨 Unhandled rejection in worker:', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // Don't exit immediately - let it retry
  // process.exit(1);
});

logger.info('🚀 QAI Worker started');
logger.info(`📊 Concurrency: ${env.QUEUE_CONCURRENCY}`);
logger.info(`🔧 Environment: ${env.NODE_ENV}`);
logger.info(`🔌 Redis: ${env.REDIS_HOST}:${env.REDIS_PORT}`);
logger.info(`📋 Listening to queues: ${Object.values(QUEUE_NAMES).join(', ')}`);

// Test Redis connection
(async () => {
  try {
    const Redis = await import('ioredis');
    const testRedis = new Redis.default(connection as any);
    await testRedis.ping();
    logger.info('✅ Redis connection test PASSED');
    await testRedis.quit();
  } catch (error) {
    logger.error('❌ Redis connection test FAILED', error);
  }
})();

export {
  aiAnalysisWorker,
  notificationWorker, testResultWorker, testRunWorker, webhookWorker
};
