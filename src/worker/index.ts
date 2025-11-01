import { Worker } from 'bullmq';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { connection } from '@/config/queues';
import { ManualTestRunJobHandler, ManualTestResultJobHandler } from '@/jobs/manual-test-run.job';
import { AIAnalysisJobHandler, NotificationJobHandler, WebhookJobHandler } from '@/jobs/ai-analysis.job';
import { QUEUE_NAMES } from '@/config/queues';

// Worker configuration
const workerOptions = {
  connection,
  concurrency: env.QUEUE_CONCURRENCY,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

// Create workers for each queue
const testRunWorker = new Worker(
  QUEUE_NAMES.TEST_RUN,
  async (job) => {
    logger.info(`Processing manual test run job: ${job.id}`);
    return await ManualTestRunJobHandler.process(job);
  },
  workerOptions
);

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
    logger.info(`✅ ${workerName} worker ready`);
  });

  worker.on('active', (job) => {
    logger.info(`🔄 ${workerName} worker processing job: ${job.id}`);
  });

  worker.on('completed', (job, result) => {
    logger.info(`✅ ${workerName} worker completed job: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`❌ ${workerName} worker failed job: ${job?.id}`, err);
  });

  worker.on('error', (err) => {
    logger.error(`❌ ${workerName} worker error:`, err);
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
  logger.error('Uncaught exception in worker:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection in worker:', reason);
  process.exit(1);
});

logger.info('🚀 QAI Worker started');
logger.info(`📊 Concurrency: ${env.QUEUE_CONCURRENCY}`);
logger.info(`🔧 Environment: ${env.NODE_ENV}`);

export {
  testRunWorker,
  testResultWorker,
  aiAnalysisWorker,
  notificationWorker,
  webhookWorker,
};
