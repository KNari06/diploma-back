import { AgentResponse, TestJobData } from '@/types';
import type { ExplorationBudget, RateLimitingConfig } from '@/agent/core/lite/exploration/types';
import type { MobileTestJobData } from '@/services/mobile/mobile-runner.types';
import type { AllureImportJobData } from '@/services/allure-import/allure-import.types';
import { handleQueueError } from '@/utils/core/error-handler';
import { logQueueEvent, logger } from '@/utils/core/logger';
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../environment/env';

// ═══════════════════════════════════════════════════════════════════════
// EXPLORATION JOB DATA
// ═══════════════════════════════════════════════════════════════════════

export interface NegativeGenerationJobData {
  planId: string;
  userId: string;
  testCaseIds: string[];
}

export interface ExplorationJobData {
  explorationId: string;
  entryUrl: string;
  projectId: string;
  userId: string;
  chatSessionId?: string;
  workspaceId?: string;
  scopeHint?: string;
  credentials?: { email?: string; username?: string; phone?: string; password: string };
  budget?: Partial<ExplorationBudget>;
  maxConcurrency?: number;
  rateLimiting?: RateLimitingConfig;
}

// Helper to check if Redis is available
let redisAvailable = false;

// Validate required Redis configuration
if (!env.REDIS_HOST || !env.REDIS_PORT) {
  logger.error('❌ Missing required Redis configuration: REDIS_HOST and REDIS_PORT must be set');
  if (env.NODE_ENV === 'production') {
    throw new Error('Redis configuration is required in production');
  }
}

// ── Suppress ioredis "[WARN] password supplied but not required" spam ──
// ioredis prints one [WARN] per connection when a password is configured but
// the server has no AUTH requirement. We intercept those and emit one summary.
let _redisPasswordWarnCount = 0;
const _origConsoleWarn = console.warn;
console.warn = (...args: any[]) => {
  if (typeof args[0] === 'string' && args[0].includes('does not require a password')) {
    _redisPasswordWarnCount++;
    return; // swallow
  }
  _origConsoleWarn.apply(console, args);
};
// After event loop settles (all connections opened), emit one summary and restore
setTimeout(() => {
  console.warn = _origConsoleWarn;
  if (_redisPasswordWarnCount > 0) {
    logger.warn(`Redis server does not require a password, but REDIS_PASSWORD is set (${_redisPasswordWarnCount} connections). Consider removing it from .env for local dev.`);
  }
}, 5000);

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
  EXPLORATION: 'exploration',
  MOBILE_TEST_RUN: 'mobile-test-run',
  NEGATIVE_GENERATION: 'negative-generation',
  ALLURE_IMPORT: 'allure-import',
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

// Exploration queue - for autonomous site exploration
export const explorationQueue = new Queue<ExplorationJobData>(QUEUE_NAMES.EXPLORATION, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 25,
    attempts: 2, // Allow 1 automatic retry on stall — resumes from checkpoint
    backoff: {
      type: 'fixed',
      delay: 5000,
    },
  },
});

// Mobile test run queue - for mobile device test execution
export const mobileTestRunQueue = new Queue<MobileTestJobData>(QUEUE_NAMES.MOBILE_TEST_RUN, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 25,
    attempts: 1, // No auto-retry — mobile runner handles step-level failures
  },
});

// Allure import queue — async processing of large Allure ZIP imports
export const allureImportQueue = new Queue<AllureImportJobData>(QUEUE_NAMES.ALLURE_IMPORT, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 20,
    removeOnFail: 10,
    attempts: 1, // No retry — import is not idempotent; partial state could exist
  },
});

// Negative test generation queue — AI generates boundary/negative test cases
export const negativeGenerationQueue = new Queue<NegativeGenerationJobData>(QUEUE_NAMES.NEGATIVE_GENERATION, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 25,
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 3000,
    },
  },
});

// Queue events for monitoring
export const allureImportQueueEvents = new QueueEvents(QUEUE_NAMES.ALLURE_IMPORT, { connection, prefix: env.QUEUE_PREFIX });
export const negativeGenerationQueueEvents = new QueueEvents(QUEUE_NAMES.NEGATIVE_GENERATION, { connection, prefix: env.QUEUE_PREFIX });
export const testRunQueueEvents = new QueueEvents(QUEUE_NAMES.TEST_RUN, { connection, prefix: env.QUEUE_PREFIX });
export const testResultQueueEvents = new QueueEvents(QUEUE_NAMES.TEST_RESULT, { connection, prefix: env.QUEUE_PREFIX });
export const aiAnalysisQueueEvents = new QueueEvents(QUEUE_NAMES.AI_ANALYSIS, { connection, prefix: env.QUEUE_PREFIX });
export const explorationQueueEvents = new QueueEvents(QUEUE_NAMES.EXPLORATION, { connection, prefix: env.QUEUE_PREFIX });
export const mobileTestRunQueueEvents = new QueueEvents(QUEUE_NAMES.MOBILE_TEST_RUN, { connection, prefix: env.QUEUE_PREFIX });

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

explorationQueueEvents.on('completed', (args: { jobId: string; returnvalue: string; prev?: string }) => {
  logQueueEvent('completed', args.jobId, { queue: QUEUE_NAMES.EXPLORATION });
});

explorationQueueEvents.on('failed', (args: { jobId: string; failedReason: string; prev?: string }) => {
  logQueueEvent('failed', args.jobId, { queue: QUEUE_NAMES.EXPLORATION, error: args.failedReason });
});

explorationQueueEvents.on('stalled', (args: { jobId: string }) => {
  logQueueEvent('stalled', args.jobId, { queue: QUEUE_NAMES.EXPLORATION });
});

mobileTestRunQueueEvents.on('completed', (args: { jobId: string; returnvalue: string; prev?: string }) => {
  logQueueEvent('completed', args.jobId, { queue: QUEUE_NAMES.MOBILE_TEST_RUN });
});

mobileTestRunQueueEvents.on('failed', (args: { jobId: string; failedReason: string; prev?: string }) => {
  logQueueEvent('failed', args.jobId, { queue: QUEUE_NAMES.MOBILE_TEST_RUN, error: args.failedReason });
});

mobileTestRunQueueEvents.on('stalled', (args: { jobId: string }) => {
  logQueueEvent('stalled', args.jobId, { queue: QUEUE_NAMES.MOBILE_TEST_RUN });
});

negativeGenerationQueueEvents.on('completed', (args: { jobId: string; returnvalue: string; prev?: string }) => {
  logQueueEvent('completed', args.jobId, { queue: QUEUE_NAMES.NEGATIVE_GENERATION });
});

negativeGenerationQueueEvents.on('failed', (args: { jobId: string; failedReason: string; prev?: string }) => {
  logQueueEvent('failed', args.jobId, { queue: QUEUE_NAMES.NEGATIVE_GENERATION, error: args.failedReason });
});

allureImportQueueEvents.on('completed', (args: { jobId: string; returnvalue: string; prev?: string }) => {
  logQueueEvent('completed', args.jobId, { queue: QUEUE_NAMES.ALLURE_IMPORT });
});

allureImportQueueEvents.on('failed', (args: { jobId: string; failedReason: string; prev?: string }) => {
  logQueueEvent('failed', args.jobId, { queue: QUEUE_NAMES.ALLURE_IMPORT, error: args.failedReason });
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
   * Add git webhook processing job (optional integrationId: when set, one delivery can trigger multiple jobs, one per integration).
   */
  static async addGitWebhookJob(jobData: {
    provider: 'github' | 'gitlab';
    deliveryId: string;
    integrationId?: string;
  }) {
    try {
      const jobId = jobData.integrationId
        ? `${jobData.provider}:${jobData.deliveryId}:${jobData.integrationId}`
        : `${jobData.provider}:${jobData.deliveryId}`;
      const job = await gitWebhookQueue.add('git-webhook', jobData, {
        priority: 1,
        jobId,
      });

      logQueueEvent('added', job.id!, { queue: QUEUE_NAMES.GIT_WEBHOOK, deliveryId: jobData.deliveryId, integrationId: jobData.integrationId });
      return job;
    } catch (error) {
      logger.error('Failed to add git webhook job:', error);
      throw handleQueueError(error);
    }
  }

  /**
   * Add exploration job to queue
   */
  static async addExplorationJob(jobData: ExplorationJobData) {
    try {
      if (!redisAvailable) {
        const error = new Error('Redis is not available. Cannot add exploration job to queue.');
        logger.error('❌ [QUEUE] Redis unavailable for exploration', {
          explorationId: jobData.explorationId,
        });
        throw error;
      }

      const job = await explorationQueue.add('exploration', jobData, {
        priority: 5,
        jobId: jobData.explorationId,
      });

      logQueueEvent('added', job.id!, { queue: QUEUE_NAMES.EXPLORATION, explorationId: jobData.explorationId });
      return job;
    } catch (error) {
      logger.error('❌ Failed to add exploration job', {
        error: error instanceof Error ? error.message : String(error),
        explorationId: jobData.explorationId,
      });
      throw handleQueueError(error);
    }
  }

  /**
   * Add mobile test run job to queue with fair priority.
   *
   * Priority 1 (highest) → 10 (lowest).
   * Users with fewer pending jobs get higher priority — prevents
   * one user's 200-job regression from starving everyone else.
   * Uses Redis INCR/DECR counter (O(1)) instead of scanning the wait list.
   */
  static async addMobileTestRunJob(jobData: MobileTestJobData) {
    try {
      if (!redisAvailable) {
        throw new Error('Redis is not available. Cannot add mobile test job to queue.');
      }

      const priority = await this.calculateMobileFairPriority(jobData.userId);

      const job = await mobileTestRunQueue.add('mobile-test-run', jobData, {
        priority,
        jobId: `${jobData.testId}-${jobData.browser}`,
      });

      // Increment pending counter for this user (non-fatal if fails)
      try {
        const redis = await mobileTestRunQueue.client;
        const key = `${env.QUEUE_PREFIX}mobile:pending:${jobData.userId}`;
        await redis.incr(key);
        await redis.expire(key, 3600); // 1 hour TTL safety net
      } catch { /* non-fatal */ }

      logQueueEvent('added', job.id!, {
        queue: QUEUE_NAMES.MOBILE_TEST_RUN,
        testId: jobData.testId,
        platform: jobData.platform,
        priority,
      });
      return job;
    } catch (error) {
      logger.error('Failed to add mobile test run job', {
        error: error instanceof Error ? error.message : String(error),
        testId: jobData.testId,
        platform: jobData.platform,
      });
      throw handleQueueError(error);
    }
  }

  /**
   * Decrement the mobile pending counter for a user.
   * Call this after a mobile test job completes or fails.
   */
  static async decrementMobilePendingCount(userId: string): Promise<void> {
    try {
      if (!redisAvailable) return;
      const redis = await mobileTestRunQueue.client;
      const key = `${env.QUEUE_PREFIX}mobile:pending:${userId}`;
      const val = await redis.decr(key);
      if (val <= 0) await redis.del(key); // Clean up zero/negative
    } catch { /* non-fatal */ }
  }

  /**
   * Fair priority for mobile test jobs.
   * O(1) Redis lookup — reads user's pending job counter.
   */
  private static async calculateMobileFairPriority(userId: string): Promise<number> {
    try {
      const redis = await mobileTestRunQueue.client;
      const key = `${env.QUEUE_PREFIX}mobile:pending:${userId}`;
      const count = parseInt(await redis.get(key) || '0', 10);

      // 0 pending → priority 1 (highest)
      // 1-2 pending → priority 3
      // 3-5 pending → priority 5
      // 6-9 pending → priority 7
      // 10+ pending → priority 10 (lowest)
      if (count === 0) return 1;
      if (count <= 2) return 3;
      if (count <= 5) return 5;
      if (count <= 9) return 7;
      return 10;
    } catch {
      return 5; // Fallback to neutral priority
    }
  }

  /**
   * Add Allure ZIP import job to queue.
   * The ZIP is pre-encoded as base64 so it can be serialised into Redis.
   */
  static async addAllureImportJob(jobData: AllureImportJobData) {
    try {
      if (!redisAvailable) {
        throw new Error('Redis is not available. Cannot add Allure import job to queue.');
      }

      const job = await allureImportQueue.add('allure-import', jobData, {
        jobId: jobData.importId, // Idempotent — re-adding same importId is a no-op
      });

      logQueueEvent('added', job.id!, {
        queue: QUEUE_NAMES.ALLURE_IMPORT,
        importId: jobData.importId,
        projectId: jobData.projectId,
      });
      return job;
    } catch (error) {
      logger.error('Failed to add Allure import job', {
        error: error instanceof Error ? error.message : String(error),
        importId: jobData.importId,
      });
      throw handleQueueError(error);
    }
  }

  /**
   * Add negative generation job to queue
   */
  static async addNegativeGenerationJob(jobData: NegativeGenerationJobData) {
    try {
      if (!redisAvailable) {
        throw new Error('Redis is not available. Cannot add negative generation job to queue.');
      }

      const job = await negativeGenerationQueue.add('negative-generation', jobData, {
        priority: 10, // Lower priority than test runs
        jobId: `neg-gen-${jobData.planId}-${Date.now()}`,
      });

      logQueueEvent('added', job.id!, {
        queue: QUEUE_NAMES.NEGATIVE_GENERATION,
        planId: jobData.planId,
        testCaseCount: jobData.testCaseIds.length,
      });
      return job;
    } catch (error) {
      logger.error('Failed to add negative generation job', {
        error: error instanceof Error ? error.message : String(error),
        planId: jobData.planId,
      });
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
        explorationQueue.getJobCounts(),
        mobileTestRunQueue.getJobCounts(),
        allureImportQueue.getJobCounts(),
      ]);

      // Extract successful results, use empty object for failed ones
      const [testRunStats, testResultStats, aiAnalysisStats, notificationStats, webhookStats, gitWebhookStats, explorationStats, mobileTestRunStats, allureImportStats] = results.map(
        (result) => result.status === 'fulfilled' ? result.value : {}
      );

      // Log any failures but don't fail the whole operation
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const queueNames = ['testRun', 'testResult', 'aiAnalysis', 'notification', 'webhook', 'gitWebhook', 'exploration', 'mobileTestRun', 'allureImport'];
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
        exploration: explorationStats,
        mobileTestRun: mobileTestRunStats,
        allureImport: allureImportStats,
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
      case QUEUE_NAMES.EXPLORATION:
        return explorationQueue;
      case QUEUE_NAMES.MOBILE_TEST_RUN:
        return mobileTestRunQueue;
      case QUEUE_NAMES.NEGATIVE_GENERATION:
        return negativeGenerationQueue;
      case QUEUE_NAMES.ALLURE_IMPORT:
        return allureImportQueue;
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
        explorationQueue.close(),
        mobileTestRunQueue.close(),
        negativeGenerationQueue.close(),
        allureImportQueue.close(),
      ]);

      closeQueueResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const queueNames = ['testRun', 'testResult', 'aiAnalysis', 'notification', 'webhook', 'gitWebhook', 'exploration', 'mobileTestRun', 'negativeGeneration', 'allureImport'];
          logger.warn(`Failed to close ${queueNames[index]} queue`, { error: result.reason });
        }
      });

      // Close all QueueEvents to prevent memory leaks
      const closeQueueEventsResults = await Promise.allSettled([
        testRunQueueEvents.close(),
        testResultQueueEvents.close(),
        aiAnalysisQueueEvents.close(),
        explorationQueueEvents.close(),
        mobileTestRunQueueEvents.close(),
        negativeGenerationQueueEvents.close(),
        allureImportQueueEvents.close(),
      ]);

      closeQueueEventsResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const eventNames = ['testRunEvents', 'testResultEvents', 'aiAnalysisEvents', 'explorationEvents', 'mobileTestRunEvents', 'negativeGenerationEvents', 'allureImportEvents'];
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
