/**
 * Pure helper for deriving a regression run's display status from live
 * execution data rather than the cached `regression_runs.status` column.
 *
 * Background: `regression_runs.status` is written once by
 * `TestCompletionHandlerService.recomputeRunStatus()` via an optimistic lock.
 * If that write fires before all `test_executions.status` rows are fully
 * settled (competing-writer race on mobile runs), the cached value can be
 * permanently wrong — e.g. 'completed' when executions show failures.
 *
 * This function re-derives status from the live execution stats so the UI
 * always reflects the ground truth stored in `test_executions`.
 */

export interface RunStatusExecStats {
  total: number;
  failed: number;
  /** Number of executions still in progress. Optional for backwards-compat with existing callers. */
  running?: number;
}

/**
 * Derive the display status for a regression run.
 *
 * @param cachedStatus - `regression_runs.status` from the DB (may be stale)
 * @param execStats    - Live aggregated counts from `test_executions`
 * @returns Display status string (never 'completed' — normalised to 'passed')
 */
export function deriveRunStatus(params: {
  cachedStatus: string | null;
  execStats: RunStatusExecStats;
}): string | null {
  const { cachedStatus, execStats } = params;
  const running = execStats.running ?? 0;

  // Trust in-progress and cancelled states — the bug only affects terminal
  // runs whose cached status diverges from the final execution outcomes.
  if (cachedStatus === 'running' || cachedStatus === 'pending') return cachedStatus;
  if (cachedStatus === 'cancelled') return 'cancelled';

  // For terminal runs derive from live execution data to fix stale-cache mismatch.
  if (execStats.total > 0) {
    // A terminal parent with live children means the force-fail didn't land in the DB.
    // Surface 'running' so the UI doesn't mask a stuck execution with 'passed'.
    if (running > 0) return 'running';
    if (execStats.failed > 0) return 'failed';
    return 'passed';
  }

  // No executions yet (e.g. run was just created) — normalise 'completed'
  // → 'passed' for frontend compatibility and fall back to the cached value.
  return cachedStatus === 'completed' ? 'passed' : (cachedStatus || null);
}
