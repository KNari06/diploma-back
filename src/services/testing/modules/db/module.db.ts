/**
 * db/ sublayer for the test-modules domain.
 * Pure Supabase queries + row→type mapping. No business logic, no orchestration.
 * Table: test_modules (self-referential via parent_module_id).
 */

import { supabaseAdmin } from '@/db/supabase';
import type { PlatformKey, Priority, TestModule } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

// LEFT join: a module's platform_id may be NULL (platform-agnostic folder).
// An inner join would silently drop those rows from every read below.
const MODULE_SELECT = '*, test_platforms(platform_key)';
// Inner variant only for the platformKey-filtered list path, where filtering on
// the embedded column must actually exclude non-matching (and NULL) rows.
const MODULE_SELECT_PLATFORM_FILTERED = '*, test_platforms!inner(platform_key)';

/** Map a test_modules row (with joined platform_key) to the TestModule type. */
export function mapModuleRow(row: any): TestModule {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    platformId: row.platform_id,
    platformKey: row.test_platforms?.platform_key || undefined,
    parentModuleId: row.parent_module_id ?? null,
    name: row.name,
    description: row.description || undefined,
    tags: row.tags || [],
    priority: row.priority || undefined,
    orderIndex: typeof row.order_index === 'number' ? row.order_index : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── writes ──────────────────────────────────────────────────────────────────

export interface InsertModuleRow {
  project_id: string;
  user_id: string;
  /** NULL = platform-agnostic folder (platform lives on the test, not the folder). */
  platform_id: string | null;
  parent_module_id: string | null;
  name: string;
  description: string | null;
  tags: string[];
  priority: Priority | null;
}

/** Insert a module and return it (with joined platform_key). */
export async function insertModule(row: InsertModuleRow): Promise<TestModule> {
  const { data, error } = await supabaseAdmin
    .from('test_modules')
    .insert(row)
    .select(MODULE_SELECT)
    .single();

  if (error) {
    logger.error('[MODULE_DB] Failed to insert module', { error });
    throw new Error(`Failed to create module: ${error.message}`);
  }

  return mapModuleRow(data);
}

/** Apply a partial column update to a module and return the updated row. */
export async function updateModuleRow(
  id: string,
  userId: string,
  updates: Record<string, unknown>,
): Promise<TestModule> {
  const { data, error } = await supabaseAdmin
    .from('test_modules')
    .update(updates)
    .eq('id', id)
    .eq('user_id', userId)
    .select(MODULE_SELECT)
    .single();

  if (error) {
    logger.error('[MODULE_DB] Failed to update module', { error, id });
    throw new Error(`Failed to update module: ${error.message}`);
  }

  return mapModuleRow(data);
}

/**
 * Test case ids owned by any of `moduleIds`, resolved through their flows.
 *
 * `intent_test_cases.flow_id` is ON DELETE SET NULL while
 * `test_flows.module_id` is ON DELETE CASCADE, so deleting a module wipes its
 * flows in the database and leaves their test cases behind with a NULL
 * flow_id. Those orphans vanish from the repository tree (modules → flows →
 * test cases) yet keep surfacing in project-wide reads such as the dependency
 * picker. The service resolves the ids up front so it can delete the rows
 * before the cascade erases the link.
 *
 * Two hops rather than a join: the ids feed a delete that must not depend on
 * the flow rows still existing.
 */
export async function getTestCaseIdsForModules(moduleIds: string[]): Promise<string[]> {
  if (moduleIds.length === 0) return [];

  const { data: flowRows, error: flowError } = await supabaseAdmin
    .from('test_flows')
    .select('id')
    .in('module_id', moduleIds);

  if (flowError) {
    logger.error('[MODULE_DB] Failed to read flows for modules', { error: flowError });
    throw new Error(`Failed to read module flows: ${flowError.message}`);
  }

  const flowIds = (flowRows || []).map((r: any) => r.id);
  if (flowIds.length === 0) return [];

  const { data: caseRows, error: caseError } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id')
    .in('flow_id', flowIds)
    .is('deleted_at', null);

  if (caseError) {
    logger.error('[MODULE_DB] Failed to read test cases for modules', { error: caseError });
    throw new Error(`Failed to read module test cases: ${caseError.message}`);
  }

  return (caseRows || []).map((r: any) => r.id);
}

/**
 * Soft-delete test cases by id.
 *
 * A tombstone rather than a DELETE: these rows are still referenced by
 * regression plans, run history, traces and Jira links, and dropping them
 * would break that history. `deleted_at` hides them from the product while
 * keeping the references resolvable — and makes the delete reversible.
 *
 * Regression plan items are deliberately left alone for the same reason: the
 * row they point at still exists, so the plan stays readable instead of
 * silently losing entries.
 */
export async function softDeleteTestCasesByIds(testCaseIds: string[]): Promise<void> {
  if (testCaseIds.length === 0) return;

  const { error } = await supabaseAdmin
    .from('intent_test_cases')
    .update({ deleted_at: new Date().toISOString() })
    .in('id', testCaseIds)
    .is('deleted_at', null);

  if (error) {
    logger.error('[MODULE_DB] Failed to soft-delete test cases', {
      error, count: testCaseIds.length,
    });
    throw new Error(`Failed to delete module test cases: ${error.message}`);
  }
}

/** Delete a module by id (subtree + flows cascade via FKs). */
export async function deleteModuleRow(id: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('test_modules')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);

  if (error) {
    logger.error('[MODULE_DB] Failed to delete module', { error, id });
    throw new Error(`Failed to delete module: ${error.message}`);
  }
}

/**
 * Set order_index for a batch of sibling modules (project-scoped). Folders are
 * platform-agnostic, so ordering is scoped by project + owner, not platform.
 */
export async function setModuleOrderIndexes(
  moduleIds: string[],
  projectId: string,
  userId: string,
): Promise<void> {
  const updates = moduleIds.map((moduleId, index) =>
    supabaseAdmin
      .from('test_modules')
      .update({ order_index: index })
      .eq('id', moduleId)
      .eq('project_id', projectId)
      .eq('user_id', userId),
  );

  const results = await Promise.all(updates);
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    logger.error('[MODULE_DB] Failed to reorder some modules', {
      errors: errors.map((e) => e.error),
    });
    throw new Error('Failed to reorder modules');
  }
}

// ── reads ───────────────────────────────────────────────────────────────────

/** Full module by id (owner-scoped), or null if not found. */
export async function getModuleById(id: string, userId: string): Promise<TestModule | null> {
  const { data, error } = await supabaseAdmin
    .from('test_modules')
    .select(MODULE_SELECT)
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[MODULE_DB] Failed to get module', { error, id });
    throw new Error(`Failed to get module: ${error.message}`);
  }

  return mapModuleRow(data);
}

/** Minimal shape used by the nesting validation walks (up the parent chain). */
export interface ModuleCoreRow {
  id: string;
  parentModuleId: string | null;
  platformId: string | null;
  projectId: string;
}

/** Lightweight lookup (no platform join) for depth/cycle validation. */
export async function getModuleCore(id: string, userId: string): Promise<ModuleCoreRow | null> {
  const { data, error } = await supabaseAdmin
    .from('test_modules')
    .select('id, parent_module_id, platform_id, project_id')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[MODULE_DB] Failed to get module core', { error, id });
    throw new Error(`Failed to get module: ${error.message}`);
  }

  return {
    id: data.id,
    parentModuleId: data.parent_module_id ?? null,
    platformId: data.platform_id ?? null,
    projectId: data.project_id,
  };
}

/** project_id for a module (used for cache invalidation before delete). */
export async function getModuleProjectId(id: string, userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('test_modules')
    .select('project_id')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  return data?.project_id ?? null;
}

/** Direct child module ids of a parent (owner-scoped). Used for subtree walks. */
export async function getChildModuleIds(parentId: string, userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('test_modules')
    .select('id')
    .eq('parent_module_id', parentId)
    .eq('user_id', userId);

  if (error) {
    logger.error('[MODULE_DB] Failed to get child modules', { error, parentId });
    throw new Error(`Failed to get child modules: ${error.message}`);
  }

  return (data || []).map((r: any) => r.id);
}

export interface ListModuleOptions {
  limit?: number;
  offset?: number;
  platformId?: string;
  platformKey?: PlatformKey;
  /** undefined = no parent filter; null = top-level only; string = children of. */
  parentModuleId?: string | null;
}

/**
 * Paginated project modules with total count. Applies platform + optional
 * parent filter. Sorted order_index ASC (nulls last), then created_at DESC.
 */
export async function listModules(
  projectId: string,
  userId: string,
  options: ListModuleOptions = {},
): Promise<{ items: TestModule[]; total: number }> {
  const { limit = 50, offset = 0, platformId, platformKey, parentModuleId } = options;

  let countQuery = supabaseAdmin
    .from('test_modules')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('user_id', userId);

  // When filtering by platformKey we must use the inner-join select so the
  // embedded-column filter actually excludes non-matching / NULL-platform rows.
  let itemsQuery = supabaseAdmin
    .from('test_modules')
    .select(platformKey ? MODULE_SELECT_PLATFORM_FILTERED : MODULE_SELECT)
    .eq('project_id', projectId)
    .eq('user_id', userId);

  if (platformId) {
    countQuery = countQuery.eq('platform_id', platformId);
    itemsQuery = itemsQuery.eq('platform_id', platformId);
  }
  if (platformKey) {
    itemsQuery = itemsQuery.eq('test_platforms.platform_key', platformKey);
  }
  if (parentModuleId === null) {
    countQuery = countQuery.is('parent_module_id', null);
    itemsQuery = itemsQuery.is('parent_module_id', null);
  } else if (typeof parentModuleId === 'string') {
    countQuery = countQuery.eq('parent_module_id', parentModuleId);
    itemsQuery = itemsQuery.eq('parent_module_id', parentModuleId);
  }

  const [countResult, itemsResult] = await Promise.all([
    countQuery,
    itemsQuery
      .order('order_index', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1),
  ]);

  if (countResult.error) {
    logger.error('[MODULE_DB] Failed to count modules', { error: countResult.error });
    throw new Error(`Failed to list modules: ${countResult.error.message}`);
  }
  if (itemsResult.error) {
    logger.error('[MODULE_DB] Failed to list modules', { error: itemsResult.error });
    throw new Error(`Failed to list modules: ${itemsResult.error.message}`);
  }

  return {
    items: (itemsResult.data || []).map(mapModuleRow),
    total: countResult.count || 0,
  };
}

export interface PlatformModuleTreeRow {
  id: string;
  platformId: string | null;
  platformKey?: PlatformKey;
  parentModuleId: string | null;
  name: string;
  description?: string;
  priority?: string;
  orderIndex: number | null;
}

/** A flow's coarse platform bucket for a module (used by tab filtering). */
export interface FlowPlatformRow {
  moduleId: string;
  platform: string | null;
  flowType: string | null;
}

/**
 * Direct flows' platform/flow_type for a set of modules (owner-scoped). The
 * tree service buckets these into coarse platform kinds (web_ui/mobile/api) so
 * the Repository tabs can hide folders that hold no matching test.
 */
export async function getFlowPlatformsByModuleIds(
  moduleIds: string[],
  userId: string,
): Promise<FlowPlatformRow[]> {
  if (moduleIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('test_flows')
    .select('module_id, platform, flow_type')
    .in('module_id', moduleIds)
    .eq('user_id', userId);

  if (error) {
    logger.error('[MODULE_DB] Failed to get flow platforms by module ids', { error });
    throw new Error(`Failed to get flow platforms: ${error.message}`);
  }

  return (data || []).map((r: any) => ({
    moduleId: r.module_id,
    platform: r.platform ?? null,
    flowType: r.flow_type ?? null,
  }));
}

/**
 * ALL modules for a project (owner-scoped), unpaginated, for building the
 * project-level folder forest. Folders are platform-agnostic, so this is NOT
 * filtered by platform — a folder's platform_id may be NULL. LEFT-joins the
 * platform_key so a folder that still carries a platform reports it.
 * Sorted order_index ASC (nulls last), created_at DESC.
 */
export async function getProjectModulesForTree(
  projectId: string,
  userId: string,
): Promise<PlatformModuleTreeRow[]> {
  const { data, error } = await supabaseAdmin
    .from('test_modules')
    .select('id, platform_id, parent_module_id, name, description, priority, order_index, created_at, test_platforms(platform_key)')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .order('order_index', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('[MODULE_DB] Failed to get project modules for tree', { error, projectId });
    throw new Error(`Failed to get modules: ${error.message}`);
  }

  return (data || []).map((m: any) => ({
    id: m.id,
    platformId: m.platform_id ?? null,
    platformKey: m.test_platforms?.platform_key || undefined,
    parentModuleId: m.parent_module_id ?? null,
    name: m.name,
    description: m.description || undefined,
    priority: m.priority || undefined,
    orderIndex: typeof m.order_index === 'number' ? m.order_index : null,
  }));
}

