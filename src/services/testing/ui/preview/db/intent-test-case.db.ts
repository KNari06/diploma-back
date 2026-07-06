/**
 * intent-test-case db sublayer
 *
 * All Supabase reads/writes for `IntentTestCaseService`. Queries + row shape
 * only — NO business logic, NO orchestration, NO service imports. Each function
 * returns the awaitable Supabase query so the service keeps its existing
 * error-handling, logging, and merge logic unchanged (see architecture.md
 * "The db/ sublayer"). Row → `IntentTestCase` mapping stays in the service
 * (`mapToIntentTestCase`).
 */

import { supabaseAdmin } from '@/db/supabase';
import type { IntentStep } from '../preview.types';

// ── projects (access check) ──────────────────────────────────────────────────

/** `projects.workspace_id` for a project (drives `canWriteTestCase`). */
export function getProjectWorkspaceRow(projectId: string) {
  return supabaseAdmin
    .from('projects')
    .select('workspace_id')
    .eq('id', projectId)
    .maybeSingle();
}

// ── intent_test_cases: create / read ─────────────────────────────────────────

/** Insert a fully-built row, returning the inserted record. */
export function insertTestCaseRow(insert: Record<string, unknown>) {
  return supabaseAdmin
    .from('intent_test_cases')
    .insert(insert)
    .select('*')
    .single();
}

/** Owner-scoped single fetch (joins flow name). */
export function getTestCaseRowByIdForUser(id: string, userId: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .select('*, test_flows(name)')
    .eq('id', id)
    .eq('user_id', userId)
    .single();
}

/** Unscoped single fetch by id (internal runtime use). */
export function getTestCaseRowByIdInternal(id: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .select('*')
    .eq('id', id)
    .single();
}

/** id + name pairs for dependency-name resolution. */
export function getTestCaseNamesByIds(ids: string[]) {
  return supabaseAdmin
    .from('intent_test_cases')
    .select('id, name')
    .in('id', ids);
}

/** One depth level of the dependency closure (id, depends_on, steps_json). */
export function getDependencyClosureRows(ids: string[]) {
  return supabaseAdmin
    .from('intent_test_cases')
    .select('id, depends_on, steps_json')
    .in('id', ids);
}

/**
 * Every case in a project's (id, depends_on, steps_json) — the full graph
 * needed for combined dependsOn + link_test_case cycle detection (see
 * utils/graph/link-graph.ts). Unlike `getDependencyClosureRows`, this is not
 * scoped to a known id list — cycle checks need the whole project's edges,
 * not just one node's closure.
 */
export function getProjectGraphRows(projectId: string, userId: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .select('id, depends_on, steps_json')
    .eq('project_id', projectId)
    .eq('user_id', userId);
}

/** Owner-scoped exact count for a project (+ optional flow filter). */
export function countTestCaseRowsForProject(projectId: string, userId: string, flowId?: string) {
  let q = supabaseAdmin
    .from('intent_test_cases')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('user_id', userId);
  if (flowId) q = q.eq('flow_id', flowId);
  return q;
}

/** Owner-scoped page of rows for a project (+ optional flow filter), newest first. */
export function listTestCaseDataForProject(
  projectId: string,
  userId: string,
  flowId: string | undefined,
  limit: number,
  offset: number,
) {
  let q = supabaseAdmin
    .from('intent_test_cases')
    .select('*, test_flows(name)')
    .eq('project_id', projectId)
    .eq('user_id', userId);
  if (flowId) q = q.eq('flow_id', flowId);
  return q.order('updated_at', { ascending: false }).range(offset, offset + limit - 1);
}

/** steps_json only (update-merge read). */
export function getStepsJsonRow(id: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .select('steps_json')
    .eq('id', id)
    .single();
}

/** steps_json + ownership fields in one round-trip (heal / preview-apply access gate). */
export function getStepsJsonWithOwnerRow(id: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .select('steps_json, user_id, project_id')
    .eq('id', id)
    .single();
}

/** flow_id + project_id for cache invalidation before delete (owner-scoped). */
export function getTestCaseFlowProjectForUser(id: string, userId: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .select('flow_id, project_id')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
}

// ── intent_test_cases: write / delete ────────────────────────────────────────

/** Owner-scoped full update, returning the updated row. */
export function updateTestCaseRowForUser(id: string, userId: string, updates: Record<string, unknown>) {
  return supabaseAdmin
    .from('intent_test_cases')
    .update(updates)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single();
}

/** Overwrite steps_json without touching updated_at (heal path). */
export function updateStepsJsonRow(id: string, steps: IntentStep[]) {
  return supabaseAdmin
    .from('intent_test_cases')
    .update({ steps_json: steps })
    .eq('id', id);
}

/** Overwrite steps_json and bump updated_at (preview-apply / batch paths). */
export function updateStepsJsonTouchRow(id: string, steps: IntentStep[]) {
  return supabaseAdmin
    .from('intent_test_cases')
    .update({ steps_json: steps, updated_at: new Date().toISOString() })
    .eq('id', id);
}

/** Owner-scoped delete of the test case row. */
export function deleteTestCaseRowForUser(id: string, userId: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
}

/** Mark every fresh negative derived from a parent case as stale. */
export function markNegativesStaleByParent(sourceTestCaseId: string) {
  return supabaseAdmin
    .from('intent_test_cases')
    .update({
      negative_stale_reason: 'parent_steps_changed',
      updated_at: new Date().toISOString(),
    })
    .eq('source_intent_test_case_id', sourceTestCaseId)
    .eq('is_negative', true)
    .is('negative_stale_reason', null);
}

// ── regression_plan_items ────────────────────────────────────────────────────

/** Detach a test case from every regression plan it belongs to. */
export function deletePlanItemsForTestCase(testCaseId: string) {
  return supabaseAdmin
    .from('regression_plan_items')
    .delete()
    .eq('test_case_id', testCaseId);
}
