/**
 * Scheduler Process Entry Point
 *
 * IMPORTANT:
 * - Users configure schedules via API (create/update schedules in DB).
 * - This process is responsible only for executing due schedules.
 * - It is intentionally NOT started by the API server automatically.
 */

import { env } from '@/config/environment/env';
import { TestSchedulerJobHandler } from '@/jobs/test-scheduler.job';
import { logger } from '@/utils/core/logger';

/**
 * Start scheduler process.
 * Runs forever until the process receives a shutdown signal.
 */
async function main(): Promise<void> {
  logger.info('[SCHEDULER_PROCESS] Starting scheduler process', {
    nodeEnv: env.NODE_ENV,
    intervalMs: 60000,
  });

  // Start loop
  TestSchedulerJobHandler.start(60000);

  const shutdown = (signal: string) => {
    logger.info('[SCHEDULER_PROCESS] Received shutdown signal', { signal });
    try {
      TestSchedulerJobHandler.stop();
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
