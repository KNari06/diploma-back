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
