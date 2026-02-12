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
    RegressionPlanWithStats,
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
   * List plans for a project with latest run stats and scope info
   *
   * Query strategy (optimized to avoid N+1):
   *   1. Fetch all plans (1 query)
   *   2. Batch-fetch all plan items for all plans (1 query)
   *   3. Batch-resolve module→flows + count test cases per flow (2-4 queries)
   *   4. Batch-fetch latest run per plan (N parallel, each hits index)
   *   5. Batch-fetch all executions for health + flaky (1 query)
   * Total: ~6 + N queries, all indexed, runs in 2 parallel phases
   */
  static async listByProject(
    projectId: string,
    userId: string
  ): Promise<RegressionPlanWithStats[]> {
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

    const plans = (data || []).map(this.mapToRegressionPlan);
    if (plans.length === 0) return [];

    const planIds = plans.map((p) => p.id);

    // Run scope + lastRun fetches in parallel
    const [scopeMap, lastRunMap] = await Promise.all([
      this.batchGetPlanScopes(planIds),
      this.batchGetLatestRuns(planIds),
    ]);

    // Batch-fetch health for all runs that exist
    const runIds = [...lastRunMap.values()]
      .filter(Boolean)
      .map((r) => r!.id);
    const healthMap = runIds.length > 0
      ? await this.batchGetRunHealths(runIds)
      : new Map<string, RegressionPlanWithStats['health']>();

    const defaultHealth: RegressionPlanWithStats['health'] = {
      state: 'unknown', passRate: 0, passed: 0, failed: 0, flaky: 0, total: 0,
    };

    return plans.map((plan) => {
      const lastRunRow = lastRunMap.get(plan.id) || null;
      const runId = lastRunRow?.id;

      return {
        ...plan,
        scope: scopeMap.get(plan.id) || { testCount: 0, flowCount: 0 },
        lastRun: lastRunRow
          ? {
              runId: lastRunRow.id,
              status: lastRunRow.status,
              startedAt: lastRunRow.started_at,
              completedAt: lastRunRow.completed_at,
              durationMs:
                lastRunRow.completed_at && lastRunRow.started_at
                  ? new Date(lastRunRow.completed_at).getTime() -
                    new Date(lastRunRow.started_at).getTime()
                  : null,
            }
          : null,
        health: (runId && healthMap.get(runId)) || defaultHealth,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // BATCH: Scope (test count + flow count) for all plans
  // ---------------------------------------------------------------------------

  /**
   * Batch-fetch scope for multiple plans.
   * Steps:
   *   1. Fetch all plan_items for the given planIds (1 query)
   *   2. Resolve module items → flow IDs (1 query)
   *   3. Batch-count test cases per flow (1 query)
   *   4. Resolve test_case items → flow IDs for flow counting (1 query)
   */
  private static async batchGetPlanScopes(
    planIds: string[]
  ): Promise<Map<string, { testCount: number; flowCount: number }>> {
    // 1. Fetch all items for all plans in one query
    const { data: allItems, error } = await supabaseAdmin
      .from('regression_plan_items')
      .select('plan_id, item_type, module_id, flow_id, test_case_id')
      .in('plan_id', planIds);

    if (error || !allItems) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to batch fetch plan items', { error });
      return new Map(planIds.map((id) => [id, { testCount: 0, flowCount: 0 }]));
    }

    // Group items by plan
    const itemsByPlan = new Map<string, typeof allItems>();
    for (const item of allItems) {
      if (!itemsByPlan.has(item.plan_id)) itemsByPlan.set(item.plan_id, []);
      itemsByPlan.get(item.plan_id)!.push(item);
    }

    // 2. Collect all module IDs to resolve → flows
    const allModuleIds = [
      ...new Set(
        allItems
          .filter((i) => i.item_type === 'module' && i.module_id)
          .map((i) => i.module_id as string)
      ),
    ];

    // Resolve modules → flows in one query
    let moduleFlowMap = new Map<string, string[]>(); // moduleId → flowId[]
    if (allModuleIds.length > 0) {
      const { data: moduleFlows } = await supabaseAdmin
        .from('test_flows')
        .select('id, module_id')
        .in('module_id', allModuleIds);

      for (const f of moduleFlows || []) {
        if (!moduleFlowMap.has(f.module_id)) moduleFlowMap.set(f.module_id, []);
        moduleFlowMap.get(f.module_id)!.push(f.id);
      }
    }

    // 3. Collect ALL flow IDs we need test counts for
    const allFlowIds = new Set<string>();
    for (const item of allItems) {
      if (item.item_type === 'module' && item.module_id) {
        for (const fid of moduleFlowMap.get(item.module_id) || []) {
          allFlowIds.add(fid);
        }
      } else if (item.item_type === 'flow' && item.flow_id) {
        allFlowIds.add(item.flow_id);
      }
    }

    // Batch-count test cases per flow in one query
    const flowTestCounts = new Map<string, number>();
    if (allFlowIds.size > 0) {
      const { data: flowCounts } = await supabaseAdmin
        .from('intent_test_cases')
        .select('flow_id')
        .in('flow_id', [...allFlowIds]);

      // Count per flow_id
      for (const row of flowCounts || []) {
        flowTestCounts.set(row.flow_id, (flowTestCounts.get(row.flow_id) || 0) + 1);
      }
    }

    // 4. Resolve test_case items → flow_id for flow counting
    const testCaseIds = allItems
      .filter((i) => i.item_type === 'test_case' && i.test_case_id)
      .map((i) => i.test_case_id as string);

    const testCaseFlowMap = new Map<string, string | null>();
    if (testCaseIds.length > 0) {
      const { data: tcFlows } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, flow_id')
        .in('id', testCaseIds);

      for (const tc of tcFlows || []) {
        testCaseFlowMap.set(tc.id, tc.flow_id);
      }
    }

    // 5. Build scope per plan
    const result = new Map<string, { testCount: number; flowCount: number }>();
    for (const planId of planIds) {
      const items = itemsByPlan.get(planId) || [];
      const flowIds = new Set<string>();
      let testCount = 0;

      for (const item of items) {
        switch (item.item_type) {
          case 'module': {
            const flows = moduleFlowMap.get(item.module_id!) || [];
            for (const fid of flows) {
              flowIds.add(fid);
              testCount += flowTestCounts.get(fid) || 0;
            }
            break;
          }
          case 'flow': {
            flowIds.add(item.flow_id!);
            testCount += flowTestCounts.get(item.flow_id!) || 0;
            break;
          }
          case 'test_case': {
            testCount += 1;
            const flowId = testCaseFlowMap.get(item.test_case_id!);
            if (flowId) flowIds.add(flowId);
            break;
          }
        }
      }

      result.set(planId, { testCount, flowCount: flowIds.size });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // BATCH: Latest run per plan
  // ---------------------------------------------------------------------------

  private static async batchGetLatestRuns(
    planIds: string[]
  ): Promise<
    Map<string, { id: string; plan_id: string; status: string; started_at: string; completed_at: string | null }>
  > {
    // Fetch the single latest run per plan using parallel queries (uses idx_regression_runs_plan index).
    const entries = await Promise.all(
      planIds.map(async (planId) => {
        const { data: row } = await supabaseAdmin
          .from('regression_runs')
          .select('id, plan_id, status, started_at, completed_at')
          .eq('plan_id', planId)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        return row ? ([planId, row] as const) : null;
      })
    );

    const result = new Map<
      string,
      { id: string; plan_id: string; status: string; started_at: string; completed_at: string | null }
    >();
    for (const entry of entries) {
      if (entry) result.set(entry[0], entry[1]);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // BATCH: Health (execution stats + flaky) for multiple runs
  // ---------------------------------------------------------------------------

  private static async batchGetRunHealths(
    runIds: string[]
  ): Promise<Map<string, RegressionPlanWithStats['health']>> {
    // Fetch all execution rows for these runs in one query
    // (used for both stats and flaky detection)
    const { data: executions, error } = await supabaseAdmin
      .from('test_executions')
      .select('run_id, test_case_id, status')
      .in('run_id', runIds);

    if (error || !executions) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to batch fetch executions', { error });
      return new Map();
    }

    // Group by run_id
    const execsByRun = new Map<string, Array<{ test_case_id: string; status: string }>>();
    for (const exec of executions) {
      if (!execsByRun.has(exec.run_id)) execsByRun.set(exec.run_id, []);
      execsByRun.get(exec.run_id)!.push(exec);
    }

    const result = new Map<string, RegressionPlanWithStats['health']>();

    for (const runId of runIds) {
      const execs = execsByRun.get(runId) || [];
      const total = execs.length;
      const passed = execs.filter((e) => e.status === 'passed').length;
      const failed = execs.filter((e) => e.status === 'failed').length;
      const completed = passed + failed;
      const passRate = completed > 0
        ? Math.round((passed / completed) * 100 * 10) / 10
        : 0;

      // Flaky: test cases with both passed and failed in same run
      const groups = new Map<string, Set<string>>();
      for (const exec of execs) {
        if (!exec.test_case_id) continue;
        if (!groups.has(exec.test_case_id)) groups.set(exec.test_case_id, new Set());
        groups.get(exec.test_case_id)!.add(exec.status);
      }
      let flaky = 0;
      for (const statuses of groups.values()) {
        if (statuses.has('passed') && statuses.has('failed')) flaky++;
      }

      let state: 'passing' | 'warning' | 'failing' | 'unknown' = 'passing';
      if (total === 0) {
        state = 'unknown';
      } else if (failed > 0) {
        state = passRate >= 90 ? 'warning' : 'failing';
      }

      result.set(runId, { state, passRate, passed, failed, flaky, total });
    }

    return result;
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
   * Resolves modules → flows → test cases
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
    // Get all flows in module
    const { data: flows } = await supabaseAdmin
      .from('test_flows')
      .select('id')
      .eq('module_id', moduleId);

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

    // Get flow info for module context
    const { data: flow } = await supabaseAdmin
      .from('test_flows')
      .select('module_id')
      .eq('id', flowId)
      .single();

    const moduleId = flow?.module_id;

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

    // Get module_id from flow
    let moduleId: string | undefined;

    if (data.flow_id) {
      const { data: flow } = await supabaseAdmin
        .from('test_flows')
        .select('module_id')
        .eq('id', data.flow_id)
        .single();

      moduleId = flow?.module_id;
    }

    return {
      testCaseId: data.id,
      testType,
      moduleId,
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
      flowId: row.flow_id || undefined,
      testCaseId: row.test_case_id || undefined,
      testCaseType: row.test_case_type || undefined,
      orderIndex: row.order_index,
      parametersOverride: row.parameters_override || {},
      createdAt: row.created_at,
    };
  }
}
