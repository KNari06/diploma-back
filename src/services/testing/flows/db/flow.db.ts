/**
 * Flows data-access sublayer.
 *
 * Query-builder factories for `test_flows`. Each returns the awaitable Supabase
 * query so the service keeps its own error handling, logging and row→type
 * mapping. No business logic here.
 */

import { supabaseAdmin } from '@/db/supabase';

/**
 * Project-wide flow name search (case-insensitive substring), owner-scoped.
 *
 * `test_flows` carries no `project_id`, so scope is enforced through the module
 * join (`test_modules!inner(project_id)`), mirroring how the Repository tree
 * reads a module's flows (also `user_id`-scoped). The columns match the
 * module-mode tree's flow shape so the frontend can render the results with its
 * existing row renderer.
 *
 * @param projectId - project to scope to (via the module join)
 * @param userId    - owner scope
 * @param pattern   - ilike pattern BODY with wildcards already escaped by the
 *                    caller; wrapped in `%…%` here for a substring match
 * @param limit     - max rows to return
 */
export function searchFlowsByProjectQuery(params: {
  projectId: string;
  userId: string;
  pattern: string;
  limit: number;
}) {
  const { projectId, userId, pattern, limit } = params;
  return supabaseAdmin
    .from('test_flows')
    .select(
      'id, module_id, user_id, name, description, order_index, flow_type, platform, tags, priority, mobile_variant_label, created_at, updated_at, test_modules!inner(project_id)'
    )
    .eq('user_id', userId)
    .eq('test_modules.project_id', projectId)
    .ilike('name', `%${pattern}%`)
    .order('name', { ascending: true })
    .limit(limit);
}

/**
 * Ids of the test cases belonging to a flow.
 *
 * Needed because `intent_test_cases.flow_id` is `ON DELETE SET NULL`: deleting
 * a flow does not remove its test cases, it orphans them (`flow_id = NULL`).
 * The tree is built from modules → flows → test cases, so an orphan vanishes
 * from the UI while still being returned by project-wide reads such as the
 * dependency picker's `listByProject`. The service reads these ids first so it
 * can delete the rows explicitly.
 *
 * Not `user_id`-scoped: the caller has already verified flow ownership, and a
 * row whose owner drifted from the flow's owner must still be cleaned up
 * rather than silently left behind.
 */
export function selectTestCaseIdsForFlowQuery(flowId: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .select('id')
    .eq('flow_id', flowId)
    .is('deleted_at', null);
}

/**
 * Soft-delete every test case belonging to a flow.
 *
 * A tombstone rather than a DELETE: these rows are still referenced by
 * regression plans, run history, traces and Jira links, and dropping them
 * would break that history. `deleted_at` hides them from the product while
 * keeping the references resolvable — and makes the delete reversible.
 */
export function softDeleteTestCasesForFlowQuery(flowId: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .update({ deleted_at: new Date().toISOString() })
    .eq('flow_id', flowId)
    .is('deleted_at', null);
}
