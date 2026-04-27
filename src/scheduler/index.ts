/**
 * Scheduler Process Entry Point
 *
 * IMPORTANT:
 * - Users configure schedules via API (create/update schedules in DB).
 * - This process is responsible only for executing due schedules.
 * - It is intentionally NOT started by the API server automatically.
 */

import { env } from '@/config/environment/env';
import { AutoLearnRetireJob } from '@/jobs/auto-learn-retire.job';
import { TestSchedulerJobHandler } from '@/jobs/test-scheduler.job';
import { logger } from '@/utils/core/logger';
import { initLogBridge } from '@/utils/core/log-bridge';

// Forward this process's Winston log entries to the API process's ring buffer
// (powers the System Logs tab). No-op if Redis is unavailable.
initLogBridge();

/**
 * Start scheduler process.
 * Runs forever until the process receives a shutdown signal.
 */
async function main(): Promise<void> {
  logger.info('[SCHEDULER_PROCESS] Starting scheduler process', {
    nodeEnv: env.NODE_ENV,
    intervalMs: 60000,
  });

  // Start loop — per-minute sweep for due schedules
  TestSchedulerJobHandler.start(60000);

  // Phase 5 — nightly auto-learn retirement. 24h interval, 30d TTL.
  AutoLearnRetireJob.start();

  const shutdown = (signal: string) => {
    logger.info('[SCHEDULER_PROCESS] Received shutdown signal', { signal });
    try {
      TestSchedulerJobHandler.stop();
      AutoLearnRetireJob.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('[SCHEDULER_PROCESS] Fatal error', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
