import { supabaseAdmin } from '@/db/supabase';
import type { NegativeMeta } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

/**
 * db/ sublayer for the negative-test domain.
 * Pure Supabase queries + row→type mapping. No business logic, no orchestration.
 * Tables: intent_test_cases (negatives + sources), regression_plan_items (toggle).
 */

// ── plan items (negative toggle) ───────────────────────────────────────────────

export interface PlanItemToggleRow {
  item_type: string;
  test_case_id: string | null;
  flow_id: string | null;
  module_id: string | null;
  negative_testing_enabled: boolean | null;
}

/** All plan items for a plan, with just the columns the toggle resolver needs. */
export async function getPlanItemsForToggle(
  planId: string,
): Promise<PlanItemToggleRow[]> {
  const { data, error } = await supabaseAdmin
    .from('regression_plan_items')
    .select('item_type, test_case_id, flow_id, module_id, negative_testing_enabled')
    .eq('plan_id', planId);

  if (error) {
    logger.error('[NEGATIVE_DB] Failed to fetch plan items', { planId, error: error.message });
    return [];
  }

  return (data || []) as PlanItemToggleRow[];
}

/** Toggle negative testing on a single plan item. Returns the updated row or null. */
export async function updatePlanItemNegativeToggle(
  planId: string,
  itemId: string,
  enabled: boolean | null,
): Promise<any | null> {
  const { data, error } = await supabaseAdmin
    .from('regression_plan_items')
    .update({ negative_testing_enabled: enabled })
    .eq('id', itemId)
    .eq('plan_id', planId)
    .select()
    .single();

  if (error || !data) {
    logger.warn('[NEGATIVE_DB] Failed to update plan item toggle', {
      planId,
      itemId,
      error: error?.message,
    });
    return null;
  }

  return data;
}

// ── source test case (happy path) ──────────────────────────────────────────────

export interface SourceTestCaseRow {
  id: string;
  name: string;
  flow_id: string | null;
  steps_json: any;
  url: string | null;
  start_url: string | null;
  project_id: string;
  // Identity fields a negative must inherit so it dispatches + runs like its
  // source. platform/replay_strategy route web vs mobile; parameters_schema +
  // resource_bindings + mobile_variant_label + triggers are read by the mobile
  // dispatch/run path — a negative missing them fails on SETUP (never reaching
  // the screen under test), not on the mutation. depends_on is intentionally
  // NOT loaded: mobile ignores it (web-only precondition inlining), and a
  // negative inheriting it would add spurious cross-run ordering constraints.
  platform: string | null;
  replay_strategy: string | null;
  parameters_schema: any;
  resource_bindings: any;
  mobile_variant_label: string | null;
  triggers: any;
}

/** Load a source (happy-path) test case for mutation generation. */
export async function getSourceTestCase(
  sourceTestCaseId: string,
): Promise<SourceTestCaseRow | null> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select(
      'id, name, flow_id, steps_json, url, start_url, project_id, ' +
        'platform, replay_strategy, parameters_schema, resource_bindings, ' +
        'mobile_variant_label, triggers',
    )
    .eq('id', sourceTestCaseId)
    .maybeSingle();

  if (error) {
    logger.error('[NEGATIVE_DB] Failed to load source test case', {
      sourceTestCaseId,
      error: error.message,
    });
    return null;
  }

  return (data as unknown as SourceTestCaseRow) || null;
}

/** Owner + project of a test case, for authorizing source-scoped operations. */
export async function getTestCaseOwner(
  testCaseId: string,
): Promise<{ userId: string; projectId: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('user_id, project_id')
    .eq('id', testCaseId)
    .maybeSingle();

  if (error || !data) {
    if (error) logger.warn('[NEGATIVE_DB] Failed owner lookup', { testCaseId, error: error.message });
    return null;
  }

  return { userId: data.user_id, projectId: data.project_id };
}

/**
 * Returns true if any of the given test cases is a mobile platform. Used to
 * gate negative GENERATION behind the paid plan (mobile RUNS are Pro-only, so
 * a free user generating mobile negatives would burn LLM cost on something they
 * can never run). Batched single query.
 */
export async function anySourceIsMobile(testCaseIds: string[]): Promise<boolean> {
  if (testCaseIds.length === 0) return false;

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id')
    .in('id', testCaseIds)
    .like('platform', 'mobile_%')
    .limit(1);

  if (error) {
    logger.warn('[NEGATIVE_DB] Failed mobile-source check', { error: error.message });
    return false;
  }

  return (data?.length || 0) > 0;
}

/** Fetch a test case name (used for progress events). */
export async function getTestCaseName(testCaseId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('name')
    .eq('id', testCaseId)
    .maybeSingle();

  if (error) {
    logger.warn('[NEGATIVE_DB] Failed to fetch test case name', {
      testCaseId,
      error: error.message,
    });
    return null;
  }

  return data?.name || null;
}

// ── negative test cases (write) ────────────────────────────────────────────────

export interface InsertNegativeInput {
  projectId: string;
  userId: string;
  name: string;
  description: string;
  url: string | null;
  startUrl: string | null;
  stepsJson: any;
  flowId: string | null;
  sourceTestCaseId: string;
  negativeMeta: NegativeMeta;
  // Identity inherited from the source so the negative dispatches + runs the
  // same way (web vs mobile routing, login/secret setup, app variant).
  platform: string;
  replayStrategy: string;
  parametersSchema: any;
  resourceBindings: any;
  mobileVariantLabel: string | null;
  triggers: any;
}

/** Insert one negative test case. Returns the new id or null on failure. */
export async function insertNegativeTestCase(
  input: InsertNegativeInput,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .insert({
      project_id: input.projectId,
      user_id: input.userId,
      name: input.name,
      description: input.description,
      status: 'published',
      kind: 'regression_member',
      url: input.url,
      start_url: input.startUrl,
      // Inherit the source's replay_strategy (web 'commands'/'steps_editor',
      // mobile 'mobile_steps'). The previous hardcoded 'steps_json' is not a
      // valid replay_strategy CHECK value and would violate the constraint.
      replay_strategy: input.replayStrategy,
      steps_json: input.stepsJson,
      flow_id: input.flowId,
      is_negative: true,
      source_intent_test_case_id: input.sourceTestCaseId,
      negative_meta: input.negativeMeta,
      // Inherited identity. platform routes the dispatch (web vs mobile);
      // parameters_schema lets unmutated {{param_*}} steps resolve;
      // resource_bindings carries login/secret setup; mobile_variant_label
      // pins the same app build; triggers carries event→action rules.
      // resource_bindings + triggers are NOT NULL (default []) — coalesce.
      platform: input.platform,
      parameters_schema: input.parametersSchema ?? null,
      resource_bindings: input.resourceBindings ?? [],
      mobile_variant_label: input.mobileVariantLabel ?? null,
      triggers: input.triggers ?? [],
    })
    .select('id')
    .single();

  if (error || !data) {
    logger.error('[NEGATIVE_DB] Failed to insert negative test case', {
      sourceTestCaseId: input.sourceTestCaseId,
      error: error?.message,
    });
    return null;
  }

  return data.id;
}

/** Delete all negatives derived from a source. Returns the deleted count. */
export async function deleteNegativesBySource(sourceTestCaseId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .delete()
    .eq('source_intent_test_case_id', sourceTestCaseId)
    .eq('is_negative', true)
    .select('id');

  if (error) {
    logger.error('[NEGATIVE_DB] Failed to delete existing negatives', {
      sourceTestCaseId,
      error: error.message,
    });
    return 0;
  }

  return data?.length || 0;
}

// ── negative test cases (read) ─────────────────────────────────────────────────

/**
 * Set of source ids that already have at least one fresh (non-stale) negative.
 * Batched — used by the estimate to find which sources still need generation.
 */
export async function getSourcesWithFreshNegatives(
  sourceTestCaseIds: string[],
): Promise<Set<string>> {
  if (sourceTestCaseIds.length === 0) return new Set();

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('source_intent_test_case_id')
    .eq('is_negative', true)
    .is('negative_stale_reason', null)
    .in('source_intent_test_case_id', sourceTestCaseIds);

  if (error || !data) {
    if (error) logger.warn('[NEGATIVE_DB] Failed sources-with-fresh lookup', { error: error.message });
    return new Set();
  }

  return new Set(data.map((r) => r.source_intent_test_case_id).filter(Boolean));
}

/** Count fresh (non-stale) negatives for a source. */
export async function countFreshNegatives(sourceTestCaseId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id', { count: 'exact', head: true })
    .eq('source_intent_test_case_id', sourceTestCaseId)
    .eq('is_negative', true)
    .is('negative_stale_reason', null);

  return count || 0;
}

export interface NegativeRow {
  id: string;
  name: string;
  flow_id: string | null;
  source_intent_test_case_id: string;
  negative_meta: any;
}

/**
 * Fetch RUNNABLE negatives for the given source ids (used at run-expansion):
 * fresh (not stale) AND enabled. Both gates must pass for a negative to run.
 */
export async function getFreshNegativesBySources(
  sourceTestCaseIds: string[],
): Promise<NegativeRow[]> {
  if (sourceTestCaseIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, flow_id, source_intent_test_case_id, negative_meta')
    .eq('is_negative', true)
    .is('negative_stale_reason', null)
    .eq('negative_enabled', true)
    .in('source_intent_test_case_id', sourceTestCaseIds);

  if (error) {
    logger.error('[NEGATIVE_DB] Failed to fetch runnable negatives by sources', {
      error: error.message,
    });
    return [];
  }

  return (data || []) as NegativeRow[];
}

/** List ALL negatives (fresh + stale) for the given sources, for display. */
export async function listNegativesBySources(
  sourceTestCaseIds: string[],
): Promise<any[]> {
  if (sourceTestCaseIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, source_intent_test_case_id, negative_meta, negative_stale_reason, negative_enabled, created_at')
    .eq('is_negative', true)
    .in('source_intent_test_case_id', sourceTestCaseIds)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('[NEGATIVE_DB] Failed to list negatives by sources', { error: error.message });
    return [];
  }

  return data || [];
}

// ── per-negative control (delete / enable-toggle) ──────────────────────────────

/**
 * Look up a single negative's owner + source, scoped to user. Used to authorize
 * delete / toggle by negativeId without trusting the client's source/plan.
 */
export async function getNegativeOwnership(
  negativeId: string,
): Promise<{ id: string; userId: string; projectId: string | null; sourceTestCaseId: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, user_id, project_id, source_intent_test_case_id')
    .eq('id', negativeId)
    .eq('is_negative', true)
    .maybeSingle();

  if (error || !data) {
    if (error) logger.warn('[NEGATIVE_DB] Failed ownership lookup', { negativeId, error: error.message });
    return null;
  }

  return {
    id: data.id,
    userId: data.user_id,
    projectId: data.project_id,
    sourceTestCaseId: data.source_intent_test_case_id,
  };
}

/** Delete one negative by id. Returns true when a row was removed. */
export async function deleteNegativeById(negativeId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .delete()
    .eq('id', negativeId)
    .eq('is_negative', true)
    .select('id');

  if (error) {
    logger.error('[NEGATIVE_DB] Failed to delete negative', { negativeId, error: error.message });
    return false;
  }

  return (data?.length || 0) > 0;
}

/** Enable/disable one negative (kept in DB either way). Returns true on success. */
export async function setNegativeEnabled(negativeId: string, enabled: boolean): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .update({ negative_enabled: enabled })
    .eq('id', negativeId)
    .eq('is_negative', true)
    .select('id');

  if (error) {
    logger.error('[NEGATIVE_DB] Failed to set negative enabled', { negativeId, enabled, error: error.message });
    return false;
  }

  return (data?.length || 0) > 0;
}

// ── bulk control (toggle / delete many) ────────────────────────────────────────

/**
 * Batch ownership lookup for many negatives. Returns one row per existing
 * negative id (missing ids simply absent). The bulk service uses this to
 * authorize per-id by project BEFORE mutating — a bulk request may span
 * negatives from different projects, so we never trust the id list blindly.
 */
export async function getNegativesOwnership(
  negativeIds: string[],
): Promise<Array<{ id: string; projectId: string | null }>> {
  if (negativeIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, project_id')
    .eq('is_negative', true)
    .in('id', negativeIds);

  if (error || !data) {
    if (error) logger.warn('[NEGATIVE_DB] Failed bulk ownership lookup', { error: error.message });
    return [];
  }

  return data.map((r) => ({ id: r.id, projectId: r.project_id }));
}

/** Enable/disable many negatives by id. Returns the count actually updated. */
export async function setNegativeEnabledByIds(negativeIds: string[], enabled: boolean): Promise<number> {
  if (negativeIds.length === 0) return 0;

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .update({ negative_enabled: enabled })
    .eq('is_negative', true)
    .in('id', negativeIds)
    .select('id');

  if (error) {
    logger.error('[NEGATIVE_DB] Failed bulk set-enabled', { count: negativeIds.length, enabled, error: error.message });
    return 0;
  }

  return data?.length || 0;
}

/** Delete many negatives by id. Returns the count actually removed. */
export async function deleteNegativesByIds(negativeIds: string[]): Promise<number> {
  if (negativeIds.length === 0) return 0;

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .delete()
    .eq('is_negative', true)
    .in('id', negativeIds)
    .select('id');

  if (error) {
    logger.error('[NEGATIVE_DB] Failed bulk delete', { count: negativeIds.length, error: error.message });
    return 0;
  }

  return data?.length || 0;
}

// ── estimate inputs ─────────────────────────────────────────────────────────────

/**
 * Average per-test wall-clock (ms) over recent executions of the given test
 * cases. Used to estimate how much time pending negatives add to a run.
 * Returns null when there is no execution history.
 */
export async function getAvgDurationMsForTestCases(
  testCaseIds: string[],
): Promise<number | null> {
  if (testCaseIds.length === 0) return null;

  const { data, error } = await supabaseAdmin
    .from('test_executions')
    .select('duration_ms, test_case_id')
    .in('test_case_id', testCaseIds)
    .not('duration_ms', 'is', null)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error || !data || data.length === 0) {
    if (error) logger.warn('[NEGATIVE_DB] Failed avg-duration lookup', { error: error.message });
    return null;
  }

  const durations = data.map((r) => r.duration_ms as number).filter((d) => typeof d === 'number');
  if (durations.length === 0) return null;
  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
}

/** List negatives for a single source, mapped to typed metadata. */
export async function getNegativesForSource(
  sourceTestCaseId: string,
): Promise<Array<{ id: string; name: string; negativeMeta: NegativeMeta; staleReason: string | null }>> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, negative_meta, negative_stale_reason')
    .eq('source_intent_test_case_id', sourceTestCaseId)
    .eq('is_negative', true)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('[NEGATIVE_DB] Failed to fetch negatives for source', {
      sourceTestCaseId,
      error: error.message,
    });
    return [];
  }

  return (data || []).map((row) => ({
    id: row.id,
    name: row.name,
    negativeMeta: row.negative_meta as NegativeMeta,
    staleReason: row.negative_stale_reason,
  }));
}
