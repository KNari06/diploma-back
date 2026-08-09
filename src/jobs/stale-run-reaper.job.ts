/**
 * Stale-Run Reaper Job
 *
 * Periodic sweep that finalizes regression runs and standalone tests stuck
 * in 'running'/'pending'. Companion to `StaleReaperService` — this file is
 * just the scheduler + error isolation; all the logic lives in the service
 * so it can also be triggered ad-hoc from a script.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Why it exists
 * ──────────────────────────────────────────────────────────────────────
 *
 * Run finalization is event-driven: `recomputeRunStatus` fires when a
 * test completes. If a job is never picked up (worker crash, queue stall,
 * mobile runner unreachable), no completion event ever arrives and the
 * run — plus its orphaned executions — stay 'running' forever. This sweep
 * supplies the missing trigger.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Where this runs
 * ──────────────────────────────────────────────────────────────────────
 *
 * Bootstrapped from the scheduler bundle ONLY: `src/scheduler/index.ts` (local
 * scheduler container) or, in prod, the worker behind the Redis leader lock in
 * `src/scheduler/leader.ts`. No cross-instance dedupe of its own — the leader
 * lock guarantees a single live sweep at N worker replicas. Do NOT start it
 * from `src/index.ts` (the auto-scaled API) or outside the lock: N concurrent
 * sweeps would race each other on the same rows. Mirrors `AccountDeletionPurgeJob`.
 */

import { logger } from '@/utils/core/logger';
import { StaleReaperService } from '@/services/testing/results/stale-reaper.service';
import { STALE_RUN_THRESHOLD_MIN } from '@/config/testing/run-staleness';

/** Tick interval — default 5 min. Frequent enough to clear orphans fast,
 *  cheap enough (one indexed query returning ~0 rows in the common case). */
const DEFAULT_TICK_MS = parseInt(
  process.env.STALE_RUN_REAPER_INTERVAL_MS ?? String(5 * 60 * 1000),
  10,
);

/** Staleness threshold in minutes — how long a run may show NO progress before
 *  it is presumed dead. Shared with recomputeRunStatus's own force-fail guard
 *  (`STALE_RUN_THRESHOLD_MIN`, env-tunable) so the two can't drift: a smaller
 *  value here would select runs the guard then refuses to force-fail. */
const THRESHOLD_MINUTES = STALE_RUN_THRESHOLD_MIN;

export class StaleRunReaperJob {
  private static intervalId: NodeJS.Timeout | null = null;

  /**
   * Start the sweep. Calling `start()` twice is a no-op and logs a warn —
   * matches the other scheduler jobs.
   *
   * @param intervalMs Override the tick interval (tests). In production the
   *   env var is the canonical knob.
   */
  static start(intervalMs: number = DEFAULT_TICK_MS): void {
    if (this.intervalId) {
      logger.warn('[STALE_RUN_REAPER] Already running');
      return;
    }

    logger.info('[STALE_RUN_REAPER] Starting sweep', {
      intervalMs,
      thresholdMinutes: THRESHOLD_MINUTES,
    });

    // Fire once immediately so a deploy doesn't sit on a backlog of
    // orphaned runs until the first interval elapses. Not awaited.
    this.tick().catch((err) => {
      logger.error('[STALE_RUN_REAPER] Initial tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.intervalId = setInterval(() => {
      this.tick().catch((err) => {
        logger.error('[STALE_RUN_REAPER] Scheduled tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
  }

  /** Stop the sweep. Used by tests + graceful shutdown. */
  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[STALE_RUN_REAPER] Stopped');
    }
  }

  /** Process one tick — sweep orphaned regression runs, standalone tests, and
   *  abandoned exploration runs. Each is independent + best-effort; one failing
   *  must not skip the others. */
  static async tick(): Promise<{ runs: number; tests: number; explorations: number }> {
    const runs = await StaleReaperService.reapStaleRuns(THRESHOLD_MINUTES);
    const tests = await StaleReaperService.reapStaleTests(THRESHOLD_MINUTES);
    const explorations = await StaleReaperService.reapStaleExplorations(THRESHOLD_MINUTES);
    return { runs: runs.scanned, tests: tests.scanned, explorations: explorations.scanned };
  }
}
