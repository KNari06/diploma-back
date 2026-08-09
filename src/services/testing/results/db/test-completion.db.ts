import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for the test-completion / run-finalization pipeline.
 * Pure Supabase queries — no business logic, no orchestration.
 */

/** Minimal regression_runs shape consumed by recomputeRunStatus. */
export interface StaleRunRow {
  id: string;
  status: string;
  started_at: string | null;
  project_id: string | null;
  user_id: string | null;
  plan_id: string | null;
  trigger: string | null;
  test_id: string | null;
  test_ids: string[] | null;
  summary: Record<string, unknown> | null;
  pending_segments: number | null;
  last_segment_dispatched_at: string | null;
}

// ── stale-run-reaper ────────────────────────────────────────────────────────

// `pending_segments`/`last_segment_dispatched_at` must be selected here —
// recomputeRunStatus's pending-segments staleness guard (ADR-0011 update 6)
// reads them off whatever row it's handed, including a row surfaced through
// this reaper path. Without them a segmented chain reaching recomputeRunStatus
// via the reaper (rather than the event-driven test-completion path) would
// have `pending_segments` silently read as `undefined` — treated as "not
// segmented" — and fall through to the legacy chain-wide staleness check the
// fix specifically corrected.
const RUN_FIELDS =
  'id, status, started_at, project_id, user_id, plan_id, trigger, test_id, test_ids, summary, pending_segments, last_segment_dispatched_at';

/**
 * Fetch regression runs whose OWN row is still 'running'/'pending' and
 * older than `cutoffIso`. Catches parent-level orphans — a run that never
 * got finalized (e.g. all children settled but the finalize write was lost
 * to a race, or the orchestrator crashed mid-run).
 *
 * Only non-null `started_at` rows match (SQL `<` excludes nulls) — that's
 * intentional: recomputeRunStatus's staleness guard keys off `started_at`,
 * so a never-started 'pending' run wouldn't be force-failed anyway.
 *
 * Throws on DB/network error — the caller wraps this in try/catch.
 */
export async function findStaleRuns(
  cutoffIso: string,
  limit = 100,
): Promise<StaleRunRow[]> {
  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .select(RUN_FIELDS)
    .in('status', ['running', 'pending'])
    .lt('started_at', cutoffIso)
    .order('started_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`findStaleRuns failed: ${error.message}`);
  }

  return (data ?? []) as StaleRunRow[];
}

/**
 * Distinct run IDs that have at least one `test_executions` row stuck in
 * 'running'/'pending' older than `cutoffIso`. Catches child-level orphans —
 * the common case where the PARENT run was already finalized (a race flipped
 * it to 'completed') but a child execution was never resolved because its
 * job was never picked up. Filters on `created_at` (always set) rather than
 * `started_at` (null for never-dispatched 'pending' rows).
 *
 * Throws on DB/network error — the caller wraps this in try/catch.
 */
export async function findRunIdsWithStaleExecutions(
  cutoffIso: string,
  limit = 500,
): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('test_executions')
    .select('run_id')
    .in('status', ['running', 'pending'])
    .lt('created_at', cutoffIso)
    .limit(limit);

  if (error) {
    throw new Error(`findRunIdsWithStaleExecutions failed: ${error.message}`);
  }

  return [...new Set((data ?? []).map((r: any) => r.run_id).filter(Boolean))];
}

/**
 * Fetch full run rows by id — used to hydrate runs surfaced only via their
 * stale executions (parent row may be any status, including 'completed').
 *
 * Throws on DB/network error — the caller wraps this in try/catch.
 */
export async function getRunsByIds(ids: string[]): Promise<StaleRunRow[]> {
  if (ids.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .select(RUN_FIELDS)
    .in('id', ids);

  if (error) {
    throw new Error(`getRunsByIds failed: ${error.message}`);
  }

  return (data ?? []) as StaleRunRow[];
}

/** Per-execution progress timestamps, keyed back to the run they belong to. */
export interface ExecutionActivityRow {
  run_id: string;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * Every child execution's progress timestamps for the given runs, in one
 * batched read (`run_id` is indexed). Feeds the reaper's progress check so a
 * run that is merely OLD — but whose children are still starting and
 * finishing — is left alone instead of being reported vanished.
 *
 * Throws on DB/network error; the caller treats that as "can't tell" and
 * proceeds unfiltered rather than skipping the sweep (a broken query must not
 * silently disable the backstop).
 */
export async function findExecutionActivityByRunIds(
  runIds: string[],
): Promise<ExecutionActivityRow[]> {
  if (runIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('test_executions')
    .select('run_id, started_at, completed_at')
    .in('run_id', runIds);

  if (error) {
    throw new Error(`findExecutionActivityByRunIds failed: ${error.message}`);
  }

  return (data ?? []) as ExecutionActivityRow[];
}

// ── stale standalone tests ────────────────────────────────────────────────────

/**
 * Standalone `tests` rows stuck 'running' past `cutoffIso` (the job started —
 * `started_at` is set — but never finalized; e.g. the worker process died
 * mid-run). 'running'-only by design: a 'running' row provably began, so after
 * the threshold it's dead; 'pending' is left alone to avoid killing work
 * legitimately queued behind a busy worker.
 *
 * Throws on DB/network error — the caller wraps this in try/catch.
 */
export async function findStaleRunningTests(
  cutoffIso: string,
  limit = 100,
): Promise<Array<{ id: string }>> {
  const { data, error } = await supabaseAdmin
    .from('tests')
    .select('id')
    .eq('status', 'running')
    .lt('started_at', cutoffIso)
    .order('started_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`findStaleRunningTests failed: ${error.message}`);
  }

  return (data ?? []) as Array<{ id: string }>;
}

// ── force-fail stuck rows ─────────────────────────────────────────────────────

/**
 * Mark stuck `test_executions` rows as failed (the >30-min force-fail).
 * Returns the Supabase error (or null) — the caller decides whether to log;
 * it must NOT bail, because the in-memory status remap is independent of
 * this write succeeding.
 */
export async function forceFailStuckExecutions(
  executionIds: string[],
  errorMessage: string,
): Promise<{ error: unknown }> {
  if (executionIds.length === 0) return { error: null };

  const { error } = await supabaseAdmin
    .from('test_executions')
    .update({
      status: 'failed',
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    })
    .in('id', executionIds);

  return { error };
}

/**
 * Mark stuck `tests` rows as failed (legacy, pre-`test_executions` runs).
 * Same non-bailing contract as `forceFailStuckExecutions`.
 *
 * Writes `failed` rather than a distinct `timeout` status: nothing downstream
 * reads `timeout` separately (every consumer groups it with `failed`), and the
 * mirrored `test_executions.status` CHECK constraint forbids `timeout` — so a
 * `timeout` write propagated to `test_executions` raised 23514 and left the run
 * dirty. `failed` is valid in both vocabularies and carries the same meaning.
 *
 * Guarded (`.in('status', ['running','pending'])`) — defense in depth against
 * the same read-then-write race `updateRunByIdIfActive` guards elsewhere: the
 * caller's `testIds` snapshot is read moments before this write, and a row
 * could have already gone terminal in between (e.g. finished for real just as
 * a staleness sweep decided it looked stuck). Without the filter this would
 * silently overwrite a legitimately-completed row back to 'failed'.
 */
export async function forceFailStuckTests(
  testIds: string[],
): Promise<{ error: unknown }> {
  if (testIds.length === 0) return { error: null };

  const { error } = await supabaseAdmin
    .from('tests')
    .update({ status: 'failed', completed_at: new Date().toISOString() })
    .in('id', testIds)
    .in('status', ['running', 'pending']);

  return { error };
}

/**
 * Guarded terminal write for a single `tests` row abandoned by a dead job.
 * The `.in('status', ['running','pending'])` guard makes this idempotent and
 * race-safe: it only flips a still-live row, so it's a no-op when the job
 * already finalized gracefully or when a concurrent worker replica won the
 * race. `flipped` tells the caller whether THIS call did the transition.
 *
 * Writes only status/completed_at: `tests` has no `error_message` column
 * (writing one raised PGRST204 and killed the whole abandoned-test backstop,
 * leaving runs stuck 'running'). The abandon reason lives in the caller's log.
 */
export async function finalizeAbandonedTest(
  testId: string,
  status: 'failed' | 'timeout',
): Promise<{ flipped: boolean; error: unknown }> {
  const { data, error } = await supabaseAdmin
    .from('tests')
    .update({
      status,
      completed_at: new Date().toISOString(),
    })
    .eq('id', testId)
    .in('status', ['running', 'pending'])
    .select('id');

  return { flipped: !!(data && data.length > 0), error };
}
