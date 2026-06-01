import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for running discovered exploration test cases.
 * Pure Supabase queries — no business logic. Callers wrap in try/catch.
 */

/**
 * Resolve an exploration's project_id, scoped to the owning user. Returns null
 * when the exploration does not exist or is not owned by the user.
 */
export async function fetchExplorationProject(
  explorationId: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('exploration_runs')
    .select('project_id')
    .eq('exploration_id', explorationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return (data?.project_id as string | undefined) ?? null;
}

/**
 * Return the subset of the given test-case ids that belong to the user within
 * the project (ownership + project scoping for the run-discovered IDOR guard).
 * One query, no N+1.
 */
export async function fetchOwnedTestCaseIds(
  testCaseIds: string[],
  projectId: string,
  userId: string,
): Promise<string[]> {
  if (testCaseIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id')
    .in('id', testCaseIds)
    .eq('project_id', projectId)
    .eq('user_id', userId);

  if (error) throw error;
  return (data || []).map((r: { id: string }) => r.id);
}
