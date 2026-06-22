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
    const reminded = await ExpiringPlansJob.tick();
    logger.info('[SCHEDULER_DAILY] Expiring-plans reminder done', reminded);
  } catch (error) {
    failed = true;
    logger.error('[SCHEDULER_DAILY] Expiring-plans reminder failed', {
      error: error instanceof Error ? error.message : String(error),
    });
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
