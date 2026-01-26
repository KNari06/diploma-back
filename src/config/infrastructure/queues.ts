import { AgentResponse, TestJobData } from '@/types';
import { handleQueueError } from '@/utils/core/error-handler';
import { logQueueEvent, logger } from '@/utils/core/logger';
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../environment/env';

// Helper to check if Redis is available
let redisAvailable = false;

// Validate required Redis configuration
if (!env.REDIS_HOST || !env.REDIS_PORT) {
  logger.error('❌ Missing required Redis configuration: REDIS_HOST and REDIS_PORT must be set');
  if (env.NODE_ENV === 'production') {
    throw new Error('Redis configuration is required in production');
  }
}

// Redis connection configuration
const redisConnection = new IORedis(env.REDIS_URL, {
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  connectTimeout: 10000, // 10 seconds
  retryStrategy: (times) => {
    if (times > 3) { // Reduced from 10 to 3
      logger.warn(`❌ Redis connection failed after ${times} retries. Stopping.`);
      return null; // Stop retrying
    }
    const delay = Math.min(times * 1000, 3000); // Max 3 seconds between retries
    logger.info(`⏳ Redis retry attempt ${times} in ${delay}ms...`);
    return delay;
  },
  lazyConnect: true, // Don't connect immediately
  reconnectOnError: null, // Don't auto-reconnect on specific errors
});

// Handle Redis connection errors gracefully
redisConnection.on('error', (error: any) => {
  if (error.code === 'ETIMEDOUT') {
    logger.warn('⏱️  Redis connection timeout - check if Redis server is accessible');
  } else if (error.code === 'ECONNREFUSED') {
    logger.warn('🚫 Redis connection refused - check if Redis is running');
  } else {
    logger.error('❌ Redis connection error:', error.message || error);
  }
});

redisConnection.on('connect', () => {
  redisAvailable = true;
  logger.info('✅ Redis connected successfully');
});

redisConnection.on('close', () => {
  redisAvailable = false;
  logger.warn('⚠️  Redis connection closed');
});

redisConnection.on('reconnecting', (delay: number) => {
  logger.info(`🔄 Reconnecting to Redis in ${delay}ms...`);
});

// Connect to Redis (with error handling)
redisConnection.connect()
  .catch((error) => {
    redisAvailable = false;
    logger.warn('Failed to connect to Redis:', error.message);
    if (env.NODE_ENV === 'development') {
      logger.warn('⚠️  Running in development mode without Redis. Queue functionality disabled.');
      logger.warn('💡 To enable queues: brew services start redis');
    } else {
      logger.warn('⚠️  Queue functionality will be limited. Make sure Redis is running.');
    }
  });

// Redis connection for BullMQ
// Note: BullMQ requires maxRetriesPerRequest to be null
export const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  connectTimeout: 10000, // 10 seconds timeout
  retryStrategy: (times: number) => {
    if (times > 3) {
      logger.error(`❌ BullMQ Redis connection failed after ${times} attempts`);
      return null; // Stop retrying
    }
    return Math.min(times * 1000, 3000);
  },
};

// Queue names
export const QUEUE_NAMES = {
  TEST_RUN: 'test-run',
  TEST_RESULT: 'test-result',
  AI_ANALYSIS: 'ai-analysis',
  NOTIFICATION: 'notification',
  WEBHOOK: 'webhook',
  GIT_WEBHOOK: 'git-webhook',
} as const;

// Test run queue - for executing tests
// ✅ FIX: Disable BullMQ auto-retry (attempts=1) because internal retry is handled by executePlaywrightTestWithRetry
// This prevents double-execution when post-processing fails after successful test completion
export const testRunQueue = new Queue<TestJobData>(QUEUE_NAMES.TEST_RUN, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 1, // No BullMQ retry - internal retry handled by agent
  },
});

// Test result queue - for processing test results
export const testResultQueue = new Queue<AgentResponse>(QUEUE_NAMES.TEST_RESULT, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
});

// AI analysis queue - for AI processing
export const aiAnalysisQueue = new Queue<{ testResultId: string; testId: string }>(QUEUE_NAMES.AI_ANALYSIS, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 25,
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});

// Notification queue - for sending notifications
export const notificationQueue = new Queue<{
  type: 'email' | 'slack' | 'webhook';
  recipient: string;
  subject: string;
  message: string;
  data?: any;
}>(QUEUE_NAMES.NOTIFICATION, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 25,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 3000,
    },
  },
});

// Webhook queue - for external integrations
export const webhookQueue = new Queue<{
  url: string;
  event: string;
  data: any;
  headers?: Record<string, string>;
}>(QUEUE_NAMES.WEBHOOK, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 25,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});

// Git webhook queue - for receiving Git provider webhooks (async processing)
export const gitWebhookQueue = new Queue<{
  provider: 'github' | 'gitlab';
  deliveryId: string;
}>(QUEUE_NAMES.GIT_WEBHOOK, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 200,
    removeOnFail: 100,
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});

// Queue events for monitoring
export const testRunQueueEvents = new QueueEvents(QUEUE_NAMES.TEST_RUN, { connection, prefix: env.QUEUE_PREFIX });
export const testResultQueueEvents = new QueueEvents(QUEUE_NAMES.TEST_RESULT, { connection, prefix: env.QUEUE_PREFIX });
export const aiAnalysisQueueEvents = new QueueEvents(QUEUE_NAMES.AI_ANALYSIS, { connection, prefix: env.QUEUE_PREFIX });

// Queue event listeners
testRunQueueEvents.on('completed', (args: { jobId: string; returnvalue: string; prev?: string }) => {
  logQueueEvent('completed', args.jobId, { queue: QUEUE_NAMES.TEST_RUN });
});

testRunQueueEvents.on('failed', (args: { jobId: string; failedReason: string; prev?: string }) => {
  logQueueEvent('failed', args.jobId, { queue: QUEUE_NAMES.TEST_RUN, error: args.failedReason });
});

testRunQueueEvents.on('stalled', (args: { jobId: string }) => {
  logQueueEvent('stalled', args.jobId, { queue: QUEUE_NAMES.TEST_RUN });
});

testResultQueueEvents.on('completed', (args: { jobId: string; returnvalue: string; prev?: string }) => {
  logQueueEvent('completed', args.jobId, { queue: QUEUE_NAMES.TEST_RESULT });
});

testResultQueueEvents.on('failed', (args: { jobId: string; failedReason: string; prev?: string }) => {
  logQueueEvent('failed', args.jobId, { queue: QUEUE_NAMES.TEST_RESULT, error: args.failedReason });
});

aiAnalysisQueueEvents.on('completed', (args: { jobId: string; returnvalue: string; prev?: string }) => {
  logQueueEvent('completed', args.jobId, { queue: QUEUE_NAMES.AI_ANALYSIS });
});

aiAnalysisQueueEvents.on('failed', (args: { jobId: string; failedReason: string; prev?: string }) => {
  logQueueEvent('failed', args.jobId, { queue: QUEUE_NAMES.AI_ANALYSIS, error: args.failedReason });
});

// Queue management functions
export class QueueManager {
  /**
   * Add test run job to queue
   */
  static async addTestRunJob(jobData: TestJobData, priority: number = 0) {
    try {
      // Check Redis availability before adding job
      if (!redisAvailable) {
        const error = new Error('Redis is not available. Cannot add job to queue.');
        logger.error('❌ [QUEUE] Redis unavailable', {
          testId: jobData.testId,
          browser: jobData.browser,
        });
        throw error;
      }

      logger.info('🔴 [QUEUE_DEBUG] Attempting to add job to queue', {
        testId: jobData.testId,
        browser: jobData.browser,
        intelligentMode: jobData.intelligentMode,
        redisAvailable,
        redisHost: connection.host,
        redisPort: connection.port,
      });

      const job = await testRunQueue.add('test-run', jobData, {
        priority,
        delay: 0,
        jobId: `${jobData.testId}-${jobData.browser}`,
      });

      logger.info('🟢 [QUEUE_DEBUG] Job added successfully to Redis', {
        jobId: job.id,
        testId: jobData.testId,
        queue: QUEUE_NAMES.TEST_RUN,
      });

      logQueueEvent('added', job.id!, { queue: QUEUE_NAMES.TEST_RUN, testId: jobData.testId });
      return job;
    } catch (error) {
      logger.error('❌ [QUEUE_DEBUG] Failed to add test run job', {
        error: error instanceof Error ? error.message : String(error),
        testId: jobData.testId,
        browser: jobData.browser,
      });
      throw handleQueueError(error);
    }
  }

  /**
   * Add test result processing job
   */
  static async addTestResultJob(jobData: AgentResponse) {
    try {
      const job = await testResultQueue.add('test-result', jobData, {
        priority: 10, // High priority for result processing
        jobId: `result-${jobData.testId}-${jobData.browser}`,
      });

      logQueueEvent('added', job.id!, { queue: QUEUE_NAMES.TEST_RESULT, testId: jobData.testId });
      return job;
    } catch (error) {
      logger.error('Failed to add test result job:', error);
      throw handleQueueError(error);
    }
  }

  /**
   * Add AI analysis job
   */
  static async addAIAnalysisJob(testResultId: string, testId: string) {
    try {
      const job = await aiAnalysisQueue.add('ai-analysis', { testResultId, testId }, {
        priority: 5,
        jobId: `ai-${testResultId}`,
      });

      logQueueEvent('added', job.id!, { queue: QUEUE_NAMES.AI_ANALYSIS, testResultId });
      return job;
    } catch (error) {
      logger.error('Failed to add AI analysis job:', error);
      throw handleQueueError(error);
    }
  }

  /**
   * Add notification job
   */
  static async addNotificationJob(notificationData: {
    type: 'email' | 'slack' | 'webhook';
    recipient: string;
    subject: string;
    message: string;
    data?: any;
  }) {
    try {
      const job = await notificationQueue.add('notification', notificationData, {
        priority: 1, // Lower priority for notifications
      });

      logQueueEvent('added', job.id!, { queue: QUEUE_NAMES.NOTIFICATION, type: notificationData.type });
      return job;
    } catch (error) {
      logger.error('Failed to add notification job:', error);
      throw handleQueueError(error);
    }
  }

  /**
   * Add webhook job
   */
  static async addWebhookJob(webhookData: {
    url: string;
    event: string;
    data: any;
    headers?: Record<string, string>;
  }) {
    try {
      const job = await webhookQueue.add('webhook', webhookData, {
        priority: 2,
      });

      logQueueEvent('added', job.id!, { queue: QUEUE_NAMES.WEBHOOK, event: webhookData.event });
      return job;
    } catch (error) {
      logger.error('Failed to add webhook job:', error);
      throw handleQueueError(error);
    }
  }

  /**
   * Add git webhook processing job
   */
  static async addGitWebhookJob(jobData: { provider: 'github' | 'gitlab'; deliveryId: string }) {
    try {
      const job = await gitWebhookQueue.add('git-webhook', jobData, {
        priority: 1,
        jobId: `${jobData.provider}:${jobData.deliveryId}`,
      });

      logQueueEvent('added', job.id!, { queue: QUEUE_NAMES.GIT_WEBHOOK, deliveryId: jobData.deliveryId });
      return job;
    } catch (error) {
      logger.error('Failed to add git webhook job:', error);
      throw handleQueueError(error);
    }
  }

  /**
   * Get queue statistics
   */
  static async getQueueStats() {
    try {
      // Use Promise.allSettled to handle individual queue failures gracefully
      const results = await Promise.allSettled([
        testRunQueue.getJobCounts(),
        testResultQueue.getJobCounts(),
        aiAnalysisQueue.getJobCounts(),
        notificationQueue.getJobCounts(),
        webhookQueue.getJobCounts(),
        gitWebhookQueue.getJobCounts(),
      ]);

      // Extract successful results, use empty object for failed ones
      const [testRunStats, testResultStats, aiAnalysisStats, notificationStats, webhookStats, gitWebhookStats] = results.map(
        (result) => result.status === 'fulfilled' ? result.value : {}
      );

      // Log any failures but don't fail the whole operation
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const queueNames = ['testRun', 'testResult', 'aiAnalysis', 'notification', 'webhook', 'gitWebhook'];
          logger.warn(`Failed to get stats for ${queueNames[index]} queue`, { error: result.reason });
        }
      });

      return {
        testRun: testRunStats,
        testResult: testResultStats,
        aiAnalysis: aiAnalysisStats,
        notification: notificationStats,
        webhook: webhookStats,
        gitWebhook: gitWebhookStats,
      };
    } catch (error) {
      logger.error('Failed to get queue stats:', error);
      throw handleQueueError(error);
    }
  }

  /**
   * Pause queue
   */
  static async pauseQueue(queueName: string) {
    try {
      const queue = this.getQueueByName(queueName);
      await queue.pause();
      logQueueEvent('paused', 'all', { queue: queueName });
    } catch (error) {
      logger.error(`Failed to pause queue ${queueName}:`, error);
      throw handleQueueError(error);
    }
  }

  /**
   * Resume queue
   */
  static async resumeQueue(queueName: string) {
    try {
      const queue = this.getQueueByName(queueName);
      await queue.resume();
      logQueueEvent('resumed', 'all', { queue: queueName });
    } catch (error) {
      logger.error(`Failed to resume queue ${queueName}:`, error);
      throw handleQueueError(error);
    }
  }

  /**
   * Clear queue
   */
  static async clearQueue(queueName: string) {
    try {
      const queue = this.getQueueByName(queueName);
      await queue.obliterate({ force: true });
      logQueueEvent('cleared', 'all', { queue: queueName });
    } catch (error) {
      logger.error(`Failed to clear queue ${queueName}:`, error);
      throw handleQueueError(error);
    }
  }

  /**
   * Get queue by name
   */
  private static getQueueByName(queueName: string) {
    switch (queueName) {
      case QUEUE_NAMES.TEST_RUN:
        return testRunQueue;
      case QUEUE_NAMES.TEST_RESULT:
        return testResultQueue;
      case QUEUE_NAMES.AI_ANALYSIS:
        return aiAnalysisQueue;
      case QUEUE_NAMES.NOTIFICATION:
        return notificationQueue;
      case QUEUE_NAMES.WEBHOOK:
        return webhookQueue;
      case QUEUE_NAMES.GIT_WEBHOOK:
        return gitWebhookQueue;
      default:
        throw new Error(`Unknown queue: ${queueName}`);
    }
  }

  /**
   * Health check for all queues
   */
  static async healthCheck() {
    try {
      // Check Redis availability first
      if (!redisAvailable) {
        return {
          status: 'unhealthy',
          error: 'Redis not available',
          timestamp: new Date().toISOString(),
        };
      }

      const stats = await this.getQueueStats();
      const totalJobs = Object.values(stats).reduce((sum, queueStats) =>
        sum + queueStats.waiting + queueStats.active + queueStats.completed + queueStats.failed, 0
      );

      return {
        status: 'healthy',
        queues: stats,
        totalJobs,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Queue health check failed:', error);
      return {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Check if Redis is available
   */
  static isRedisAvailable(): boolean {
    return redisAvailable;
  }
}

// Graceful shutdown with timeout
export const gracefulShutdown = async () => {
  logger.info('Shutting down queues...');

  const SHUTDOWN_TIMEOUT = 30000; // 30 seconds

  try {
    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Shutdown timeout after 30s')), SHUTDOWN_TIMEOUT);
    });

    // Shutdown logic
    const shutdownLogic = async () => {
      // Close all Queues
      const closeQueueResults = await Promise.allSettled([
        testRunQueue.close(),
        testResultQueue.close(),
        aiAnalysisQueue.close(),
        notificationQueue.close(),
        webhookQueue.close(),
        gitWebhookQueue.close(),
      ]);

      closeQueueResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const queueNames = ['testRun', 'testResult', 'aiAnalysis', 'notification', 'webhook', 'gitWebhook'];
          logger.warn(`Failed to close ${queueNames[index]} queue`, { error: result.reason });
        }
      });

      // Close all QueueEvents to prevent memory leaks
      const closeQueueEventsResults = await Promise.allSettled([
        testRunQueueEvents.close(),
        testResultQueueEvents.close(),
        aiAnalysisQueueEvents.close(),
      ]);

      closeQueueEventsResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const eventNames = ['testRunEvents', 'testResultEvents', 'aiAnalysisEvents'];
          logger.warn(`Failed to close ${eventNames[index]}`, { error: result.reason });
        }
      });

      // Close Redis connection
      try {
        await redisConnection.quit();
        logger.info('✅ Redis connection closed');
      } catch (redisError) {
        logger.warn('Failed to close Redis connection', { error: redisError });
      }
    };

    // Race between shutdown logic and timeout
    await Promise.race([shutdownLogic(), timeoutPromise]);

    logger.info('✅ Queues shut down completed');
  } catch (error) {
    if (error instanceof Error && error.message.includes('timeout')) {
      logger.error('❌ Queue shutdown timed out - forcing exit');
    } else {
      logger.error('❌ Error during queue shutdown:', error);
    }
  }
};

// Export all queues and utilities
export {
  redisConnection
};
