import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for regression_runs / test_executions reads + writes shared
 * across the regression pipeline (orchestrator + run service).
 * Pure Supabase queries — no business logic. Summary/patch objects are built
 * by the calling service and passed in.
 *
 * INVARIANT: no function here writes `regression_runs.total_*_ms` — those are
 * owned exclusively by TestCompletionHandlerService.recomputeRunStatus()
 * (CLAUDE.md hard invariant #11). Keep it that way.
 */

export interface RunRoutingInfo {
  plan_id: string | null;
  project_id: string | null;
  user_id: string | null;
}

export interface ExecutionRef {
  id: string;
  test_case_id: string;
  test_type: string;
}

export interface FastAuthRow {
  id: string;
  fast_auth_used: boolean | null;
  fast_auth_restore_ms: number | null;
}

/**
 * plan/project/user for a run — used to resolve progress recipients.
 * Returns null when the run row is not found.
 */
export async function getRunRoutingInfo(runId: string): Promise<RunRoutingInfo | null> {
  const { data } = await supabaseAdmin
    .from('regression_runs')
    .select('plan_id, project_id, user_id')
    .eq('id', runId)
    .maybeSingle();

  return (data as RunRoutingInfo) ?? null;
}

/**
 * Preload the execution refs for a run. Surfaces the query error to the caller
 * (the orchestrator finalizes the run before bailing when this errors).
 */
export async function getExecutionRefsForRun(
  runId: string,
): Promise<{ rows: ExecutionRef[]; error: unknown }> {
  const { data, error } = await supabaseAdmin
    .from('test_executions')
    .select('id, test_case_id, test_type')
    .eq('run_id', runId);

  return { rows: (data as ExecutionRef[]) || [], error };
}

/**
 * Fast-auth telemetry for the given execution ids. Empty input → empty array.
 */
export async function getFastAuthByExecIds(execIds: string[]): Promise<FastAuthRow[]> {
  if (!execIds.length) return [];

  const { data } = await supabaseAdmin
    .from('test_executions')
    .select('id, fast_auth_used, fast_auth_restore_ms')
    .in('id', execIds);

  return (data as FastAuthRow[]) || [];
}

/**
 * Patch a regression_runs row by id. Returns the query error so the caller
 * can decide whether to log it.
 */
export async function updateRunById(
  runId: string,
  patch: Record<string, unknown>,
): Promise<{ error: unknown }> {
  const { error } = await supabaseAdmin
    .from('regression_runs')
    .update(patch)
    .eq('id', runId);

  return { error };
}

/**
 * Patch a regression_runs row by id ONLY while it is still pending/running.
 * Used to finalize a run as failed without clobbering an already-terminal
 * status (lost-update guard).
 */
export async function updateRunByIdIfActive(
  runId: string,
  patch: Record<string, unknown>,
): Promise<{ error: unknown }> {
  const { error } = await supabaseAdmin
    .from('regression_runs')
    .update(patch)
    .eq('id', runId)
    .in('status', ['pending', 'running']);

  return { error };
}

/**
 * Insert a regression_runs row. The full column payload is built by the caller
 * (run kind, status, timestamps). Returns the new id + the query error so the
 * caller can throw its own kind-specific message.
 */
export async function insertRun(
  values: Record<string, unknown>,
): Promise<{ data: { id: string } | null; error: unknown }> {
  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .insert(values)
    .select('id')
    .single();

  return { data: (data as { id: string } | null) ?? null, error };
}

export interface ZombieRunCandidate {
  id: string;
  started_at: string | null;
  pending_segments: number | null;
  last_segment_dispatched_at: string | null;
}

/**
 * Candidates for the zombie sweep: runs stuck in pending/running whose
 * chain-wide `started_at` is past the cutoff. A broad net by design — this is
 * NOT the force-fail decision. A segmented (`link_test_case`) chain can be
 * legitimately still executing despite an old `started_at` (each segment has
 * its own poll budget, and a 3+ segment chain's aggregate age easily exceeds
 * a flat cutoff) — the caller must additionally check `pending_segments` /
 * `last_segment_dispatched_at` before deciding which of these to actually
 * force-fail (ADR-0011 update 6). Returns just enough to make that decision;
 * the caller re-fetches nothing else before calling `forceFailRunsByIds`.
 */
export async function findZombieRunCandidates(
  cutoffIso: string,
): Promise<{ candidates: ZombieRunCandidate[]; error: unknown }> {
  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .select('id, started_at, pending_segments, last_segment_dispatched_at')
    .in('status', ['running', 'pending'])
    .lt('started_at', cutoffIso);

  return { candidates: (data as ZombieRunCandidate[]) || [], error };
}

/**
 * Force-fail an explicit list of run ids (the zombie sweep's own decision,
 * after filtering `findZombieRunCandidates`'s broad net). Guarded
 * (`.in('status', [...])`) — defense in depth against the same read-then-write
 * race `updateRunByIdIfActive`/`forceFailStuckTests` guard elsewhere: a run
 * could have legitimately finalized in the gap between the candidate read and
 * this write.
 */
export async function forceFailRunsByIds(
  ids: string[],
): Promise<{ ids: string[]; error: unknown }> {
  if (ids.length === 0) return { ids: [], error: null };

  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
    })
    .in('id', ids)
    .in('status', ['running', 'pending'])
    .select('id');

  return { ids: ((data as Array<{ id: string }>) || []).map((r) => r.id), error };
}

/**
 * List runs for a project (newest first) including plan name.
 */
export async function listRunsByProject(
  projectId: string,
  limit: number,
): Promise<{ data: any[] | null; error: unknown }> {
  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .select('*, regression_plans(name)')
    .eq('project_id', projectId)
    .order('started_at', { ascending: false })
    .limit(limit);

  return { data: (data as any[]) ?? null, error };
}

/**
 * Fetch execution rows for the given runs (for list-level stats + platform
 * breakdown). Empty input → empty array.
 */
export async function getRunExecutionStatsRows(runIds: string[]): Promise<any[]> {
  if (!runIds.length) return [];

  const { data } = await supabaseAdmin
    .from('test_executions')
    .select('run_id, status, duration_ms, platform, test_type')
    .in('run_id', runIds);

  return (data as any[]) || [];
}
