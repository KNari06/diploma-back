import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for running discovered exploration test cases.
 * Pure Supabase queries — no business logic. Callers wrap in try/catch.
 */

/**
 * Resolve an exploration's owning project WITHOUT scoping to a user.
 *
 * Deliberately unscoped: the caller gates on `hasProjectAccess` (owner OR
 * workspace member) instead. Filtering by `user_id` here would make the run
 * invisible to the teammate who can legitimately see the project — and
 * `/explorations/start` already authorizes by WORKSPACE, so a member could
 * start a run and then 404 on its own results.
 *
 * This function performs NO authorization. Every caller must pass the returned
 * projectId through the access gate before returning any row to the requester.
 */
export async function fetchExplorationProjectUnscoped(
  explorationId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('exploration_runs')
    .select('project_id')
    .eq('exploration_id', explorationId)
    .maybeSingle();

  if (error) throw error;
  return (data?.project_id as string | undefined) ?? null;
}

/**
 * Project ids in a workspace that the caller may read. Used by the list
 * endpoint's workspace filter, which previously took `workspaceId` straight
 * from the query string and only narrowed by `user_id` — safe by accident.
 * Membership is verified by the caller BEFORE this runs.
 */
export async function fetchWorkspaceProjectIds(workspaceId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('workspace_id', workspaceId);

  if (error) throw error;
  return (data || []).map((r: { id: string }) => r.id);
}

/**
 * Return the subset of the given test-case ids that live in the project — the
 * run-discovered IDOR guard. One query, no N+1.
 *
 * Scoped to the PROJECT, not to a user: discovered cases are written under the
 * id of whoever started the exploration, so an owner filter returns nothing for
 * a teammate who can legitimately see the project. The project bound is what
 * stops a caller smuggling in an id from somewhere else; the caller must have
 * already passed `hasProjectAccess` for that projectId.
 */
export async function fetchAccessibleTestCaseIds(
  testCaseIds: string[],
  projectId: string,
): Promise<string[]> {
  if (testCaseIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id')
    .in('id', testCaseIds)
    .eq('project_id', projectId);

  if (error) throw error;
  return (data || []).map((r: { id: string }) => r.id);
}
