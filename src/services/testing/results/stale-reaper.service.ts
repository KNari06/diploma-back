import {
  findStaleRuns,
  findRunIdsWithStaleExecutions,
  findExecutionActivityByRunIds,
  getRunsByIds,
  findStaleRunningTests,
  forceFailStuckTests,
  finalizeAbandonedTest,
  type ExecutionActivityRow,
  type StaleRunRow,
} from '@/services/testing/results/db/test-completion.db';
import {
  TestCompletionHandlerService,
  isRunProgressStale,
} from '@/services/testing/results/test-completion-handler.service';
import { ExplorationStorageService } from '@/services/testing/exploration/exploration-storage.service';
import { STALE_RUN_THRESHOLD_MIN } from '@/config/testing/run-staleness';
import { logger } from '@/utils/core/logger';

/** Whole minutes since an ISO timestamp, or undefined if unparseable. */
function ageMinutesSince(iso: string | null): number | undefined {
  if (!iso) return undefined;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.round(ms / 60000) : undefined;
}

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
 * `TestCompletionHandlerService.recomputeRunStatus` (which owns the no-progress
 * force-fail + telemetry aggregation). This service only finds the stale rows
 * and feeds them in; it never writes run status itself.
 */
export class StaleReaperService {
  /** runId/testId already reported as vanished, so a row that recompute can't
   *  finalize doesn't re-emit `run.vanished` on every 5-min sweep. Bounded:
   *  cleared when it grows past the cap (vanished rows are rare, so this is a
   *  generous backstop, not a steady-state size). */
  private static readonly emittedVanished = new Set<string>();
  private static readonly EMITTED_VANISHED_CAP = 5000;

  /**
   * Audit (Loki): a run/test/exploration started but never reached a terminal
   * status — a SILENT death (worker crash, lost job, runner unreachable) that no
   * error path ever logged. The reaper detecting it by *absence* is the only
   * signal we get, so emit a keyed, queryable `run.vanished` event at WARN.
   * Deduped by run/test id so a row that fails to finalize emits ONCE, not every
   * sweep. (Explorations are an aggregate count with no id — they emit per sweep
   * when count>0, which is already once-per-sweep.)
   */
  private static emitRunVanished(fields: {
    kind: 'run' | 'test' | 'exploration';
    runId?: string;
    testId?: string;
    userId?: string | null;
    projectId?: string | null;
    stuckStatus?: string;
    ageMinutes?: number;
    count?: number;
  }): void {
    const dedupKey = fields.runId ?? fields.testId;
    if (dedupKey) {
      if (this.emittedVanished.has(dedupKey)) return;
      if (this.emittedVanished.size >= this.EMITTED_VANISHED_CAP) this.emittedVanished.clear();
      this.emittedVanished.add(dedupKey);
    }
    try {
      logger.warn('[STALE_RUN_REAPER] run vanished', {
        event: 'run.vanished',
        severity: 'warning',
        ...fields,
      });
    } catch {
      /* best-effort telemetry — never let a log failure interrupt the reap loop */
    }
  }

  /**
   * Reap regression runs stuck in 'running'/'pending'.
   *
   * `recomputeRunStatus` already force-fails a stalled run's executions, but it
   * only runs when a test-completion event fires. If a job is never picked up,
   * no event ever arrives — so the run and its orphaned executions stay
   * 'running' forever. This sweep is the missing trigger.
   *
   * The DB queries can only select on an OLD timestamp, so candidates are then
   * narrowed by `filterToStalledRuns`: a long-but-healthy run is skipped
   * entirely rather than being recomputed and reported vanished.
   *
   * Idempotent: already-terminal runs are excluded by the status filter, and
   * recomputeRunStatus's optimistic lock prevents double-finalization. Side
   * effects (notifications, automation, flaky-retry, doctor) are suppressed —
   * firing them long after the fact would be noise.
   *
   * @param thresholdMinutes A run is dead after this long with NO progress.
   *   Defaults to the shared `STALE_RUN_THRESHOLD_MIN` so this and
   *   recomputeRunStatus's internal guard can't drift apart.
   * @returns count of runs actually reaped this sweep (candidates still
   *   progressing are not counted)
   */
  static async reapStaleRuns(
    thresholdMinutes = STALE_RUN_THRESHOLD_MIN,
  ): Promise<{ scanned: number }> {
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

    // Both queries above select on an OLD timestamp, which says nothing about
    // whether the run is still moving. Drop the candidates whose children are
    // still starting/finishing — reporting one of those as vanished is a false
    // alarm, and recomputing it is a no-op anyway (the same progress clock
    // guards the force-fail inside `recomputeRunStatus`).
    const dead = await this.filterToStalledRuns(runs, thresholdMinutes);

    if (dead.length === 0) {
      logger.debug('[STALE_RUN_REAPER] All stale-looking runs are still progressing', {
        candidates: runs.length,
      });
      return { scanned: 0 };
    }

    logger.info('[STALE_RUN_REAPER] Reaping stale runs', {
      count: dead.length,
      stillProgressing: runs.length - dead.length,
    });

    for (const run of dead) {
      this.emitRunVanished({
        kind: 'run',
        runId: run.id,
        userId: run.user_id,
        projectId: run.project_id,
        stuckStatus: run.status,
        ageMinutes: ageMinutesSince(run.started_at),
      });
      try {
        await TestCompletionHandlerService.recomputeRunStatus(run, { suppressSideEffects: true });
      } catch (err) {
        logger.error('[STALE_RUN_REAPER] Failed to recompute stale run (will retry next sweep)', {
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { scanned: dead.length };
  }

  /**
   * Narrow reaper candidates to the ones that have genuinely stalled — no
   * child execution has started or completed within the threshold.
   *
   * Fail-open: if the activity read throws we keep every candidate, which is
   * the pre-existing behaviour. A backstop that silently disables itself on a
   * query error is worse than one that occasionally finalizes early.
   */
  private static async filterToStalledRuns(
    runs: StaleRunRow[],
    thresholdMinutes: number,
  ): Promise<StaleRunRow[]> {
    let activity: ExecutionActivityRow[];
    try {
      activity = await findExecutionActivityByRunIds(runs.map((r) => r.id));
    } catch (err) {
      logger.warn('[STALE_RUN_REAPER] Execution-activity read failed — reaping unfiltered', {
        error: err instanceof Error ? err.message : String(err),
      });
      return runs;
    }

    const byRun = new Map<string, ExecutionActivityRow[]>();
    for (const row of activity) {
      const bucket = byRun.get(row.run_id);
      if (bucket) bucket.push(row);
      else byRun.set(row.run_id, [row]);
    }

    const now = Date.now();
    const thresholdMs = thresholdMinutes * 60 * 1000;

    return runs.filter((run) => {
      const stalled = isRunProgressStale(run, byRun.get(run.id) ?? [], now, thresholdMs);
      if (!stalled) {
        logger.debug('[STALE_RUN_REAPER] Run is old but still progressing — leaving it alone', {
          runId: run.id,
          startedAt: run.started_at,
        });
      }
      return stalled;
    });
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
  static async reapStaleTests(thresholdMinutes = STALE_RUN_THRESHOLD_MIN): Promise<{ scanned: number }> {
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

    for (const id of ids) {
      this.emitRunVanished({ kind: 'test', testId: id });
    }

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
  static async reapStaleExplorations(thresholdMinutes = STALE_RUN_THRESHOLD_MIN): Promise<{ scanned: number }> {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
    const count = await ExplorationStorageService.reapStaleRunningRuns(cutoff);
    if (count > 0) {
      this.emitRunVanished({ kind: 'exploration', count });
    }
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
