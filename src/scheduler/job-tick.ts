/**
 * Per-minute Scheduler tick — Cloud Run Job entry point.
 *
 * Run-to-completion (NOT a persistent setInterval): Cloud Scheduler invokes this
 * Job every minute, it does ONE sweep, then exits. No HTTP listener — Cloud Run
 * Jobs need no port (unlike the worker Service, which fakes one).
 *
 * Does two things per tick:
 *   1. processSchedules() — claim + dispatch all due schedules. This is the
 *      critical path; if it throws, the Job exits non-zero so the failure
 *      surfaces in Cloud Run Job execution metrics (the alert signal).
 *   2. StaleRunReaperJob.tick() — reap orphaned runs. Native cadence is 5 min;
 *      running it per-minute is harmless (atomic/idempotent) and saves a 3rd
 *      cron. Wrapped so a reaper failure NEVER fails the schedule sweep / alert.
 *
 * The persistent `src/scheduler/index.ts` is kept for local dev (docker-compose).
 */

import { initLogBridge } from '@/utils/core/log-bridge';
import { TestSchedulerJobHandler } from '@/jobs/test-scheduler.job';
import { StaleRunReaperJob } from '@/jobs/stale-run-reaper.job';
import { logger } from '@/utils/core/logger';

initLogBridge();

async function main(): Promise<void> {
  await TestSchedulerJobHandler.processSchedules();

  // Reaper is secondary — its failure must not fail the execution (which would
  // alert on the wrong thing). Log and swallow.
  try {
    const reaped = await StaleRunReaperJob.tick();
    if (reaped.runs > 0 || reaped.tests > 0) {
      logger.info('[SCHEDULER_TICK] Reaped stale runs', reaped);
    }
  } catch (reaperError) {
    logger.error('[SCHEDULER_TICK] Reaper failed (non-fatal)', {
      error: reaperError instanceof Error ? reaperError.message : String(reaperError),
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('[SCHEDULER_TICK] Fatal — schedule sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
