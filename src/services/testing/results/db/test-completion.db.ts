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
}

// ── stale-run-reaper ────────────────────────────────────────────────────────

const RUN_FIELDS =
  'id, status, started_at, project_id, user_id, plan_id, trigger, test_id, test_ids';

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
 * Mark stuck `tests` rows as timed-out (legacy, pre-`test_executions` runs).
 * Same non-bailing contract as `forceFailStuckExecutions`.
 */
export async function forceFailStuckTests(
  testIds: string[],
): Promise<{ error: unknown }> {
  if (testIds.length === 0) return { error: null };

  const { error } = await supabaseAdmin
    .from('tests')
    .update({ status: 'timeout', completed_at: new Date().toISOString() })
    .in('id', testIds);

  return { error };
}
