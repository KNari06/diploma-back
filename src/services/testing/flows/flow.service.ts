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
      description,
      orderIndex,
      flowType,
      tags,
      priority,
      preconditions,
      expectedResult,
    } = params;

    logger.info('[FLOW_SERVICE] Creating flow', {
      moduleId,
      userId,
      name,
    });

    // Get max order_index if not provided
    let finalOrderIndex = orderIndex;
    if (finalOrderIndex === undefined) {
      const { data: maxOrder } = await supabaseAdmin
        .from('test_flows')
        .select('order_index')
        .eq('module_id', moduleId)
        .order('order_index', { ascending: false })
        .limit(1)
        .single();

      finalOrderIndex = maxOrder ? maxOrder.order_index + 1 : 0;
    }

    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .insert({
        module_id: moduleId,
        user_id: userId,
        name,
        description: description || null,
        order_index: finalOrderIndex,
        flow_type: flowType || 'ui',
        tags: tags || [],
        priority: priority || null,
        preconditions: preconditions || [],
        expected_result: expectedResult || null,
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
    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .select('*')
      .eq('module_id', moduleId)
      .eq('user_id', userId)
      .order('order_index', { ascending: true });

    if (error) {
      logger.error('[FLOW_SERVICE] Failed to list flows', { error, moduleId });
      throw new Error(`Failed to list flows: ${error.message}`);
    }

    return (data || []).map(this.mapToTestFlow);
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
      description,
      orderIndex,
      flowType,
      tags,
      priority,
      preconditions,
      expectedResult,
    } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (orderIndex !== undefined) updates.order_index = orderIndex;
    if (flowType !== undefined) updates.flow_type = flowType;
    if (tags !== undefined) updates.tags = tags;
    if (priority !== undefined) updates.priority = priority;
    if (preconditions !== undefined) updates.preconditions = preconditions;
    if (expectedResult !== undefined) updates.expected_result = expectedResult;

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update');
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

    // Invalidate module mode cache (flow metadata changed)
    await cache.delByPattern(`qait:cache:ptree:module:${data.module_id}:*`);

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
    // Get UI test cases from intent_test_cases (unified table)
    const { data: uiCases, error: uiError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id')
      .eq('flow_id', flowId)
      .eq('user_id', userId);

    if (uiError) {
      logger.error('[FLOW_SERVICE] Failed to get UI test cases', { error: uiError, flowId });
      throw new Error(`Failed to get test cases: ${uiError.message}`);
    }

    // Get API test cases (unchanged)
    const { data: apiCases, error: apiError } = await supabaseAdmin
      .from('api_test_configs')
      .select('id')
      .eq('flow_id', flowId)
      .eq('user_id', userId);

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
      tags: row.tags || [],
      priority: row.priority || undefined,
      preconditions: row.preconditions || [],
      expectedResult: row.expected_result || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
