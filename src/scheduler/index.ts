/**
 * Scheduler Process Entry Point
 *
 * IMPORTANT:
 * - Users configure schedules via API (create/update schedules in DB).
 * - This process is responsible only for executing due schedules.
 * - It is intentionally NOT started by the API server automatically.
 */

import { env } from '@/config/environment/env';
import { AccountDeletionPurgeJob } from '@/jobs/account-deletion-purge.job';
import { ArtifactRetentionJob } from '@/jobs/artifact-retention.job';
import { AutoLearnRetireJob } from '@/jobs/auto-learn-retire.job';
import { ExpiringPlansJob } from '@/jobs/expiring-plans.job';
import { StaleRunReaperJob } from '@/jobs/stale-run-reaper.job';
import { AiCallLogsRetentionJob } from '@/jobs/ai-call-logs-retention.job';
import { ScreenshotCaptureFeature } from '@/config/features/screenshot-capture';
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

  // Daily account-deletion purge sweep. Walks soft-deleted users whose
  // 30d grace window has elapsed and runs the hard-purge cascade.
  // Belongs here (and NOT in the API process) because Cloud Run scales
  // the API to N replicas — running this sweep there would fire N
  // copies in parallel.
  AccountDeletionPurgeJob.start();

  // Stale-run reaper. Finalizes regression runs orphaned in
  // 'running'/'pending' when no test-completion event ever fires (worker
  // crash, queue stall, mobile runner unreachable). Single-instance only,
  // same Cloud Run reasoning as the purge sweep above.
  StaleRunReaperJob.start();

  // Daily TTL sweep for ai_call_logs (redacted LLM I/O store). Same
  // single-instance reasoning as the sweeps above.
  AiCallLogsRetentionJob.start();

  // Daily "plan expiring in 3 days" reminder. Emails paid users whose
  // current_period_end is within 3 days; per-period dedup marker prevents
  // re-sending. Single-instance (same Cloud Run reasoning as the sweeps above).
  ExpiringPlansJob.start();

  // Per-step screenshot retention. Prunes `${userId}/step-screenshots/...`
  // older than SCREENSHOT_RETENTION_DAYS. Only meaningful while per-step
  // capture is enabled (default ON) — skip the sweep otherwise so we don't
  // walk storage for nothing.
  if (ScreenshotCaptureFeature.isEnabled()) {
    ScreenshotCaptureFeature.logStatus();
    ArtifactRetentionJob.start();
  }

  const shutdown = async (signal: string) => {
    logger.info('[SCHEDULER_PROCESS] Received shutdown signal', { signal });
    try {
      // Stop the timers first (no new ticks), then wait for any in-flight tick
      // to finish so a deploy doesn't abandon a just-claimed schedule mid-dispatch.
      TestSchedulerJobHandler.stop();
      AutoLearnRetireJob.stop();
      AccountDeletionPurgeJob.stop();
      StaleRunReaperJob.stop();
      AiCallLogsRetentionJob.stop();
      ArtifactRetentionJob.stop();
      ExpiringPlansJob.stop();
      await TestSchedulerJobHandler.waitForIdle();
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
