/**
 * Regression Plan Service
 * CRUD operations for regression plans and their items
 */

import { supabaseAdmin } from '@/db/supabase';
import type {
    AddPlanItemParams,
    CreateRegressionPlanParams,
    ExpandedTestCase,
    RegressionPlan,
    RegressionPlanItem,
    RegressionPlanWithItems,
    UpdateRegressionPlanParams,
} from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

/**
 * Service for managing regression plans
 * Plans define custom test sets for regression testing
 */
export class RegressionPlanService {
  /**
   * Create a new regression plan
   * @param params - Plan creation parameters
   * @returns Created plan
   */
  static async create(params: CreateRegressionPlanParams): Promise<RegressionPlan> {
    const { projectId, userId, name, description, isDefault, tags } = params;

    logger.info('[REGRESSION_PLAN_SERVICE] Creating plan', {
      projectId,
      userId,
      name,
    });

    // If setting as default, unset existing default
    if (isDefault) {
      await supabaseAdmin
        .from('regression_plans')
        .update({ is_default: false })
        .eq('project_id', projectId)
        .eq('is_default', true);
    }

    const { data, error } = await supabaseAdmin
      .from('regression_plans')
      .insert({
        project_id: projectId,
        user_id: userId,
        name,
        description: description || null,
        is_default: isDefault || false,
        tags: tags || [],
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to create plan', { error });
      throw new Error(`Failed to create plan: ${error.message}`);
    }

    return this.mapToRegressionPlan(data);
  }

  /**
   * Get a plan by ID
   * @param id - Plan ID
   * @param userId - User ID for access control
   * @returns Plan or null if not found
   */
  static async getById(id: string, userId: string): Promise<RegressionPlan | null> {
    const { data, error } = await supabaseAdmin
      .from('regression_plans')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to get plan', { error, id });
      throw new Error(`Failed to get plan: ${error.message}`);
    }

    return this.mapToRegressionPlan(data);
  }

  /**
   * Get a plan with all its items
   * @param id - Plan ID
   * @param userId - User ID for access control
   * @returns Plan with items or null
   */
  static async getWithItems(
    id: string,
    userId: string
  ): Promise<RegressionPlanWithItems | null> {
    const plan = await this.getById(id, userId);
    if (!plan) return null;

    const items = await this.getItems(id);

    return {
      ...plan,
      items,
    };
  }

  /**
   * List plans for a project
   * @param projectId - Project ID
   * @param userId - User ID for access control
   * @returns List of plans
   */
  static async listByProject(
    projectId: string,
    userId: string
  ): Promise<RegressionPlan[]> {
    const { data, error } = await supabaseAdmin
      .from('regression_plans')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to list plans', { error, projectId });
      throw new Error(`Failed to list plans: ${error.message}`);
    }

    return (data || []).map(this.mapToRegressionPlan);
  }

  /**
   * Update a plan
   * @param params - Update parameters
   * @returns Updated plan
   */
  static async update(params: UpdateRegressionPlanParams): Promise<RegressionPlan> {
    const { id, userId, name, description, isDefault, tags } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (tags !== undefined) updates.tags = tags;

    // Handle is_default separately
    if (isDefault !== undefined) {
      if (isDefault) {
        // Get project ID first
        const plan = await this.getById(id, userId);
        if (plan) {
          // Unset existing default
          await supabaseAdmin
            .from('regression_plans')
            .update({ is_default: false })
            .eq('project_id', plan.projectId)
            .eq('is_default', true);
        }
      }
      updates.is_default = isDefault;
    }

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update');
    }

    logger.info('[REGRESSION_PLAN_SERVICE] Updating plan', {
      id,
      updatedFields: Object.keys(updates),
    });

    const { data, error } = await supabaseAdmin
      .from('regression_plans')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to update plan', { error, id });
      throw new Error(`Failed to update plan: ${error.message}`);
    }

    return this.mapToRegressionPlan(data);
  }

  /**
   * Delete a plan
   * @param id - Plan ID
   * @param userId - User ID for access control
   * @returns True if deleted
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[REGRESSION_PLAN_SERVICE] Deleting plan', { id });

    const { error } = await supabaseAdmin
      .from('regression_plans')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to delete plan', { error, id });
      throw new Error(`Failed to delete plan: ${error.message}`);
    }

    return true;
  }

  // =========================================================================
  // PLAN ITEMS
  // =========================================================================

  /**
   * Get all items in a plan
   * @param planId - Plan ID
   * @returns List of items
   */
  static async getItems(planId: string): Promise<RegressionPlanItem[]> {
    const { data, error } = await supabaseAdmin
      .from('regression_plan_items')
      .select('*')
      .eq('plan_id', planId)
      .order('order_index', { ascending: true });

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to get items', { error, planId });
      throw new Error(`Failed to get plan items: ${error.message}`);
    }

    return (data || []).map(this.mapToRegressionPlanItem);
  }

  /**
   * Add an item to a plan
   * @param params - Item parameters
   * @returns Created item
   */
  static async addItem(params: AddPlanItemParams): Promise<RegressionPlanItem> {
    const {
      planId,
      itemType,
      moduleId,
      suiteId,
      flowId,
      testCaseId,
      testCaseType,
      orderIndex,
      parametersOverride,
    } = params;

    logger.info('[REGRESSION_PLAN_SERVICE] Adding item to plan', {
      planId,
      itemType,
    });

    // Get max order_index if not provided
    let finalOrderIndex = orderIndex;
    if (finalOrderIndex === undefined) {
      const { data: maxOrder } = await supabaseAdmin
        .from('regression_plan_items')
        .select('order_index')
        .eq('plan_id', planId)
        .order('order_index', { ascending: false })
        .limit(1)
        .single();

      finalOrderIndex = maxOrder ? maxOrder.order_index + 1 : 0;
    }

    const { data, error } = await supabaseAdmin
      .from('regression_plan_items')
      .insert({
        plan_id: planId,
        item_type: itemType,
        module_id: moduleId || null,
        suite_id: suiteId || null,
        flow_id: flowId || null,
        test_case_id: testCaseId || null,
        test_case_type: testCaseType || null,
        order_index: finalOrderIndex,
        parameters_override: parametersOverride || {},
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to add item', { error, planId });
      throw new Error(`Failed to add item: ${error.message}`);
    }

    return this.mapToRegressionPlanItem(data);
  }

  /**
   * Remove an item from a plan
   * @param itemId - Item ID
   * @param userId - User ID for access control (via plan ownership)
   */
  static async removeItem(itemId: string, userId: string): Promise<void> {
    logger.info('[REGRESSION_PLAN_SERVICE] Removing item', { itemId });

    // Verify ownership through plan
    const { data: item, error: fetchError } = await supabaseAdmin
      .from('regression_plan_items')
      .select('plan_id')
      .eq('id', itemId)
      .single();

    if (fetchError || !item) {
      throw new Error('Item not found');
    }

    // Verify plan ownership
    const plan = await this.getById(item.plan_id, userId);
    if (!plan) {
      throw new Error('Access denied');
    }

    const { error } = await supabaseAdmin
      .from('regression_plan_items')
      .delete()
      .eq('id', itemId);

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to remove item', { error, itemId });
      throw new Error(`Failed to remove item: ${error.message}`);
    }
  }

  /**
   * Reorder items within a plan
   * @param planId - Plan ID
   * @param itemIds - Array of item IDs in desired order
   */
  static async reorderItems(planId: string, itemIds: string[]): Promise<void> {
    logger.info('[REGRESSION_PLAN_SERVICE] Reordering items', {
      planId,
      count: itemIds.length,
    });

    const updates = itemIds.map((itemId, index) =>
      supabaseAdmin
        .from('regression_plan_items')
        .update({ order_index: index })
        .eq('id', itemId)
        .eq('plan_id', planId)
    );

    const results = await Promise.all(updates);
    const errors = results.filter((r) => r.error);

    if (errors.length > 0) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to reorder some items', {
        errors: errors.map((e) => e.error),
      });
      throw new Error('Failed to reorder items');
    }
  }

  // =========================================================================
  // PLAN EXPANSION
  // =========================================================================

  /**
   * Expand a plan to individual test cases
   * Resolves modules → suites → flows → test cases
   * @param planId - Plan ID
   * @returns Array of expanded test cases
   */
  static async expandPlan(planId: string): Promise<ExpandedTestCase[]> {
    const items = await this.getItems(planId);
    const expandedCases: ExpandedTestCase[] = [];

    for (const item of items) {
      switch (item.itemType) {
        case 'module':
          if (item.moduleId) {
            const moduleCases = await this.expandModule(item.moduleId);
            expandedCases.push(...moduleCases);
          }
          break;
        case 'suite':
          if (item.suiteId) {
            const suiteCases = await this.expandSuite(item.suiteId);
            expandedCases.push(...suiteCases);
          }
          break;
        case 'flow':
          if (item.flowId) {
            const flowCases = await this.expandFlow(item.flowId);
            expandedCases.push(...flowCases);
          }
          break;
        case 'test_case':
          if (item.testCaseId && item.testCaseType) {
            const testCase = await this.getTestCaseInfo(
              item.testCaseId,
              item.testCaseType
            );
            if (testCase) {
              expandedCases.push({
                ...testCase,
                parameters: item.parametersOverride,
              });
            }
          }
          break;
      }
    }

    return expandedCases;
  }

  /**
   * Expand a module to its test cases
   */
  private static async expandModule(moduleId: string): Promise<ExpandedTestCase[]> {
    // Get all suites in module
    const { data: suites } = await supabaseAdmin
      .from('regression_suites')
      .select('id')
      .eq('module_id', moduleId);

    const cases: ExpandedTestCase[] = [];
    for (const suite of suites || []) {
      const suiteCases = await this.expandSuite(suite.id);
      cases.push(...suiteCases);
    }

    return cases;
  }

  /**
   * Expand a suite to its test cases
   */
  private static async expandSuite(suiteId: string): Promise<ExpandedTestCase[]> {
    // Get all flows in suite
    const { data: flows } = await supabaseAdmin
      .from('test_flows')
      .select('id')
      .eq('suite_id', suiteId)
      .order('order_index', { ascending: true });

    const cases: ExpandedTestCase[] = [];
    for (const flow of flows || []) {
      const flowCases = await this.expandFlow(flow.id);
      cases.push(...flowCases);
    }

    return cases;
  }

  /**
   * Expand a flow to its test cases
   */
  private static async expandFlow(flowId: string): Promise<ExpandedTestCase[]> {
    const cases: ExpandedTestCase[] = [];

    // Get flow info for context
    const { data: flow } = await supabaseAdmin
      .from('test_flows')
      .select('suite_id')
      .eq('id', flowId)
      .single();

    const suiteId = flow?.suite_id;

    // Get module_id from suite
    let moduleId: string | undefined;
    if (suiteId) {
      const { data: suite } = await supabaseAdmin
        .from('regression_suites')
        .select('module_id')
        .eq('id', suiteId)
        .single();
      moduleId = suite?.module_id;
    }

    // Get UI test cases from intent_test_cases (unified table)
    const { data: uiCases } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name')
      .eq('flow_id', flowId);

    for (const tc of uiCases || []) {
      cases.push({
        testCaseId: tc.id,
        testType: 'ui',
        moduleId,
        suiteId,
        flowId,
        name: tc.name,
      });
    }

    // Get API test cases
    const { data: apiCases } = await supabaseAdmin
      .from('api_test_configs')
      .select('id, name')
      .eq('flow_id', flowId);

    for (const tc of apiCases || []) {
      cases.push({
        testCaseId: tc.id,
        testType: 'api',
        moduleId,
        suiteId,
        flowId,
        name: tc.name,
      });
    }

    return cases;
  }

  /**
   * Get test case info
   */
  private static async getTestCaseInfo(
    testCaseId: string,
    testType: 'ui' | 'api'
  ): Promise<ExpandedTestCase | null> {
    // UI test cases now in intent_test_cases (unified table)
    const table = testType === 'ui' ? 'intent_test_cases' : 'api_test_configs';

    const { data } = await supabaseAdmin
      .from(table)
      .select('id, name, flow_id')
      .eq('id', testCaseId)
      .single();

    if (!data) return null;

    // Get hierarchy info
    let moduleId: string | undefined;
    let suiteId: string | undefined;

    if (data.flow_id) {
      const { data: flow } = await supabaseAdmin
        .from('test_flows')
        .select('suite_id')
        .eq('id', data.flow_id)
        .single();

      if (flow?.suite_id) {
        suiteId = flow.suite_id;
        const { data: suite } = await supabaseAdmin
          .from('regression_suites')
          .select('module_id')
          .eq('id', suiteId)
          .single();
        moduleId = suite?.module_id;
      }
    }

    return {
      testCaseId: data.id,
      testType,
      moduleId,
      suiteId,
      flowId: data.flow_id,
      name: data.name,
    };
  }

  // =========================================================================
  // MAPPERS
  // =========================================================================

  private static mapToRegressionPlan(row: any): RegressionPlan {
    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      name: row.name,
      description: row.description || undefined,
      isDefault: row.is_default,
      tags: row.tags || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static mapToRegressionPlanItem(row: any): RegressionPlanItem {
    return {
      id: row.id,
      planId: row.plan_id,
      itemType: row.item_type,
      moduleId: row.module_id || undefined,
      suiteId: row.suite_id || undefined,
      flowId: row.flow_id || undefined,
      testCaseId: row.test_case_id || undefined,
      testCaseType: row.test_case_type || undefined,
      orderIndex: row.order_index,
      parametersOverride: row.parameters_override || {},
      createdAt: row.created_at,
    };
  }
}
