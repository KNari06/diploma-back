/**
 * Flow Service
 * CRUD operations for test flows
 */

import { supabaseAdmin } from '@/db/supabase';
import type {
    CreateTestFlowParams,
    TestFlow,
    UpdateTestFlowParams,
} from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { normaliseVariantOverride, normaliseHostOverride } from '@/services/mobile/project-mobile-app.helper';

/**
 * Service for managing test flows
 * Flows represent scenarios within a module (Happy path, Error handling)
 */
export class FlowService {
  /**
   * Create a new test flow
   * @param params - Flow creation parameters
   * @returns Created flow
   */
  static async create(params: CreateTestFlowParams): Promise<TestFlow> {
    const {
      moduleId,
      userId,
      name,
      orderIndex,
      flowType,
      platform,
      tags,
      priority,
      preconditions,
      expectedResult,
      mobileVariantLabel,
    } = params;
    const normalizedVariant = normaliseVariantOverride(mobileVariantLabel);

    logger.info('[FLOW_SERVICE] Creating flow', {
      moduleId,
      userId,
      name,
    });

    // order_index stays NULL unless the caller explicitly sets one. NULL means
    // "not manually ordered" → the flow sorts by created_at DESC (newest-first).
    // It only gets a value when the user drags to reorder (FlowService.reorder).
    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .insert({
        module_id: moduleId,
        user_id: userId,
        name,
        order_index: orderIndex ?? null,
        flow_type: flowType || 'ui',
        platform: platform || null,
        tags: tags || [],
        priority: priority || null,
        preconditions: preconditions || [],
        expected_result: expectedResult || null,
        mobile_variant_label: normalizedVariant,
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[FLOW_SERVICE] Failed to create flow', { error });
      throw new Error(`Failed to create flow: ${error.message}`);
    }

    // Invalidate module mode cache (flow list changed)
    await cache.delByPattern(`qait:cache:ptree:module:${moduleId}:*`);

    return this.mapToTestFlow(data);
  }

  /**
   * Get a flow by ID
   * @param id - Flow ID
   * @param userId - User ID for access control
   * @returns Flow or null if not found
   */
  static async getById(id: string, userId: string): Promise<TestFlow | null> {
    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('[FLOW_SERVICE] Failed to get flow', { error, id });
      throw new Error(`Failed to get flow: ${error.message}`);
    }

    return this.mapToTestFlow(data);
  }

  /**
   * List flows for a module
   * @param moduleId - Module ID
   * @param userId - User ID for access control
   * @returns List of flows ordered by order_index
   */
  static async listByModule(
    moduleId: string,
    userId: string
  ): Promise<TestFlow[]> {
    // Manually-ordered flows (non-NULL order_index) first, ascending; the rest
    // (NULL) newest-first by created_at. nullsFirst:false puts NULLs last.
    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .select('*')
      .eq('module_id', moduleId)
      .eq('user_id', userId)
      .order('order_index', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[FLOW_SERVICE] Failed to list flows', { error, moduleId });
      throw new Error(`Failed to list flows: ${error.message}`);
    }

    const flows = (data || []).map(this.mapToTestFlow);

    // Surface each flow's Flutter host override for the per-flow host control +
    // iOS badge. Host lives on `intent_test_cases.host_platform` (a flow's test
    // cases share one host — writes go to all of them), so one batched read maps
    // flow_id → host. Best-effort: a failure just leaves the badge/control at
    // "inherit" (null), never breaks the list.
    const flowIds = flows.map((f) => f.id);
    if (flowIds.length > 0) {
      const { data: tcRows, error: tcErr } = await supabaseAdmin
        .from('intent_test_cases')
        .select('flow_id, host_platform')
        .in('flow_id', flowIds)
        .eq('user_id', userId)
        // A flow's cases share one host (the write path enforces it); order for
        // a deterministic pick if a legacy/drifted flow ever has mixed hosts.
        .order('created_at', { ascending: true });
      if (tcErr) {
        logger.warn('[FLOW_SERVICE] Failed to load per-flow host overrides (non-fatal)', {
          error: tcErr.message,
          moduleId,
        });
      } else {
        const hostByFlow = new Map<string, 'android' | 'ios'>();
        for (const row of tcRows || []) {
          const host = normaliseHostOverride((row as { host_platform?: unknown }).host_platform);
          const fid = (row as { flow_id?: string }).flow_id;
          if (host && fid && !hostByFlow.has(fid)) hostByFlow.set(fid, host);
        }
        for (const f of flows) f.hostPlatform = hostByFlow.get(f.id) ?? null;
      }
    }

    return flows;
  }

  /**
   * Set (or clear) the Flutter host override for every test case in a flow.
   * Host is a per-test-case column (`intent_test_cases.host_platform`), but the
   * UI is per-flow, so a flow's choice applies to all its test cases. `null`
   * clears the override → inherit the project default. Best-effort at the call
   * site (the flow update itself already succeeded).
   */
  static async setHostPlatformByFlow(
    flowId: string,
    userId: string,
    host: 'android' | 'ios' | null,
  ): Promise<void> {
    const normalized = normaliseHostOverride(host);
    const { error } = await supabaseAdmin
      .from('intent_test_cases')
      .update({ host_platform: normalized })
      .eq('flow_id', flowId)
      .eq('user_id', userId);
    if (error) {
      logger.warn('[FLOW_SERVICE] Failed to set per-flow host override', {
        error: error.message,
        flowId,
        host: normalized,
      });
      throw new Error(`Failed to set flow host: ${error.message}`);
    }
  }

  /**
   * Update a flow
   * @param params - Update parameters
   * @returns Updated flow
   */
  static async update(params: UpdateTestFlowParams): Promise<TestFlow> {
    const {
      id,
      userId,
      name,
      moduleId,
      orderIndex,
      flowType,
      platform,
      tags,
      priority,
      preconditions,
      expectedResult,
      mobileVariantLabel,
    } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (moduleId !== undefined) updates.module_id = moduleId;
    if (orderIndex !== undefined) updates.order_index = orderIndex;
    if (flowType !== undefined) updates.flow_type = flowType;
    if (platform !== undefined) updates.platform = platform;
    if (tags !== undefined) updates.tags = tags;
    if (priority !== undefined) updates.priority = priority;
    if (preconditions !== undefined) updates.preconditions = preconditions;
    if (expectedResult !== undefined) updates.expected_result = expectedResult;
    if (mobileVariantLabel !== undefined) {
      updates.mobile_variant_label = normaliseVariantOverride(mobileVariantLabel);
    }

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update');
    }

    // When renaming, read the OLD flow name first so we can cascade the rename
    // to the flow's intent_test_cases that were in lockstep with it (see below).
    // When moving (moduleId changes), also capture the OLD module_id so we can
    // bust its cached subtree too — otherwise the source folder keeps showing
    // the moved flow until its cache expires.
    let previousName: string | undefined;
    let previousModuleId: string | undefined;
    if (name !== undefined || moduleId !== undefined) {
      const { data: prev } = await supabaseAdmin
        .from('test_flows')
        .select('name, module_id')
        .eq('id', id)
        .eq('user_id', userId)
        .single();
      previousName = prev?.name ?? undefined;
      previousModuleId = prev?.module_id ?? undefined;
    }

    logger.info('[FLOW_SERVICE] Updating flow', {
      id,
      updatedFields: Object.keys(updates),
    });

    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) {
      logger.error('[FLOW_SERVICE] Failed to update flow', { error, id });
      throw new Error(`Failed to update flow: ${error.message}`);
    }

    // Cascade the rename to the flow's intent_test_cases. A flow and its test
    // case(s) are created with the SAME name, and the editor breadcrumb collapses
    // to one segment while they match; renaming only the flow row left the test
    // case on its old name (e.g. "Billz #2 > Billz"). We rename only the test
    // cases whose current name still equals the flow's OLD name, so a test case
    // the user deliberately renamed to something else is never clobbered.
    // Best-effort: a failure here is logged, not thrown — the flow rename stands.
    if (name !== undefined && previousName !== undefined && previousName !== name) {
      const { error: tcErr } = await supabaseAdmin
        .from('intent_test_cases')
        .update({ name })
        .eq('flow_id', id)
        .eq('user_id', userId)
        .eq('name', previousName);

      if (tcErr) {
        logger.warn('[FLOW_SERVICE] Flow renamed but test-case cascade failed', {
          id,
          error: tcErr.message,
        });
      }
    }

    // Invalidate module tree cache (flow metadata changed). On a move, bust the
    // OLD module too so the source folder drops the flow immediately.
    await cache.delByPattern(`qait:cache:ptree:module:${data.module_id}:*`);
    if (previousModuleId && previousModuleId !== data.module_id) {
      await cache.delByPattern(`qait:cache:ptree:module:${previousModuleId}:*`);
    }

    return this.mapToTestFlow(data);
  }

  /**
   * Delete a flow
   * @param id - Flow ID
   * @param userId - User ID for access control
   * @returns True if deleted
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[FLOW_SERVICE] Deleting flow', { id });

    // Fetch module_id and project_id before delete for cache invalidation
    const { data: flow } = await supabaseAdmin
      .from('test_flows')
      .select('module_id, test_modules!inner(project_id)')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();

    // Clean up regression plan items referencing this flow
    const { error: planCleanupError } = await supabaseAdmin
      .from('regression_plan_items')
      .delete()
      .eq('flow_id', id);

    if (planCleanupError) {
      logger.warn('[FLOW_SERVICE] Failed to cleanup plan items for deleted flow', {
        error: planCleanupError, id,
      });
    }

    const { error } = await supabaseAdmin
      .from('test_flows')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('[FLOW_SERVICE] Failed to delete flow', { error, id });
      throw new Error(`Failed to delete flow: ${error.message}`);
    }

    // Invalidate module mode + flow mode caches
    if (flow?.module_id) {
      await cache.delByPattern(`qait:cache:ptree:module:${flow.module_id}:*`);
    }
    await cache.delByPattern(`qait:cache:ptree:flow:${id}:*`);

    // Invalidate plans cache — deleting a flow removes its regression_plan_items as side-effect
    const projectId = (flow as any)?.test_modules?.project_id;
    if (projectId) {
      await cache.delByPattern(`qait:cache:plans:proj:${projectId}:*`);
    }

    return true;
  }

  /**
   * Reorder flows within a module
   * @param moduleId - Module ID
   * @param flowIds - Array of flow IDs in desired order
   * @param userId - User ID for access control
   */
  static async reorder(
    moduleId: string,
    flowIds: string[],
    userId: string
  ): Promise<void> {
    logger.info('[FLOW_SERVICE] Reordering flows', { moduleId, count: flowIds.length });

    // Update each flow's order_index
    const updates = flowIds.map((flowId, index) =>
      supabaseAdmin
        .from('test_flows')
        .update({ order_index: index })
        .eq('id', flowId)
        .eq('module_id', moduleId)
        .eq('user_id', userId)
    );

    const results = await Promise.all(updates);

    const errors = results.filter((r) => r.error);
    if (errors.length > 0) {
      logger.error('[FLOW_SERVICE] Failed to reorder some flows', {
        errors: errors.map((e) => e.error),
      });
      throw new Error('Failed to reorder flows');
    }

    // Invalidate module mode cache (flow order changed)
    await cache.delByPattern(`qait:cache:ptree:module:${moduleId}:*`);
  }

  /**
   * Deep-copy a flow and all its intent_test_cases into the same module.
   * Appends "(Copy)" to the flow name. API test configs are not copied —
   * no flow currently creates them at duplication time.
   * @param sourceFlowId - Flow ID to duplicate
   * @param userId - User ID for access control
   * @returns Newly created flow
   */
  static async duplicate(sourceFlowId: string, userId: string): Promise<TestFlow> {
    logger.info('[FLOW_SERVICE] Duplicating flow', { sourceFlowId, userId });

    const { data: source, error: srcErr } = await supabaseAdmin
      .from('test_flows')
      .select('*')
      .eq('id', sourceFlowId)
      .eq('user_id', userId)
      .single();

    if (srcErr || !source) {
      logger.error('[FLOW_SERVICE] Source flow not found for duplicate', { error: srcErr, sourceFlowId });
      throw new Error('Flow not found');
    }

    const { data: maxOrder } = await supabaseAdmin
      .from('test_flows')
      .select('order_index')
      .eq('module_id', source.module_id)
      .order('order_index', { ascending: false })
      .limit(1)
      .single();

    const nextOrderIndex = maxOrder ? (maxOrder.order_index ?? 0) + 1 : 0;
    const copiedName = `${source.name} (Copy)`;

    const { data: newFlow, error: insErr } = await supabaseAdmin
      .from('test_flows')
      .insert({
        module_id: source.module_id,
        user_id: userId,
        name: copiedName,
        description: source.description,
        order_index: nextOrderIndex,
        flow_type: source.flow_type,
        platform: source.platform,
        tags: source.tags || [],
        priority: source.priority,
        preconditions: source.preconditions || [],
        expected_result: source.expected_result,
      })
      .select('*')
      .single();

    if (insErr || !newFlow) {
      logger.error('[FLOW_SERVICE] Failed to insert duplicated flow', { error: insErr });
      throw new Error(`Failed to duplicate flow: ${insErr?.message ?? 'unknown error'}`);
    }

    const { data: sourceTestCases, error: tcErr } = await supabaseAdmin
      .from('intent_test_cases')
      .select('*')
      .eq('flow_id', sourceFlowId)
      .eq('user_id', userId);

    if (tcErr) {
      logger.error('[FLOW_SERVICE] Failed to list source test cases; rolling back', {
        error: tcErr,
        sourceFlowId,
      });
      await supabaseAdmin.from('test_flows').delete().eq('id', newFlow.id).eq('user_id', userId);
      throw new Error(`Failed to duplicate flow: ${tcErr.message}`);
    }

    if (sourceTestCases && sourceTestCases.length > 0) {
      const copies = sourceTestCases.map((tc) => {
        const { id, created_at, updated_at, flow_id, ...rest } = tc;
        // Keep the test case name in lockstep with the duplicated flow name:
        // a test case that matched the source flow name gets the same " (Copy)"
        // suffix. Without this the flow becomes "X (Copy)" while its test case
        // stays "X", which (a) breaks the breadcrumb's single-segment collapse
        // and (b) defeats the rename cascade's lockstep guard in update().
        const copiedTcName = tc.name === source.name ? copiedName : tc.name;
        return { ...rest, name: copiedTcName, flow_id: newFlow.id };
      });

      const { error: tcInsErr } = await supabaseAdmin.from('intent_test_cases').insert(copies);

      if (tcInsErr) {
        logger.error('[FLOW_SERVICE] Failed to insert duplicated test cases; rolling back flow', {
          error: tcInsErr,
          newFlowId: newFlow.id,
        });
        await supabaseAdmin.from('test_flows').delete().eq('id', newFlow.id).eq('user_id', userId);
        throw new Error(`Failed to duplicate flow: ${tcInsErr.message}`);
      }
    }

    await cache.delByPattern(`qait:cache:ptree:module:${source.module_id}:*`);

    logger.info('[FLOW_SERVICE] Duplicated flow', {
      sourceFlowId,
      newFlowId: newFlow.id,
      testCaseCount: sourceTestCases?.length ?? 0,
    });

    return this.mapToTestFlow(newFlow);
  }

  /**
   * Get all test case IDs in a flow
   * UI test cases are now sourced from intent_test_cases (unified table).
   * @param flowId - Flow ID
   * @param userId - User ID for access control
   * @returns Object with UI and API test case IDs
   */
  static async getTestCaseIds(
    flowId: string,
    userId: string
  ): Promise<{ ui: string[]; api: string[] }> {
    // Get UI + API test cases in parallel (independent reads on different tables)
    const [uiResult, apiResult] = await Promise.all([
      supabaseAdmin.from('intent_test_cases').select('id').eq('flow_id', flowId).eq('user_id', userId),
      supabaseAdmin.from('api_test_configs').select('id').eq('flow_id', flowId).eq('user_id', userId),
    ]);

    const { data: uiCases, error: uiError } = uiResult;
    const { data: apiCases, error: apiError } = apiResult;

    if (uiError) {
      logger.error('[FLOW_SERVICE] Failed to get UI test cases', { error: uiError, flowId });
      throw new Error(`Failed to get test cases: ${uiError.message}`);
    }

    if (apiError) {
      logger.error('[FLOW_SERVICE] Failed to get API test cases', { error: apiError, flowId });
      throw new Error(`Failed to get test cases: ${apiError.message}`);
    }

    return {
      ui: (uiCases || []).map((c: any) => c.id),
      api: (apiCases || []).map((c: any) => c.id),
    };
  }

  /**
   * Map database row to TestFlow type
   */
  private static mapToTestFlow(row: any): TestFlow {
    return {
      id: row.id,
      moduleId: row.module_id,
      userId: row.user_id,
      name: row.name,
      description: row.description || undefined,
      orderIndex: row.order_index,
      flowType: row.flow_type,
      platform: row.platform || undefined,
      tags: row.tags || [],
      priority: row.priority || undefined,
      preconditions: row.preconditions || [],
      expectedResult: row.expected_result || undefined,
      mobileVariantLabel: row.mobile_variant_label ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Read a flow's mobile variant override (or null). Used by the mobile
   * dispatcher to apply flow-level variant inheritance to its test cases.
   */
  static async getMobileVariantLabel(flowId: string): Promise<string | null> {
    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .select('mobile_variant_label')
      .eq('id', flowId)
      .maybeSingle();
    if (error) {
      logger.warn('[FLOW_SERVICE] getMobileVariantLabel failed', { error: error.message, flowId });
      return null;
    }
    const label = (data as { mobile_variant_label?: string | null } | null)?.mobile_variant_label;
    return typeof label === 'string' && label.trim() ? label.trim() : null;
  }
}
