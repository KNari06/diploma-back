/**
 * Regression Plan Service
 * CRUD operations for regression plans and their items
 */

import { supabaseAdmin } from '@/db/supabase';
import { GitIntegrationService } from '@/services/integrations/git-integration.service';
import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { ValidationError } from '@/types';
import type {
    AddPlanItemParams,
    CreateRegressionPlanParams,
    ExpandedTestCase,
    FlakyTest,
    PlanGitTriggersConfig,
    PlanHealthReport,
    PlanScheduleConfig,
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
    const { projectId, userId, name, description, isDefault, tags, automationConfig, notificationsEnabled } = params;

    logger.info('[REGRESSION_PLAN_SERVICE] Creating plan', {
      projectId,
      userId,
      name,
      hasAutomation: !!automationConfig,
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
        automation_config: automationConfig || null,
        notifications_enabled: notificationsEnabled !== undefined ? notificationsEnabled : true,
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to create plan', { error });
      throw new Error(`Failed to create plan: ${error.message}`);
    }

    const plan = this.mapToRegressionPlan(data);

    // Sync schedule and git integration if automation config provided
    if (automationConfig) {
      const scheduleId = await this.syncSchedule(plan, automationConfig.schedule);
      await this.syncGitIntegration(plan, automationConfig.gitTriggers);

      if (scheduleId) {
        await supabaseAdmin
          .from('regression_plans')
          .update({ schedule_id: scheduleId })
          .eq('id', plan.id);
        plan.scheduleId = scheduleId;
      }
    }

    return plan;
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
      const health = (runId && healthMap.get(runId)) || defaultHealth;

      return {
        ...plan,
        scope: scopeMap.get(plan.id) || { testCount: 0, flowCount: 0 },
        lastRun: lastRunRow
          ? {
              runId: lastRunRow.id,
              status: health.state !== 'unknown' ? health.state : lastRunRow.status,
              startedAt: lastRunRow.started_at,
              completedAt: lastRunRow.completed_at,
              durationMs: this.computeDurationMs(lastRunRow.started_at, lastRunRow.completed_at),
              passRate: health.total > 0 ? health.passRate : null,
            }
          : null,
        health,
      };
    });
  }

  /**
   * Enrich a single plan with health, scope, and lastRun stats.
   * Reuses the same batch methods as listByProject but for one plan.
   */
  static async enrichPlanWithStats(plan: RegressionPlan & { items?: any[] }): Promise<any> {
    const planIds = [plan.id];

    const [scopeMap, lastRunMap] = await Promise.all([
      this.batchGetPlanScopes(planIds),
      this.batchGetLatestRuns(planIds),
    ]);

    const lastRunRow = lastRunMap.get(plan.id) || null;
    const runId = lastRunRow?.id;

    let health: RegressionPlanWithStats['health'] = {
      state: 'unknown', passRate: 0, passed: 0, failed: 0, flaky: 0, total: 0,
    };

    if (runId) {
      const healthMap = await this.batchGetRunHealths([runId]);
      health = healthMap.get(runId) || health;
    }

    return {
      ...plan,
      scope: scopeMap.get(plan.id) || { testCount: 0, flowCount: 0 },
      lastRun: lastRunRow
        ? {
            runId: lastRunRow.id,
            status: health.state !== 'unknown' ? health.state : lastRunRow.status,
            startedAt: lastRunRow.started_at,
            completedAt: lastRunRow.completed_at,
            durationMs: this.computeDurationMs(lastRunRow.started_at, lastRunRow.completed_at),
            passRate: health.total > 0 ? health.passRate : null,
          }
        : null,
      health,
    };
  }

  // ---------------------------------------------------------------------------
  // BATCH: Scope (test count + flow count) for all plans
  // ---------------------------------------------------------------------------

  /**
   * Compute duration in ms from two ISO timestamps.
   * Returns null if inputs are missing or duration is negative.
   */
  private static computeDurationMs(startedAt: string | null, completedAt: string | null): number | null {
    if (!startedAt || !completedAt) return null;
    const diff = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    return diff > 0 ? diff : null;
  }

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
    // Fetch run statuses and execution rows in parallel
    const [runsResult, execsResult] = await Promise.all([
      supabaseAdmin
        .from('regression_runs')
        .select('id, status')
        .in('id', runIds),
      supabaseAdmin
        .from('test_executions')
        .select('run_id, test_case_id, status')
        .in('run_id', runIds),
    ]);

    if (execsResult.error || !execsResult.data) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to batch fetch executions', { error: execsResult.error });
      return new Map();
    }

    // Map run statuses
    const runStatusMap = new Map<string, string>();
    for (const run of runsResult.data || []) {
      runStatusMap.set(run.id, run.status);
    }

    // Group executions by run_id
    const execsByRun = new Map<string, Array<{ test_case_id: string; status: string }>>();
    for (const exec of execsResult.data) {
      if (!execsByRun.has(exec.run_id)) execsByRun.set(exec.run_id, []);
      execsByRun.get(exec.run_id)!.push(exec);
    }

    const result = new Map<string, RegressionPlanWithStats['health']>();

    for (const runId of runIds) {
      const execs = execsByRun.get(runId) || [];
      const runStatus = runStatusMap.get(runId) || 'unknown';
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

      // Determine health state — consider both execution stats AND run-level status
      let state: 'passing' | 'warning' | 'failing' | 'unknown';
      if (total === 0) {
        // No executions — fall back to the run's own status
        state = runStatus === 'failed' ? 'failing' : 'unknown';
      } else if (completed === 0) {
        // Executions exist but none passed/failed (all pending/running/skipped/cancelled)
        state = runStatus === 'failed' ? 'failing' : 'unknown';
      } else if (failed > 0) {
        state = passRate >= 90 ? 'warning' : 'failing';
      } else {
        state = 'passing';
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
    const { id, userId, name, description, isDefault, tags, automationConfig, notificationsEnabled } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (tags !== undefined) updates.tags = tags;
    if (automationConfig !== undefined) updates.automation_config = automationConfig;
    if (notificationsEnabled !== undefined) updates.notifications_enabled = notificationsEnabled;

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

    const plan = this.mapToRegressionPlan(data);

    // Re-sync schedule and git integration when automation config changes
    if (automationConfig !== undefined) {
      const scheduleId = await this.syncSchedule(plan, automationConfig?.schedule);
      await this.syncGitIntegration(plan, automationConfig?.gitTriggers);

      if (scheduleId !== plan.scheduleId) {
        await supabaseAdmin
          .from('regression_plans')
          .update({ schedule_id: scheduleId })
          .eq('id', plan.id);
        plan.scheduleId = scheduleId || undefined;
      }
    }

    return plan;
  }

  /**
   * Delete a plan
   * @param id - Plan ID
   * @param userId - User ID for access control
   * @returns True if deleted
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[REGRESSION_PLAN_SERVICE] Deleting plan', { id });

    // Deactivate linked schedule before delete (belt-and-suspenders — CASCADE handles it)
    const plan = await this.getById(id, userId);
    if (plan?.scheduleId) {
      await supabaseAdmin
        .from('test_schedules')
        .update({ is_active: false })
        .eq('id', plan.scheduleId);
    }

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

    // Validate plan exists
    const { data: planExists } = await supabaseAdmin
      .from('regression_plans')
      .select('id')
      .eq('id', planId)
      .maybeSingle();

    if (!planExists) {
      throw new ValidationError(`Plan ${planId} not found`);
    }

    // Validate referenced entity exists
    if (itemType === 'flow' && flowId) {
      const { data: flowExists } = await supabaseAdmin
        .from('test_flows')
        .select('id')
        .eq('id', flowId)
        .maybeSingle();

      if (!flowExists) {
        throw new ValidationError(`Flow ${flowId} not found`);
      }

      const { count: tcCount } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id', { count: 'exact', head: true })
        .eq('flow_id', flowId);

      const { count: apiCount } = await supabaseAdmin
        .from('api_test_configs')
        .select('id', { count: 'exact', head: true })
        .eq('flow_id', flowId);

      if ((tcCount || 0) + (apiCount || 0) === 0) {
        logger.warn('[REGRESSION_PLAN_SERVICE] Adding flow with no test cases', { planId, flowId });
      }
    }

    if (itemType === 'module' && moduleId) {
      const { data: moduleExists } = await supabaseAdmin
        .from('test_modules')
        .select('id')
        .eq('id', moduleId)
        .maybeSingle();

      if (!moduleExists) {
        throw new ValidationError(`Module ${moduleId} not found`);
      }
    }

    if (itemType === 'test_case' && testCaseId) {
      const table = testCaseType === 'api' ? 'api_test_configs' : 'intent_test_cases';
      const { data: tcExists } = await supabaseAdmin
        .from(table)
        .select('id')
        .eq('id', testCaseId)
        .maybeSingle();

      if (!tcExists) {
        throw new ValidationError(`Test case ${testCaseId} not found in ${table}`);
      }
    }

    // Prevent duplicate items in the same plan
    const dupFilter: Record<string, any> = { plan_id: planId, item_type: itemType };
    if (flowId) dupFilter.flow_id = flowId;
    if (moduleId) dupFilter.module_id = moduleId;
    if (testCaseId) dupFilter.test_case_id = testCaseId;

    let dupQuery = supabaseAdmin
      .from('regression_plan_items')
      .select('id', { count: 'exact', head: true })
      .eq('plan_id', planId)
      .eq('item_type', itemType);

    if (flowId) dupQuery = dupQuery.eq('flow_id', flowId);
    if (moduleId) dupQuery = dupQuery.eq('module_id', moduleId);
    if (testCaseId) dupQuery = dupQuery.eq('test_case_id', testCaseId);

    const { count: dupCount } = await dupQuery;
    if ((dupCount || 0) > 0) {
      throw new ValidationError(`This ${itemType} is already in the plan`);
    }

    // Get max order_index if not provided
    let finalOrderIndex = orderIndex;
    if (finalOrderIndex === undefined) {
      const { data: maxOrder } = await supabaseAdmin
        .from('regression_plan_items')
        .select('order_index')
        .eq('plan_id', planId)
        .order('order_index', { ascending: false })
        .limit(1)
        .maybeSingle();

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

    logger.info('[REGRESSION_PLAN_SERVICE] Expanding plan', {
      planId,
      itemCount: items.length,
      items: items.map((i) => ({ itemType: i.itemType, moduleId: i.moduleId, flowId: i.flowId, testCaseId: i.testCaseId })),
    });

    for (const item of items) {
      switch (item.itemType) {
        case 'module':
          if (item.moduleId) {
            const moduleCases = await this.expandModule(item.moduleId);
            logger.info('[REGRESSION_PLAN_SERVICE] Expanded module', { moduleId: item.moduleId, testCaseCount: moduleCases.length });
            expandedCases.push(...moduleCases);
          }
          break;
        case 'flow':
          if (item.flowId) {
            const flowCases = await this.expandFlow(item.flowId);
            logger.info('[REGRESSION_PLAN_SERVICE] Expanded flow', { flowId: item.flowId, testCaseCount: flowCases.length });
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

    // Deduplicate by testCaseId + testType (e.g. module + flow from same module selected)
    const seen = new Set<string>();
    const deduplicated = expandedCases.filter((tc) => {
      const key = `${tc.testType}:${tc.testCaseId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduplicated;
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
      .maybeSingle();

    const moduleId = flow?.module_id;

    // Get UI test cases from intent_test_cases (unified table)
    // Include cases that have replay data: commands, graph_ref, OR steps_json
    const { data: uiCases, error: uiError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name')
      .eq('flow_id', flowId)
      .not('status', 'eq', 'archived');

    if (uiError) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to query intent_test_cases for flow', { flowId, error: uiError });
    }

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
    const { data: apiCases, error: apiError } = await supabaseAdmin
      .from('api_test_configs')
      .select('id, name')
      .eq('flow_id', flowId);

    if (apiError) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to query api_test_configs for flow', { flowId, error: apiError });
    }

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
      .maybeSingle();

    if (!data) return null;

    // Get module_id from flow
    let moduleId: string | undefined;

    if (data.flow_id) {
      const { data: flow } = await supabaseAdmin
        .from('test_flows')
        .select('module_id')
        .eq('id', data.flow_id)
        .maybeSingle();

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
  // AUTOMATION HELPERS
  // =========================================================================

  /**
   * Build a cron expression from schedule config
   * Converts { days: ["monday","wednesday","friday"], time: "02:00" } → "0 2 * * 1,3,5"
   */
  private static buildCronExpression(schedule: PlanScheduleConfig): string {
    const [hourStr, minuteStr] = (schedule.time || '00:00').split(':');
    const hour = parseInt(hourStr, 10) || 0;
    const minute = parseInt(minuteStr, 10) || 0;

    // Map day names to cron day-of-week numbers (0=Sun, 1=Mon, ..., 6=Sat)
    const dayMap: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };

    let dayOfWeek = '*';
    if (schedule.days.length > 0 && !schedule.days.includes('*')) {
      const dayNums = schedule.days
        .map((d) => dayMap[d.toLowerCase()])
        .filter((n) => n !== undefined)
        .sort((a, b) => a - b);
      if (dayNums.length > 0) {
        dayOfWeek = dayNums.join(',');
      }
    }

    return `${minute} ${hour} * * ${dayOfWeek}`;
  }

  /**
   * Create/update/deactivate linked test_schedules record
   * Returns scheduleId or null
   */
  private static async syncSchedule(
    plan: RegressionPlan,
    scheduleConfig?: PlanScheduleConfig
  ): Promise<string | null> {
    try {
      const existingScheduleId = plan.scheduleId;

      // No schedule config or disabled → deactivate existing
      if (!scheduleConfig || !scheduleConfig.enabled) {
        if (existingScheduleId) {
          await supabaseAdmin
            .from('test_schedules')
            .update({ is_active: false })
            .eq('id', existingScheduleId);
          logger.info('[REGRESSION_PLAN_SERVICE] Deactivated schedule', {
            planId: plan.id,
            scheduleId: existingScheduleId,
          });
        }
        // Return null — schedule is inactive, plan should not reference it as "active"
        return null;
      }

      const cronExpression = scheduleConfig.customCron || this.buildCronExpression(scheduleConfig);
      const timezone = scheduleConfig.timezone || 'UTC';

      // Calculate next_run_at using a simple approach
      const nextRunAt = this.calculateNextRunFromSchedule(cronExpression, timezone);

      if (existingScheduleId) {
        // Update existing schedule
        const { error } = await supabaseAdmin
          .from('test_schedules')
          .update({
            cron_expression: cronExpression,
            timezone,
            is_active: true,
            next_run_at: nextRunAt,
          })
          .eq('id', existingScheduleId);

        if (error) {
          logger.error('[REGRESSION_PLAN_SERVICE] Failed to update schedule', { error, planId: plan.id });
        } else {
          logger.info('[REGRESSION_PLAN_SERVICE] Updated schedule', {
            planId: plan.id,
            scheduleId: existingScheduleId,
            cronExpression,
          });
        }
        return existingScheduleId;
      }

      // Create new schedule
      const { data, error } = await supabaseAdmin
        .from('test_schedules')
        .insert({
          project_id: plan.projectId,
          user_id: plan.userId,
          name: `Auto: ${plan.name}`,
          plan_id: plan.id,
          cron_expression: cronExpression,
          timezone,
          is_active: true,
          next_run_at: nextRunAt,
          parameters: {},
        })
        .select('id')
        .single();

      if (error) {
        logger.error('[REGRESSION_PLAN_SERVICE] Failed to create schedule', { error, planId: plan.id });
        return null;
      }

      logger.info('[REGRESSION_PLAN_SERVICE] Created schedule', {
        planId: plan.id,
        scheduleId: data.id,
        cronExpression,
      });
      return data.id;
    } catch (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] syncSchedule error', {
        error: error instanceof Error ? error.message : String(error),
        planId: plan.id,
      });
      return plan.scheduleId || null;
    }
  }

  /**
   * Delegate to ScheduleService.calculateNextRun — single source of truth
   * for cron → next-run-at conversion (handles day-of-week + timezone).
   */
  private static calculateNextRunFromSchedule(cronExpression: string, timezone: string): string {
    return ScheduleService.calculateNextRun(cronExpression, timezone);
  }

  /**
   * Link/unlink git_integrations.plan_id for this plan.
   * Priority: integrationId > repositoryUrl (find or create) > first enabled integration (backward compatible).
   */
  private static async syncGitIntegration(
    plan: RegressionPlan,
    gitConfig?: PlanGitTriggersConfig
  ): Promise<void> {
    try {
      // Unlink any integrations currently pointing to this plan
      await supabaseAdmin
        .from('git_integrations')
        .update({ plan_id: null })
        .eq('plan_id', plan.id);

      if (!gitConfig || !gitConfig.enabled) {
        return;
      }

      let integration: { id: string } | null = null;

      if (gitConfig.integrationId) {
        const { data } = await supabaseAdmin
          .from('git_integrations')
          .select('id')
          .eq('id', gitConfig.integrationId)
          .eq('project_id', plan.projectId)
          .eq('enabled', true)
          .maybeSingle();
        integration = data;
        if (!integration) {
          logger.warn('[REGRESSION_PLAN_SERVICE] Chosen git integration not found or not allowed', {
            planId: plan.id,
            integrationId: gitConfig.integrationId,
            projectId: plan.projectId,
          });
          return;
        }
      } else if (gitConfig.repositoryUrl?.trim()) {
        const existing = await GitIntegrationService.findByProjectAndRepositoryUrl(
          plan.projectId,
          gitConfig.repositoryUrl.trim()
        );
        if (existing) {
          integration = { id: existing.id };
        } else if (gitConfig.webhookSecret?.trim()) {
          const provider = GitIntegrationService.detectProviderFromUrl(gitConfig.repositoryUrl);
          const created = await GitIntegrationService.createIntegration({
            projectId: plan.projectId,
            userId: plan.userId,
            provider,
            repositoryUrl: gitConfig.repositoryUrl.trim(),
            webhookSecret: gitConfig.webhookSecret.trim(),
            events: ['pull_request', 'push', 'release'],
          });
          integration = { id: created.id };
          logger.info('[REGRESSION_PLAN_SERVICE] Created git integration from repositoryUrl', {
            planId: plan.id,
            integrationId: created.id,
            repositoryUrl: created.repository_url,
          });
        } else {
          logger.warn('[REGRESSION_PLAN_SERVICE] repositoryUrl set but no matching integration and no webhookSecret', {
            planId: plan.id,
            projectId: plan.projectId,
          });
          return;
        }
      } else {
        const { data } = await supabaseAdmin
          .from('git_integrations')
          .select('id')
          .eq('project_id', plan.projectId)
          .eq('enabled', true)
          .limit(1)
          .maybeSingle();
        integration = data;
      }

      if (!integration) {
        logger.warn('[REGRESSION_PLAN_SERVICE] No git integration found for project', {
          planId: plan.id,
          projectId: plan.projectId,
        });
        return;
      }

      await supabaseAdmin
        .from('git_integrations')
        .update({ plan_id: plan.id })
        .eq('id', integration.id);

      logger.info('[REGRESSION_PLAN_SERVICE] Linked git integration to plan', {
        planId: plan.id,
        integrationId: integration.id,
      });
    } catch (error) {
      // Log but do NOT rethrow — the plan itself is already persisted.
      // Rethrowing would cause create()/update() to return 500 even though
      // the plan was saved successfully, leaving an orphaned record.
      logger.error('[REGRESSION_PLAN_SERVICE] syncGitIntegration error (plan saved, git link failed)', {
        error: error instanceof Error ? error.message : String(error),
        planId: plan.id,
      });
    }
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
      automationConfig: row.automation_config || undefined,
      notificationsEnabled: row.notifications_enabled ?? true,
      scheduleId: row.schedule_id || undefined,
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

  // =========================================================================
  // SCOPE ITEMS — for "Create Regression" step 2 picker
  // =========================================================================

  /**
   * Get all modules, flows, and test cases for the scope picker.
   *
   * Returns three lists with counts and platform info, suitable for the
   * "Modules | Flows | Test Cases" tabs in the Create Regression modal.
   *
   * Query strategy (5 parallel queries):
   *   1. Modules with platform join
   *   2. Flows with module join (for platformKey)
   *   3. UI test case counts per flow
   *   4. API test case counts per flow
   *   5. Flow counts per module
   */
  static async getScopeItems(
    projectId: string,
    userId: string
  ): Promise<{
    modules: Array<{
      id: string;
      name: string;
      platformKey: 'web_ui' | 'api';
      testCount: number;
      flowCount: number;
    }>;
    flows: Array<{
      id: string;
      moduleId: string;
      name: string;
      flowType: string;
      platformKey: 'web_ui' | 'api';
      testCount: number;
    }>;
    testCases: Array<{
      id: string;
      flowId: string;
      moduleId: string;
      name: string;
      testType: 'ui' | 'api';
      platformKey: 'web_ui' | 'api';
    }>;
  }> {
    // 1. Fetch modules + platforms, flows + module platform, and all test cases in parallel
    const [modulesResult, flowsResult, uiTestCasesResult, apiTestCasesResult] = await Promise.all([
      // Modules with platform_key
      supabaseAdmin
        .from('test_modules')
        .select('id, name, platform_id, test_platforms!inner(platform_key)')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('name', { ascending: true }),

      // Flows with module_id (to resolve platformKey via module)
      supabaseAdmin
        .from('test_flows')
        .select('id, module_id, name, flow_type')
        .eq('user_id', userId)
        .order('order_index', { ascending: true }),

      // UI test cases
      supabaseAdmin
        .from('intent_test_cases')
        .select('id, flow_id, name')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),

      // API test cases
      supabaseAdmin
        .from('api_test_configs')
        .select('id, flow_id, name')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
    ]);

    if (modulesResult.error) {
      throw new Error(`Failed to get modules: ${modulesResult.error.message}`);
    }
    if (flowsResult.error) {
      throw new Error(`Failed to get flows: ${flowsResult.error.message}`);
    }

    const modules = modulesResult.data || [];
    const allFlows = flowsResult.data || [];
    const uiTestCases = uiTestCasesResult.data || [];
    const apiTestCases = apiTestCasesResult.data || [];

    // Build lookup: moduleId → platformKey
    const modulePlatformMap = new Map<string, 'web_ui' | 'api'>();
    const moduleIdSet = new Set<string>();
    for (const m of modules) {
      const pk = (m.test_platforms as any)?.platform_key as 'web_ui' | 'api';
      modulePlatformMap.set(m.id, pk);
      moduleIdSet.add(m.id);
    }

    // Filter flows to only those belonging to this project's modules
    const projectFlows = allFlows.filter((f: any) => moduleIdSet.has(f.module_id));

    // Build lookup: flowId → moduleId
    const flowModuleMap = new Map<string, string>();
    for (const f of projectFlows) {
      flowModuleMap.set(f.id, f.module_id);
    }
    const projectFlowIds = new Set(projectFlows.map((f: any) => f.id));

    // Count test cases per flow
    const flowUiCount = new Map<string, number>();
    const flowApiCount = new Map<string, number>();

    for (const tc of uiTestCases) {
      if (tc.flow_id && projectFlowIds.has(tc.flow_id)) {
        flowUiCount.set(tc.flow_id, (flowUiCount.get(tc.flow_id) || 0) + 1);
      }
    }
    for (const tc of apiTestCases) {
      if (tc.flow_id && projectFlowIds.has(tc.flow_id)) {
        flowApiCount.set(tc.flow_id, (flowApiCount.get(tc.flow_id) || 0) + 1);
      }
    }

    // Count flows + tests per module
    const moduleFlowCount = new Map<string, number>();
    const moduleTestCount = new Map<string, number>();
    for (const f of projectFlows) {
      const mid = f.module_id;
      moduleFlowCount.set(mid, (moduleFlowCount.get(mid) || 0) + 1);
      const tc = (flowUiCount.get(f.id) || 0) + (flowApiCount.get(f.id) || 0);
      moduleTestCount.set(mid, (moduleTestCount.get(mid) || 0) + tc);
    }

    // Build response
    const scopeModules = modules.map((m: any) => ({
      id: m.id,
      name: m.name,
      platformKey: modulePlatformMap.get(m.id) || 'web_ui',
      testCount: moduleTestCount.get(m.id) || 0,
      flowCount: moduleFlowCount.get(m.id) || 0,
    }));

    const scopeFlows = projectFlows.map((f: any) => ({
      id: f.id,
      moduleId: f.module_id,
      name: f.name,
      flowType: f.flow_type,
      platformKey: modulePlatformMap.get(f.module_id) || 'web_ui',
      testCount: (flowUiCount.get(f.id) || 0) + (flowApiCount.get(f.id) || 0),
    }));

    // Build test cases list with platform info
    const scopeTestCases: Array<{
      id: string;
      flowId: string;
      moduleId: string;
      name: string;
      testType: 'ui' | 'api';
      platformKey: 'web_ui' | 'api';
    }> = [];

    for (const tc of uiTestCases) {
      if (tc.flow_id && projectFlowIds.has(tc.flow_id)) {
        const moduleId = flowModuleMap.get(tc.flow_id) || '';
        scopeTestCases.push({
          id: tc.id,
          flowId: tc.flow_id,
          moduleId,
          name: tc.name,
          testType: 'ui',
          platformKey: modulePlatformMap.get(moduleId) || 'web_ui',
        });
      }
    }

    for (const tc of apiTestCases) {
      if (tc.flow_id && projectFlowIds.has(tc.flow_id)) {
        const moduleId = flowModuleMap.get(tc.flow_id) || '';
        scopeTestCases.push({
          id: tc.id,
          flowId: tc.flow_id,
          moduleId,
          name: tc.name,
          testType: 'api',
          platformKey: modulePlatformMap.get(moduleId) || 'api',
        });
      }
    }

    return {
      modules: scopeModules,
      flows: scopeFlows,
      testCases: scopeTestCases,
    };
  }

  // ---------------------------------------------------------------------------
  // PLAN HEALTH REPORT
  // ---------------------------------------------------------------------------

  /**
   * Get plan health report with run history and flaky tests
   */
  static async getPlanHealthReport(
    planId: string,
    historyLimit: number = 10,
  ): Promise<PlanHealthReport> {
    // Clamp historyLimit
    const limit = Math.min(Math.max(historyLimit, 1), 50);

    // Get recent runs for this plan
    const { data: runs, error } = await supabaseAdmin
      .from('regression_runs')
      .select('id, status, started_at, completed_at, summary')
      .eq('plan_id', planId)
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error || !runs || runs.length === 0) {
      return {
        currentHealth: 'unknown',
        passRate: 0,
        history: [],
        flakyTests: [],
      };
    }

    const runIds = runs.map((r: any) => r.id);
    const healthMap = await this.batchGetRunHealths(runIds);

    // Build history — frontend expects `id` not `runId`
    const history = runs.map((run: any) => {
      const health = healthMap.get(run.id);
      return {
        id: run.id,
        // Normalize 'completed' → 'passed' for frontend compatibility
        status: run.status === 'completed' ? 'passed' : run.status,
        passRate: health?.passRate || 0,
        startedAt: run.started_at,
        bugsFound: run.summary?.bugs_count ?? run.summary?.bugsFound ?? 0,
      };
    });

    // Current health = most recent run's state as string
    const latestHealth = healthMap.get(runIds[0]);
    const currentHealth: PlanHealthReport['currentHealth'] = latestHealth?.state || 'unknown';
    const passRate = latestHealth?.passRate || 0;

    // Detect flaky tests across all these runs
    const flakyTests = await this.detectFlakyTests(runIds);

    return { currentHealth, passRate, history, flakyTests };
  }

  /**
   * Detect flaky tests across multiple runs
   * Flaky = fail rate between 10% and 90%
   */
  private static async detectFlakyTests(runIds: string[]): Promise<FlakyTest[]> {
    if (!runIds.length) return [];

    const { data: executions } = await supabaseAdmin
      .from('test_executions')
      .select('test_case_id, status')
      .in('run_id', runIds)
      .in('status', ['passed', 'failed']);

    if (!executions || executions.length === 0) return [];

    // Group by test_case_id
    const groups = new Map<string, { total: number; failures: number }>();
    for (const exec of executions) {
      if (!exec.test_case_id) continue;
      const g = groups.get(exec.test_case_id) || { total: 0, failures: 0 };
      g.total++;
      if (exec.status === 'failed') g.failures++;
      groups.set(exec.test_case_id, g);
    }

    // Filter flaky (fail rate 10%-90%) and require at least 2 runs
    const flakyIds: string[] = [];
    const flakyData = new Map<string, { total: number; failures: number; failRate: number }>();
    for (const [id, g] of groups) {
      if (g.total < 2) continue;
      const failRate = Math.round((g.failures / g.total) * 100);
      if (failRate >= 10 && failRate <= 90) {
        flakyIds.push(id);
        flakyData.set(id, { ...g, failRate });
      }
    }

    if (!flakyIds.length) return [];

    // Get names
    const { data: names } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name')
      .in('id', flakyIds);

    const nameMap = new Map<string, string>();
    for (const n of names || []) {
      nameMap.set(n.id, n.name);
    }

    return flakyIds.map((id) => {
      const d = flakyData.get(id)!;
      return {
        testCaseId: id,
        testCaseName: nameMap.get(id) || 'Unknown',
        failRate: d.failRate,
        totalRuns: d.total,
        failures: d.failures,
      };
    });
  }
}
