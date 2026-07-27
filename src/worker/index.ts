// IMPORTANT: `../instrument` must load before any other import so Sentry can
// instrument http before it is required. Keep it first.
import '../instrument';
import * as Sentry from '@sentry/node';
import { VideoStreamRegistry } from '@/agent/playwright/artifacts/video-stream-registry';
import { createRunKey, TestRunRegistry } from '@/agent/playwright/core/test-run-registry';
import { env } from '@/config/environment/env';
import { connection, QUEUE_NAMES, testRunQueue } from '@/config/infrastructure/queues';
import { GitWebhookJobHandler } from '@/jobs/git-webhook.job';
import { AIAnalysisJobHandler, NotificationJobHandler, WebhookJobHandler } from '@/jobs/ai-analysis.job';
import { AllureImportJobHandler } from '@/jobs/allure-import.job';
import { AutoLearnJobHandler } from '@/jobs/auto-learn.job';
import { ExplorationRunJobHandler } from '@/jobs/exploration-run.job';
import { MobileExplorationRunJobHandler } from '@/jobs/mobile-exploration-run.job';
import { ManualTestResultJobHandler, ManualTestRunJobHandler } from '@/jobs/manual-test-run.job';
import { MobileTestRunJobHandler } from '@/jobs/mobile-test-run.job';
import { processNegativeGeneration } from '@/jobs/negative-generation.job';
import { RegressionDoctorJobHandler } from '@/jobs/regression-doctor.job';
import { VisualAnomalySweepJobHandler } from '@/jobs/visual-anomaly-sweep.job';
import { registerBuiltinResourceAdapters } from '@/services/test-resource';
import { StaleReaperService } from '@/services/testing/results/stale-reaper.service';
import { logger } from '@/utils/core/logger';
import { startLeaderElection, stopLeaderElection } from '@/scheduler/leader';
import { Worker } from 'bullmq';
import { queueMonitor } from './queue-monitor';

// NOTE: worker logs are intentionally NOT bridged into the API ring buffer.
// The worker is high-volume (queue ticks, RAM guard, job heartbeats, etc.)
// and would dominate the System Logs tab — operators read worker output via
// its own console/file transports instead.

// Resource adapters must be registered in EVERY process that applies a
// binding, and the worker is where background replay actually runs — the API
// only enqueues. Without this, `applyBindingsToContext` throws
// "No adapter registered for resource kind 'secret'" at SETUP, before the
// browser does anything, so a saved test carrying ANY binding (auth login,
// environment, secret, fixture) can never pass in a regression or scheduled
// run. Verified live 2026-07-27: a credential-bound login test failed with
// exactly that error while the same steps replayed fine in the editor.
// `src/index.ts` has always called this; the worker never did.
registerBuiltinResourceAdapters();

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
  maxStalledCount: 2, // Allow 1 stall recovery before permanent fail
};

// testRunWorker gets its own concurrency — starts at MIN, dynamically scaled by QueueMonitor
const testRunWorkerOptions = {
  ...workerOptions,
  concurrency: env.TEST_RUN_CONCURRENCY_MIN,
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
  testRunWorkerOptions
);

logger.info(`TestRun worker created successfully`);

// Start dynamic concurrency scaling for testRunWorker
if (env.SCALE_ENABLED) {
  queueMonitor.start(testRunWorker, testRunQueue);
}

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

// Visual anomaly sweep worker — ADR-0012. One job per test execution, same
// trigger shape as aiAnalysisWorker. See src/jobs/visual-anomaly-sweep.job.ts.
const visualAnomalySweepWorker = new Worker(
  QUEUE_NAMES.VISUAL_ANOMALY_SWEEP,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[VISUAL_ANOMALY_SWEEP_WORKER] Processing job: ${job.id}`, {
      testId: job.data?.testId,
      testResultId: job.data?.testResultId,
    });

    if (!VisualAnomalySweepJobHandler || typeof VisualAnomalySweepJobHandler.process !== 'function') {
      throw new Error('VisualAnomalySweepJobHandler.process is not a function');
    }

    return await VisualAnomalySweepJobHandler.process(job);
  },
  workerOptions
);

// Regression Doctor worker — one job per completed regression run. Reads
// every test_results.ai_summary under the run, groups drift patterns,
// runs an LLM analysis per group, persists findings. See
// src/jobs/regression-doctor.job.ts for the full pipeline.
const regressionDoctorWorker = new Worker(
  QUEUE_NAMES.REGRESSION_DOCTOR,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[REGRESSION_DOCTOR_WORKER] Processing job: ${job.id}`, {
      runId: job.data?.runId,
    });

    if (!RegressionDoctorJobHandler || typeof RegressionDoctorJobHandler.process !== 'function') {
      throw new Error('RegressionDoctorJobHandler.process is not a function');
    }

    return await RegressionDoctorJobHandler.process(job);
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

const explorationWorker = new Worker(
  QUEUE_NAMES.EXPLORATION,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    const startTime = Date.now();
    logger.info(`[EXPLORATION_WORKER] Processing job: ${job.id}`, {
      explorationId: job.data?.explorationId,
      entryUrl: job.data?.entryUrl,
    });

    try {
      if (!ExplorationRunJobHandler || typeof ExplorationRunJobHandler.process !== 'function') {
        throw new Error('ExplorationRunJobHandler.process is not a function');
      }

      await ExplorationRunJobHandler.process(job);
      const duration = Date.now() - startTime;

      logger.info(`[EXPLORATION_WORKER] Job completed: ${job.id}`, {
        explorationId: job.data?.explorationId,
        duration: `${duration}ms`,
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error(`[EXPLORATION_WORKER] Job failed: ${job.id}`, {
        explorationId: job.data?.explorationId,
        duration: `${duration}ms`,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
      });
      throw error;
    }
  },
  {
    ...workerOptions,
    concurrency: 2, // Exploration is heavy — browser + AI calls
    lockDuration: 20 * 60 * 1000, // 20 min — exploration can take 15 min
    stalledInterval: 5 * 60 * 1000, // 5 min
    maxStalledCount: 1, // Checkpoint/resume handles crash recovery; prevent duplicate concurrent runs
  }
);

// Mobile exploration worker — backend-brokered runner crawl (Stage 3).
// Holds a relay for the run's lifetime, so concurrency is capped low and
// the lock spans the whole crawl (mirrors the web exploration worker).
const mobileExplorationWorker = new Worker(
  QUEUE_NAMES.MOBILE_EXPLORATION,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }
    const startTime = Date.now();
    logger.info(`[MOBILE_EXPLORATION_WORKER] Processing job: ${job.id}`, {
      explorationId: job.data?.explorationId,
      appId: job.data?.appId,
      platform: job.data?.platform,
    });
    try {
      if (!MobileExplorationRunJobHandler || typeof MobileExplorationRunJobHandler.process !== 'function') {
        throw new Error('MobileExplorationRunJobHandler.process is not a function');
      }
      await MobileExplorationRunJobHandler.process(job);
      logger.info(`[MOBILE_EXPLORATION_WORKER] Job completed: ${job.id}`, {
        explorationId: job.data?.explorationId,
        duration: `${Date.now() - startTime}ms`,
      });
    } catch (error) {
      logger.error(`[MOBILE_EXPLORATION_WORKER] Job failed: ${job.id}`, {
        explorationId: job.data?.explorationId,
        duration: `${Date.now() - startTime}ms`,
        error: error instanceof Error ? { message: error.message, name: error.name, stack: error.stack } : String(error),
      });
      throw error;
    }
  },
  {
    ...workerOptions,
    concurrency: 2,
    lockDuration: 20 * 60 * 1000, // 20 min — crawl can run long
    stalledInterval: 5 * 60 * 1000,
    // No checkpoint/resume here (unlike web exploration): a stalled crawl
    // is marked failed, not retried — a re-run would start a fresh runner
    // session rather than resume.
    maxStalledCount: 1,
  },
);

// Mobile test run worker
const mobileTestRunWorker = new Worker(
  QUEUE_NAMES.MOBILE_TEST_RUN,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    const startTime = Date.now();
    logger.info(`[MOBILE_TEST_WORKER] Processing job: ${job.id}`, {
      testId: job.data?.testId,
      platform: job.data?.platform,
      browser: job.data?.browser,
    });

    try {
      if (!MobileTestRunJobHandler || typeof MobileTestRunJobHandler.process !== 'function') {
        throw new Error('MobileTestRunJobHandler.process is not a function');
      }

      await MobileTestRunJobHandler.process(job);
      const duration = Date.now() - startTime;

      logger.info(`[MOBILE_TEST_WORKER] Job completed: ${job.id}`, {
        testId: job.data?.testId,
        duration: `${duration}ms`,
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error(`[MOBILE_TEST_WORKER] Job failed: ${job.id}`, {
        testId: job.data?.testId,
        duration: `${duration}ms`,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
      });
      throw error;
    }
  },
  {
    ...workerOptions,
    // Mobile tests consume an emulator/simulator each — keep this at or
    // below the runner's pool size (POOL_ANDROID_SIZE + POOL_IOS_SIZE).
    // Higher values force cold-starts (~60s each) as the pool drains, which
    // ends up *slower* than sequential execution. Default 2 matches the
    // runner's default pool of 2 Android + 1 iOS with headroom for editor
    // sessions. Override with MOBILE_WORKER_CONCURRENCY only after bumping
    // the runner's pool size accordingly.
    concurrency: parseInt(process.env.MOBILE_WORKER_CONCURRENCY || '2', 10),
    lockDuration: 10 * 60 * 1000, // 10 min — mobile tests can be slow
    stalledInterval: 3 * 60 * 1000, // 3 min
    maxStalledCount: 1,
  }
);

// Allure import worker — one at a time (idempotency concern) with a long lock
const allureImportWorker = new Worker(
  QUEUE_NAMES.ALLURE_IMPORT,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[ALLURE_IMPORT_WORKER] Processing job: ${job.id}`, {
      importId: job.data?.importId,
      projectId: job.data?.projectId,
    });

    if (!AllureImportJobHandler || typeof AllureImportJobHandler.process !== 'function') {
      throw new Error('AllureImportJobHandler.process is not a function');
    }

    return await AllureImportJobHandler.process(job);
  },
  {
    ...workerOptions,
    concurrency: 1,                    // One import at a time — avoids DB overload
    lockDuration: 10 * 60 * 1000,     // 10 min lock (large imports can take time)
    stalledInterval: 5 * 60 * 1000,   // 5 min stall check
    maxStalledCount: 1,
  }
);

// Phase 5 — auto-learn worker. Lightweight: reads executed_steps, extracts
// facts, batch-embeds, upserts. No browser, no heavy I/O. Standard
// workerOptions (same concurrency as ai-analysis).
const autoLearnWorker = new Worker(
  QUEUE_NAMES.AUTO_LEARN,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[AUTO_LEARN_WORKER] Processing job: ${job.id}`, {
      testId: job.data?.testId,
      projectId: job.data?.projectId,
    });

    if (!AutoLearnJobHandler || typeof AutoLearnJobHandler.process !== 'function') {
      throw new Error('AutoLearnJobHandler.process is not a function');
    }

    return await AutoLearnJobHandler.process(job);
  },
  workerOptions
);

// Negative test generation worker
const negativeGenerationWorker = new Worker(
  QUEUE_NAMES.NEGATIVE_GENERATION,
  async (job) => {
    if (!job || !job.id) {
      throw new Error('Invalid job: missing id');
    }

    logger.info(`[NEGATIVE_GEN_WORKER] Processing job: ${job.id}`, {
      planId: job.data?.planId,
      testCaseCount: job.data?.testCaseIds?.length,
    });

    return await processNegativeGeneration(job);
  },
  {
    ...workerOptions,
    concurrency: 2, // AI generation — limited by API rate limits
    lockDuration: 5 * 60 * 1000, // 5 min
    stalledInterval: 2 * 60 * 1000, // 2 min
    maxStalledCount: 1,
  }
);

/**
 * Report a worker failure to Sentry with the ORIGINAL error object (so grouping
 * uses its real stack) plus structured tags/context for filtering by job type.
 * The logger→Sentry bridge (src/utils/core/logger.ts) deliberately SKIPS the
 * `job.failed` / `worker.error` events these carry, so this is the single
 * capture site for worker failures — no double-reporting. No-op when Sentry has
 * no DSN configured, and never throws (telemetry must not break the listener).
 */
const captureWorkerException = (
  err: unknown,
  context: Record<string, unknown>,
  level: Sentry.SeverityLevel = 'error'
): void => {
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    Sentry.withScope((scope) => {
      scope.setLevel(level);
      scope.setTag('process', 'worker');
      if (typeof context.event === 'string') scope.setTag('event', context.event);
      if (typeof context.jobName === 'string') scope.setTag('jobName', context.jobName);
      scope.setContext('job', context);
      Sentry.captureException(error);
    });
  } catch {
    // Telemetry must never break the failure listener.
  }
};

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
        event: 'job.failed',
        severity: 'error',
        jobName: workerName,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      captureWorkerException(err, { event: 'job.failed', jobName: workerName });
      return;
    }

    // Audit (Loki): a NON-final failure is a transient attempt BullMQ will retry
    // — emit it at warn as `job.retry` so a default "alert on job.failed/error"
    // fires only on TERMINAL failures (retry exhausted). This keeps the queryable
    // signal honest instead of paging on auto-recovered flaps.
    const maxAttempts = job.opts?.attempts ?? 1;
    const finalFailure = job.attemptsMade >= maxAttempts;
    const logFailure = finalFailure ? logger.error.bind(logger) : logger.warn.bind(logger);
    logFailure(`❌ [${workerName}] Job failed: ${job.id}`, {
      event: finalFailure ? 'job.failed' : 'job.retry',
      severity: finalFailure ? 'error' : 'warning',
      jobName: workerName,
      jobId: job.id,
      final: finalFailure,
      attemptsMade: job.attemptsMade,
      maxAttempts,
      userId: (job.data as { userId?: string } | undefined)?.userId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      jobData: job.data ? JSON.stringify(job.data).substring(0, 200) : 'N/A',
    });

    // Report TERMINAL failures to Sentry with rich, groupable context. Transient
    // retries (logged at warn as `job.retry`) are intentionally NOT reported.
    if (finalFailure) {
      captureWorkerException(err, {
        event: 'job.failed',
        jobName: workerName,
        jobId: String(job.id),
        attemptsMade: job.attemptsMade,
        maxAttempts,
        userId: (job.data as { userId?: string } | undefined)?.userId,
        testId: (job.data as { testId?: string } | undefined)?.testId,
      });
    }

    // Root-cause finalization: if a test-owning job dies without writing a
    // terminal status (process killed / stall-death), its own catch/finally
    // never ran — so the `tests` row would stay 'running' forever. Finalize it
    // here from the surviving worker. The guarded DB write makes this a no-op
    // for jobs that already finalized gracefully. Never throw out of the listener.
    const testId = (job.data as { testId?: string } | undefined)?.testId;
    if ((workerName === 'TestRun' || workerName === 'MobileTestRun') && testId) {
      StaleReaperService.handleAbandonedTest(
        testId,
        `Job failed: ${err instanceof Error ? err.message : 'worker died'}`,
      ).catch((e) => {
        logger.error(`❌ [${workerName}] handleAbandonedTest threw`, {
          testId,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }
  });

  worker.on('error', (err) => {
    logger.error(`❌ ${workerName} worker ERROR:`, {
      event: 'worker.error',
      severity: 'critical',
      jobName: workerName,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    captureWorkerException(err, { event: 'worker.error', jobName: workerName }, 'fatal');
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
setupWorkerEvents(visualAnomalySweepWorker, 'VisualAnomalySweep');
setupWorkerEvents(regressionDoctorWorker, 'RegressionDoctor');
setupWorkerEvents(notificationWorker, 'Notification');
setupWorkerEvents(webhookWorker, 'Webhook');
setupWorkerEvents(gitWebhookWorker, 'GitWebhook');
setupWorkerEvents(explorationWorker, 'Exploration');
setupWorkerEvents(mobileExplorationWorker, 'MobileExploration');
setupWorkerEvents(mobileTestRunWorker, 'MobileTestRun');
setupWorkerEvents(negativeGenerationWorker, 'NegativeGeneration');
setupWorkerEvents(allureImportWorker, 'AllureImport');
setupWorkerEvents(autoLearnWorker, 'AutoLearn');

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
    // Stop dynamic scaling monitor first
    queueMonitor.stop();

    // Release the scheduler leader lock + stop the sweep bundle (no-op if we
    // never held it / SCHEDULER_IN_WORKER is off) so a surviving replica takes
    // over immediately instead of waiting out the lock TTL.
    if (env.SCHEDULER_IN_WORKER) {
      await stopLeaderElection();
    }

    // Use Promise.allSettled to ensure all workers close even if one fails
    const closeResults = await Promise.allSettled([
      testRunWorker.close(),
      testResultWorker.close(),
      aiAnalysisWorker.close(),
      visualAnomalySweepWorker.close(),
      regressionDoctorWorker.close(),
      notificationWorker.close(),
      webhookWorker.close(),
      gitWebhookWorker.close(),
      explorationWorker.close(),
      mobileExplorationWorker.close(),
      mobileTestRunWorker.close(),
      negativeGenerationWorker.close(),
      allureImportWorker.close(),
      autoLearnWorker.close(),
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
        const workerNames = ['testRun', 'testResult', 'aiAnalysis', 'notification', 'webhook', 'gitWebhook', 'exploration', 'mobileTestRun', 'negativeGeneration', 'allureImport', 'testRunRegistry', 'videoStreams', 'browserPool'];
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
logger.info(`🏷️ Queue prefix: ${env.QUEUE_PREFIX}`);
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

// Host the scheduler bundle in the worker when enabled (prod). A Redis leader
// lock guarantees exactly one worker replica runs the sweeps even at N>1.
// Default OFF, so local docker-compose's dedicated scheduler container is
// unaffected. See src/scheduler/leader.ts.
if (env.SCHEDULER_IN_WORKER) {
  logger.info('[WORKER] SCHEDULER_IN_WORKER=true — hosting scheduler bundle (leader-locked)');
  startLeaderElection();
}

export {
  aiAnalysisWorker,
  allureImportWorker,
  autoLearnWorker,
  explorationWorker,
  gitWebhookWorker,
  mobileTestRunWorker,
  negativeGenerationWorker,
  notificationWorker,
  regressionDoctorWorker,
  testResultWorker,
  testRunWorker,
  visualAnomalySweepWorker,
  webhookWorker
};
