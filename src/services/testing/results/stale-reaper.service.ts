import {
  findStaleRuns,
  findRunIdsWithStaleExecutions,
  getRunsByIds,
  findStaleRunningTests,
  forceFailStuckTests,
  finalizeAbandonedTest,
  type StaleRunRow,
} from '@/services/testing/results/db/test-completion.db';
import { TestCompletionHandlerService } from '@/services/testing/results/test-completion-handler.service';
import { ExplorationStorageService } from '@/services/testing/exploration/exploration-storage.service';
import { logger } from '@/utils/core/logger';

/**
 * Finalization of abandoned test artifacts — runs/tests/executions stranded in
 * a non-terminal status because the work that should have finalized them never
 * completed (worker died mid-run, job never picked up, Redis flush, …).
 *
 * Two complementary mechanisms:
 *   - `handleAbandonedTest` — event-driven, fired from the worker's BullMQ
 *     `failed` handler. Primary path: closes the orphan at the source within
 *     the stall window.
 *   - `reapStaleRuns` / `reapStaleTests` — periodic backstop, driven by
 *     `StaleRunReaperJob` on the scheduler. Catches whatever the event path
 *     can't (jobs lost before enqueue, Redis flush, all workers down).
 *
 * Run/execution finalization is delegated to the single funnel
 * `TestCompletionHandlerService.recomputeRunStatus` (which owns the 30-min
 * force-fail + telemetry aggregation). This service only finds the stale rows
 * and feeds them in; it never writes run status itself.
 */
export class StaleReaperService {
  /**
   * Reap regression runs stuck in 'running'/'pending'.
   *
   * `recomputeRunStatus` already force-fails executions stuck >30 min, but it
   * only runs when a test-completion event fires. If a job is never picked up,
   * no event ever arrives — so the run and its orphaned executions stay
   * 'running' forever. This sweep is the missing trigger.
   *
   * Idempotent: already-terminal runs are excluded by the status filter, and
   * recomputeRunStatus's optimistic lock prevents double-finalization. Side
   * effects (notifications, automation, flaky-retry, doctor) are suppressed —
   * firing them long after the fact would be noise.
   *
   * @param thresholdMinutes Sweep runs older than this. Defaults to 30 to match
   *   recomputeRunStatus's internal staleness guard.
   * @returns count of runs scanned this sweep
   */
  static async reapStaleRuns(thresholdMinutes = 30): Promise<{ scanned: number }> {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();

    // Two orphan classes, unioned:
    //   1. Parent-level — the run's own row is stuck 'running'/'pending'.
    //   2. Child-level  — the parent was already finalized (race flipped it
    //      to 'completed') but a child execution never resolved. This is the
    //      common mobile-job-never-picked-up case; the parent-status query
    //      alone would miss it, so we also hydrate runs surfaced via their
    //      stale executions. Feeding such a run to recomputeRunStatus
    //      force-fails the orphaned child (its optimistic lock makes the
    //      already-terminal parent a safe no-op).
    let runs: StaleRunRow[];
    try {
      const [parentStale, execRunIds] = await Promise.all([
        findStaleRuns(cutoff),
        findRunIdsWithStaleExecutions(cutoff),
      ]);

      const parentIds = new Set(parentStale.map((r) => r.id));
      const extraIds = execRunIds.filter((id) => !parentIds.has(id));
      const extraRuns = await getRunsByIds(extraIds);

      runs = [...parentStale, ...extraRuns];
    } catch (err) {
      logger.error('[STALE_RUN_REAPER] Failed to query stale runs', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { scanned: 0 };
    }

    if (runs.length === 0) {
      logger.debug('[STALE_RUN_REAPER] No stale runs to reap');
      return { scanned: 0 };
    }

    logger.info('[STALE_RUN_REAPER] Reaping stale runs', { count: runs.length });

    for (const run of runs) {
      try {
        await TestCompletionHandlerService.recomputeRunStatus(run, { suppressSideEffects: true });
      } catch (err) {
        logger.error('[STALE_RUN_REAPER] Failed to recompute stale run (will retry next sweep)', {
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { scanned: runs.length };
  }

  /**
   * Backstop reaper for standalone `tests` rows stuck 'running' (manual tests
   * with no regression_run parent and no test_executions child — invisible to
   * reapStaleRuns). Force-fails them to 'timeout'. Side effects suppressed:
   * these are old orphans, so we only correct the row, no notifications.
   *
   * `handleAbandonedTest` (fired from the worker's `failed` event) is the
   * primary, fast path; this catches what that can't — jobs lost before
   * enqueue, Redis flush, or all workers down.
   */
  static async reapStaleTests(thresholdMinutes = 30): Promise<{ scanned: number }> {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();

    let stale: Array<{ id: string }>;
    try {
      stale = await findStaleRunningTests(cutoff);
    } catch (err) {
      logger.error('[STALE_RUN_REAPER] Failed to query stale tests', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { scanned: 0 };
    }

    if (stale.length === 0) {
      logger.debug('[STALE_RUN_REAPER] No stale tests to reap');
      return { scanned: 0 };
    }

    const ids = stale.map((t) => t.id);
    logger.info('[STALE_RUN_REAPER] Reaping stale tests', { count: ids.length });

    const { error } = await forceFailStuckTests(ids);
    if (error) {
      logger.error('[STALE_RUN_REAPER] Force-fail of stale tests failed — rows may stay dirty', {
        ids,
        error,
      });
    }

    return { scanned: ids.length };
  }

  /**
   * Backstop reaper for `exploration_runs` stuck in 'running'. Exploration
   * finalization is event-driven in the job (completeRun/failRun); a worker that
   * dies without throwing leaves the row 'running' forever. Flips such rows to
   * 'timed_out'. Same poll cadence + threshold as the tests/runs reapers.
   */
  static async reapStaleExplorations(thresholdMinutes = 30): Promise<{ scanned: number }> {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
    const count = await ExplorationStorageService.reapStaleRunningRuns(cutoff);
    return { scanned: count };
  }

  /**
   * Finalize a `tests` row whose job died without writing a terminal status
   * (process killed / OOM / deploy / stall-death). Called from the worker's
   * BullMQ `failed` handler — the primary, event-driven path that closes the
   * orphan at the source within the stall window, not the 30-min reaper poll.
   *
   * Idempotent: the guarded DB write only flips a still-live row, so a
   * gracefully-failed test (already terminal) is a no-op and does NOT re-fire
   * the completion pipeline. On a real flip we run handleTestCompletion so the
   * user is notified and any linked regression run recomputes.
   */
  static async handleAbandonedTest(testId: string, reason: string): Promise<void> {
    const { flipped, error } = await finalizeAbandonedTest(testId, 'failed');

    if (error) {
      logger.error('[ABANDONED_TEST] Failed to finalize abandoned test', { testId, error });
      return;
    }
    if (!flipped) return; // job already finalized gracefully (or a peer won the race)

    logger.warn('[ABANDONED_TEST] Finalized test abandoned by a dead job', { testId, reason });
    await TestCompletionHandlerService.handleTestCompletion(testId);
  }
}
