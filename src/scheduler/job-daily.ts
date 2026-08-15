/**
 * Daily Scheduler tasks — Cloud Run Job entry point.
 *
 * Run-to-completion: Cloud Scheduler invokes this Job once a day (03:00 UTC).
 * Runs the two 24h-cadence sweeps that used to live in the persistent scheduler
 * process. No HTTP listener (Cloud Run Job).
 *
 * Each tick() is wrapped independently so one failing does not skip the other,
 * and a single failure still marks the execution non-zero (alert signal).
 *
 * The persistent `src/scheduler/index.ts` is kept for local dev (docker-compose).
 */

import { initLogBridge } from '@/utils/core/log-bridge';
import { AutoLearnRetireJob } from '@/jobs/auto-learn-retire.job';
import { AccountDeletionPurgeJob } from '@/jobs/account-deletion-purge.job';
import { AiCallLogsRetentionJob } from '@/jobs/ai-call-logs-retention.job';
import { ExpiringPlansJob } from '@/jobs/expiring-plans.job';
import { TelegramTaskSweepJob } from '@/jobs/telegram-task-sweep.job';
import { MobileOrphanSweepJob } from '@/jobs/mobile-orphan-sweep.job';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

initLogBridge();

async function main(): Promise<void> {
  let failed = false;

  try {
    const retired = await AutoLearnRetireJob.tick();
    logger.info('[SCHEDULER_DAILY] Auto-learn retire done', retired);
  } catch (error) {
    failed = true;
    logger.error('[SCHEDULER_DAILY] Auto-learn retire failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const purged = await AccountDeletionPurgeJob.tick();
    logger.info('[SCHEDULER_DAILY] Account-deletion purge done', purged);
  } catch (error) {
    failed = true;
    logger.error('[SCHEDULER_DAILY] Account-deletion purge failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const purgedLogs = await AiCallLogsRetentionJob.tick();
    logger.info('[SCHEDULER_DAILY] AI call-logs retention done', purgedLogs);
  } catch (error) {
    failed = true;
    logger.error('[SCHEDULER_DAILY] AI call-logs retention failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const swept = await MobileOrphanSweepJob.tick();
    logger.info('[SCHEDULER_DAILY] Mobile orphan sweep done', swept);
  } catch (error) {
    failed = true;
    logger.error('[SCHEDULER_DAILY] Mobile orphan sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const reminded = await ExpiringPlansJob.tick();
    logger.info('[SCHEDULER_DAILY] Expiring-plans reminder done', reminded);
  } catch (error) {
    failed = true;
    logger.error('[SCHEDULER_DAILY] Expiring-plans reminder failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // QAIT Tasker morning batch. Here we call tick() directly (bypassing the
  // in-process hour-gate): in this Cloud Run Job path the firing TIME is owned
  // by Cloud Scheduler, not the gate. NOTE: this Job runs at 03:00 UTC = 08:00
  // Almaty; the intended batch time is 10:00 Almaty (05:00 UTC). To match, give
  // QAIT Tasker its OWN Cloud Scheduler trigger at 05:00 UTC, or accept 08:00.
  // The TELEGRAM_TASK_BATCH_HOUR gate governs only the persistent scheduler
  // (local docker-compose + worker leader-bundle). Feature-gated either way.
  if (env.TELEGRAM_TASKS_ENABLED) {
    try {
      const swept = await TelegramTaskSweepJob.tick();
      logger.info('[SCHEDULER_DAILY] QAIT Tasker sweep done', swept);
    } catch (error) {
      failed = true;
      logger.error('[SCHEDULER_DAILY] QAIT Tasker sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failed) {
    throw new Error('One or more daily tasks failed (see logs above)');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('[SCHEDULER_DAILY] Fatal', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
