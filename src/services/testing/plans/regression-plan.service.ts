/**
 * Regression Plan Service
 * CRUD operations for regression plans and their items
 */

import { supabaseAdmin } from '@/db/supabase';
import {
  PERMISSIONS,
  WorkspaceAccessService,
} from '@/services/core/workspace-access.service';
import { DEFAULT_VARIANT_LABEL, normaliseVariantOverride } from '@/services/mobile/project-mobile-app.helper';
import { GitIntegrationService } from '@/services/integrations/git-integration.service';
import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { ValidationError } from '@/types';
import { cache } from '@/utils/core/redis-cache';
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
 * Normalise a plan's mobile variant selection for storage. Blank / absent →
 * null (the default lane). The literal 'default' lane is also stored as null
 * so the run path has a single "no explicit variant" representation.
 */
function normalisePlanVariantLabel(raw: string | null | undefined): string | null {
  // Same trim-to-null as flow / test-case overrides, but a plan additionally
  // treats the literal 'default' lane as "inherit" (null).
  const v = normaliseVariantOverride(raw);
  return v === DEFAULT_VARIANT_LABEL ? null : v;
}

type RunStatus = RegressionPlanWithStats['lastRun'] extends { status: infer S } | null ? S : never;

function normaliseRunStatus(s: string): RunStatus {
  const valid = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);
  if (!valid.has(s)) {
    logger.warn('[REGRESSION_PLAN] Unexpected run status from DB — falling back to cancelled', { status: s });
    return 'cancelled';
  }
  return s as RunStatus;
}

/** Row shapes used by the batched plan expansion below. */
type FlowRow = { id: string; module_id: string | null };
type UiCaseRow = { id: string; name: string; platform: string | null; flow_id: string | null };
type ApiCaseRow = { id: string; name: string; flow_id: string | null };

/** Order-preserving de-dup for the id lists fed to `.in(...)` filters. */
function uniq(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * PostgREST answers an unbounded select with at most `db-max-rows` (1000 on
 * this project) and reports no error when it truncates — so a batched read
 * MUST page explicitly. Silent truncation here would drop test cases from an
 * expanded plan, i.e. a run that quietly skips tests.
 */
const SELECT_PAGE_SIZE = 1000;

/**
 * Ids per `.in(...)` filter. The batched reads replaced one query per flow
 * with one query per plan, so the id list is now unbounded — 500 uuids would
 * put ~19 KB of filter into the query string, past what proxies accept.
 */
const IN_CHUNK_SIZE = 100;

/** The slice of the Supabase builder `selectAllIn` needs. */
type PagedQuery = {
  range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
};

/**
 * Run an `.in(ids)` select to completion: ids chunked, each chunk paged until
 * a short page arrives. Chunks run concurrently, pages within a chunk in order.
 *
 * Throws on a query error rather than returning what it has. These reads feed
 * `runPlan`'s dispatch list, and a half-read plan looks exactly like a smaller
 * plan — the caller must be able to tell "no test cases" from "the read broke".
 */
async function selectAllIn<T>(
  ids: string[],
  label: string,
  build: (chunk: string[]) => PagedQuery,
): Promise<T[]> {
  if (ids.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) chunks.push(ids.slice(i, i + IN_CHUNK_SIZE));

  const perChunk = await Promise.all(
    chunks.map(async (chunk) => {
      const rows: T[] = [];
      for (let from = 0; ; from += SELECT_PAGE_SIZE) {
        const { data, error } = await build(chunk).range(from, from + SELECT_PAGE_SIZE - 1);

        if (error) {
          logger.error(`[REGRESSION_PLAN_SERVICE] ${label} failed`, { error, idCount: chunk.length, from });
          throw new Error(`${label} failed: ${(error as { message?: string })?.message ?? 'unknown error'}`);
        }

        const page = (data || []) as T[];
        rows.push(...page);
        if (page.length < SELECT_PAGE_SIZE) break;
      }
      return rows;
    }),
  );

  return perChunk.flat();
}

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
    const { projectId, userId, name, description, isDefault, tags, automationConfig, notificationsEnabled, mobileBuildMode, pinnedMobileAppBuildId, mobileVariantLabel, items } = params;

    logger.info('[REGRESSION_PLAN_SERVICE] Creating plan', {
      projectId,
      userId,
      name,
      hasAutomation: !!automationConfig,
      itemsCount: Array.isArray(items) ? items.length : 0,
    });

    // If setting as default, unset existing default
    if (isDefault) {
      await supabaseAdmin
        .from('regression_plans')
        .update({ is_default: false })
        .eq('project_id', projectId)
        .eq('is_default', true);
    }

    // Build pinning: defaulting `mobile_build_mode` here (not just in the
    // DB DEFAULT) means we don't depend on the column being present —
    // safer during the lazy rollout when some envs may run code ahead of
    // the migration. A 'pinned' mode with no buildId is normalised to
    // 'latest' so the resolver never has to special-case a half-set pin.
    const resolvedBuildMode: 'latest' | 'pinned' =
      mobileBuildMode === 'pinned' && pinnedMobileAppBuildId ? 'pinned' : 'latest';

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
        mobile_build_mode: resolvedBuildMode,
        pinned_mobile_app_build_id: resolvedBuildMode === 'pinned' ? pinnedMobileAppBuildId : null,
        mobile_variant_label: normalisePlanVariantLabel(mobileVariantLabel),
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to create plan', { error });
      throw new Error(`Failed to create plan: ${error.message}`);
    }

    const plan = this.mapToRegressionPlan(data);

    // Sync schedule and git integration if automation config provided.
    // syncSchedule now THROWS when an enabled schedule can't be created (was a
    // silent null → plan saved without a test_schedules row → scheduler never
    // fired). Roll the plan back so the user gets an error instead of a plan
    // that looks scheduled in the UI but never runs.
    if (automationConfig) {
      try {
        const scheduleId = await this.syncSchedule(plan, automationConfig.schedule);
        await this.syncGitIntegration(plan, automationConfig.gitTriggers);

        if (scheduleId) {
          await supabaseAdmin
            .from('regression_plans')
            .update({ schedule_id: scheduleId })
            .eq('id', plan.id);
          plan.scheduleId = scheduleId;
        }
      } catch (scheduleErr) {
        logger.error('[REGRESSION_PLAN_SERVICE] Schedule sync failed — rolling back plan', {
          planId: plan.id,
          error: scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr),
        });
        await supabaseAdmin
          .from('regression_plans')
          .delete()
          .eq('id', plan.id)
          .eq('user_id', userId);
        throw scheduleErr;
      }
    }

    // Bulk-add initial items in the same call so the wizard's
    // 21-round-trip "create plan + N×addItem" gets collapsed into 1
    // network request. If ANY item insert fails we delete the plan
    // back out so the user doesn't end up looking at a half-built
    // regression in the UI. Supabase doesn't expose transactions over
    // the REST API; this is best-effort rollback. Cascade FK on
    // `regression_plan_items.plan_id` cleans up any successfully-
    // inserted children automatically.
    if (Array.isArray(items) && items.length > 0) {
      try {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          await this.addItem({
            ...item,
            planId: plan.id,
            // Default orderIndex to array position so caller-supplied
            // order is preserved without each caller having to enumerate.
            orderIndex: item.orderIndex ?? i,
          });
        }
      } catch (itemErr) {
        logger.error('[REGRESSION_PLAN_SERVICE] Initial items add failed — rolling back plan', {
          planId: plan.id,
          itemsCount: items.length,
          error: itemErr instanceof Error ? itemErr.message : String(itemErr),
        });
        await supabaseAdmin
          .from('regression_plans')
          .delete()
          .eq('id', plan.id)
          .eq('user_id', userId);
        throw itemErr;
      }
    }

    // Invalidate plans list cache
    await cache.delByPattern(`qait:cache:plans:proj:${projectId}:*`);

    return plan;
  }

  /**
   * Get a plan by ID.
   *
   * Access model: the plan is readable by any active member of the
   * workspace that owns the plan's project — NOT only by the user who
   * originally created it. Plans live inside `projects`, which live
   * inside `workspaces`. The legacy `user_id` column on
   * `regression_plans` predates the workspace layer and was used as a
   * creator-only access gate; this caused symptoms where (a) teammates
   * couldn't open a `/regressions/<id>` URL shared by a co-worker, and
   * (b) every user saw a private slice of the same project's plans.
   *
   * The `user_id` column is kept as an audit-trail "who created this".
   * It's no longer the access gate.
   *
   * @param id - Plan ID
   * @param userId - Caller's user id, checked against workspace_members
   * @returns Plan or null if not found / no access
   */
  static async getById(id: string, userId: string): Promise<RegressionPlan | null> {
    // 1. Load the plan + its project's workspace_id in a single query.
    //    The implicit `projects!inner` join scopes the read to plans
    //    whose project still exists (defensive: avoids returning rows
    //    for projects mid-cascade-delete).
    const { data, error } = await supabaseAdmin
      .from('regression_plans')
      .select('*, projects!inner(workspace_id)')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Not found. Indistinguishable from "exists but the user has no
        // access" by design — we never leak existence to non-members.
        return null;
      }
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to get plan', { error, id });
      throw new Error(`Failed to get plan: ${error.message}`);
    }

    // 2. Authorize on workspace membership rather than user_id.
    //    `projects` is typed as a possibly-array relation by the
    //    Supabase client; with `!inner` on a many-to-one FK it's
    //    actually a single object — coerce defensively so a future
    //    type-gen change doesn't silently bypass the check.
    const projectRel = (data as { projects?: { workspace_id?: string } | { workspace_id?: string }[] }).projects;
    const workspaceId = Array.isArray(projectRel)
      ? projectRel[0]?.workspace_id
      : projectRel?.workspace_id;

    if (!workspaceId) {
      logger.warn('[REGRESSION_PLAN_SERVICE] Plan has no workspace_id (orphan project?)', { id });
      return null;
    }

    const allowed = await WorkspaceAccessService.hasPermission(
      userId,
      workspaceId,
      PERMISSIONS.PROJECT_READ,
    );
    if (!allowed) {
      // Same null shape as not-found — see comment on PGRST116 above.
      return null;
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
    // Access model mirrors getById: plans are readable by any active member of
    // the workspace that owns the project — NOT only by the creator. The legacy
    // `user_id` filter (removed below) caused two bugs: (a) non-owner members
    // saw zero plans; (b) callers that pass an unvalidated projectId (e.g. the
    // REST listPlans controller) relied on that filter as their only scoping,
    // so authorizing on workspace membership here also closes that gap.
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('workspace_id')
      .eq('id', projectId)
      .maybeSingle();

    const workspaceId = (project as { workspace_id?: string } | null)?.workspace_id;
    if (!workspaceId) {
      // Unknown project, or project mid-cascade-delete — no access, no leak.
      return [];
    }

    const allowed = await WorkspaceAccessService.hasPermission(
      userId,
      workspaceId,
      PERMISSIONS.PROJECT_READ,
    );
    if (!allowed) {
      return [];
    }

    const { data, error } = await supabaseAdmin
      .from('regression_plans')
      .select('*')
      .eq('project_id', projectId)
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
              status: normaliseRunStatus(lastRunRow.status),
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
            status: lastRunRow.status,
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

    // 2. Collect IDs for parallel resolution
    const allModuleIds = [
      ...new Set(
        allItems
          .filter((i) => i.item_type === 'module' && i.module_id)
          .map((i) => i.module_id as string)
      ),
    ];

    const testCaseIds = allItems
      .filter((i) => i.item_type === 'test_case' && i.test_case_id)
      .map((i) => i.test_case_id as string);

    // Queries 2 + 4 in parallel (both depend only on Query 1, independent of each other)
    const [moduleFlowMap, testCaseFlowMap] = await Promise.all([
      // Query 2: modules → flows
      (async () => {
        const map = new Map<string, string[]>();
        if (allModuleIds.length === 0) return map;
        const { data: moduleFlows } = await supabaseAdmin
          .from('test_flows')
          .select('id, module_id')
          .in('module_id', allModuleIds);
        for (const f of moduleFlows || []) {
          if (!map.has(f.module_id)) map.set(f.module_id, []);
          map.get(f.module_id)!.push(f.id);
        }
        return map;
      })(),
      // Query 4: test_cases → flow_id
      (async () => {
        const map = new Map<string, string | null>();
        if (testCaseIds.length === 0) return map;
        const { data: tcFlows } = await supabaseAdmin
          .from('intent_test_cases')
          .select('id, flow_id')
          .in('id', testCaseIds);
        for (const tc of tcFlows || []) {
          map.set(tc.id, tc.flow_id);
        }
        return map;
      })(),
    ]);

    // 3. Collect ALL flow IDs we need test counts for (depends on moduleFlowMap from Query 2)
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
    if (planIds.length === 0) return new Map();

    // Single query for all plans, ordered by started_at DESC.
    // Deduplicate in JS to keep only the latest run per plan_id.
    // Uses composite index idx_regression_runs_plan_started.
    const { data, error } = await supabaseAdmin
      .from('regression_runs')
      .select('id, plan_id, status, started_at, completed_at')
      .in('plan_id', planIds)
      .order('started_at', { ascending: false });

    if (error) {
      logger.error('[REGRESSION_PLAN_SERVICE] batchGetLatestRuns failed', { error });
      return new Map();
    }

    const result = new Map<
      string,
      { id: string; plan_id: string; status: string; started_at: string; completed_at: string | null }
    >();
    for (const row of data || []) {
      if (!result.has(row.plan_id)) {
        result.set(row.plan_id, row);
      }
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
        .select('run_id, test_case_id, status, result')
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

    // Group executions by run_id. Environment failures (the test never ran —
    // device attach / session setup) are dropped here so passRate / failed /
    // flaky all stay consistent with detectFlakyWithPlatformBreakdown, which
    // applies the same exclusion. Infrastructure noise is not a test outcome.
    const execsByRun = new Map<string, Array<{ test_case_id: string; status: string }>>();
    for (const exec of execsResult.data as any[]) {
      if (exec.status === 'failed' && exec.result?.failureCategory === 'environment') continue;
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
    const {
      id,
      userId,
      name,
      description,
      isDefault,
      tags,
      automationConfig,
      notificationsEnabled,
      mobileBuildMode,
      pinnedMobileAppBuildId,
      mobileVariantLabel,
    } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (tags !== undefined) updates.tags = tags;
    if (automationConfig !== undefined) updates.automation_config = automationConfig;
    if (notificationsEnabled !== undefined) updates.notifications_enabled = notificationsEnabled;

    // Capture the CURRENT automation_config before we overwrite it, so a later
    // syncSchedule failure can revert the row instead of leaving drift (see the
    // rollback in the automationConfig block below). Only needed when we're
    // actually changing automation_config.
    let priorAutomationConfig: unknown = undefined;
    if (automationConfig !== undefined) {
      const { data: prior } = await supabaseAdmin
        .from('regression_plans')
        .select('automation_config')
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle();
      priorAutomationConfig = prior?.automation_config ?? null;
    }

    // Mobile build pinning. The two fields can move together or
    // separately — caller might just toggle the mode, or just swap
    // which build is pinned. Switching mode to 'latest' clears the
    // pinned id explicitly so a stale UUID doesn't linger in the row.
    if (mobileBuildMode !== undefined) {
      updates.mobile_build_mode = mobileBuildMode;
      if (mobileBuildMode === 'latest') {
        updates.pinned_mobile_app_build_id = null;
      }
    }
    if (pinnedMobileAppBuildId !== undefined) {
      updates.pinned_mobile_app_build_id = pinnedMobileAppBuildId;
      // If the caller sets a buildId without also setting mode, assume
      // they want to pin. Setting to null without mode means "unpin".
      if (mobileBuildMode === undefined) {
        updates.mobile_build_mode = pinnedMobileAppBuildId ? 'pinned' : 'latest';
      }
    }
    // Variant selection — independent of the pin. `null` resets to the
    // default lane; `undefined` leaves the saved variant untouched.
    if (mobileVariantLabel !== undefined) {
      updates.mobile_variant_label = normalisePlanVariantLabel(mobileVariantLabel);
    }

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

    // Re-sync schedule and git integration when automation config changes.
    // syncSchedule THROWS on a failed enabled-schedule sync. The plan row above
    // already persisted the new automation_config (which may say the schedule is
    // enabled), so on a throw we must REVERT automation_config + schedule_id to
    // their prior values — otherwise the plan shows an enabled schedule in the UI
    // with no/stale test_schedules row (the exact silent drift create() rolls
    // back). We rethrow so the user still gets a real error.
    if (automationConfig !== undefined) {
      const priorScheduleId = plan.scheduleId;
      try {
        const scheduleId = await this.syncSchedule(plan, automationConfig?.schedule);
        await this.syncGitIntegration(plan, automationConfig?.gitTriggers);

        if (scheduleId !== plan.scheduleId) {
          await supabaseAdmin
            .from('regression_plans')
            .update({ schedule_id: scheduleId })
            .eq('id', plan.id);
          plan.scheduleId = scheduleId || undefined;
        }
      } catch (syncErr) {
        logger.error('[REGRESSION_PLAN_SERVICE] Schedule sync failed on update — reverting automation_config', {
          planId: plan.id,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        });
        await supabaseAdmin
          .from('regression_plans')
          .update({ automation_config: priorAutomationConfig ?? null, schedule_id: priorScheduleId ?? null })
          .eq('id', plan.id)
          .eq('user_id', userId);
        throw syncErr;
      }
    }

    // Invalidate plans list cache
    await cache.delByPattern(`qait:cache:plans:proj:${plan.projectId}:*`);

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

    // Invalidate plans list cache
    if (plan) {
      await cache.delByPattern(`qait:cache:plans:proj:${plan.projectId}:*`);
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

    // Invalidate plans list cache (scope changed)
    const { data: planForCache } = await supabaseAdmin
      .from('regression_plans')
      .select('project_id')
      .eq('id', planId)
      .maybeSingle();
    if (planForCache) {
      await cache.delByPattern(`qait:cache:plans:proj:${planForCache.project_id}:*`);
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

    // Invalidate plans list cache (scope changed)
    await cache.delByPattern(`qait:cache:plans:proj:${plan.projectId}:*`);
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

    logger.info('[REGRESSION_PLAN_SERVICE] Expanding plan', {
      planId,
      itemCount: items.length,
      items: items.map((i) => ({ itemType: i.itemType, moduleId: i.moduleId, flowId: i.flowId, testCaseId: i.testCaseId })),
    });

    // Resolution is batched, not per-item. The previous shape walked items
    // sequentially and issued 3 queries per flow (flow → intent_test_cases →
    // api_test_configs); a plan of 4 modules + 7 flows (43 flows total) cost
    // 133 serial round trips — ~46s against a remote Supabase, paid by every
    // caller including the regressions page's runs list. Everything below is
    // two waves of parallel `.in(...)` queries regardless of plan size.
    const moduleIds = uniq(items.filter((i) => i.itemType === 'module' && i.moduleId).map((i) => i.moduleId!));
    const directFlowIds = uniq(items.filter((i) => i.itemType === 'flow' && i.flowId).map((i) => i.flowId!));
    const uiCaseItemIds = uniq(items.filter((i) => i.itemType === 'test_case' && i.testCaseId && i.testCaseType === 'ui').map((i) => i.testCaseId!));
    const apiCaseItemIds = uniq(items.filter((i) => i.itemType === 'test_case' && i.testCaseId && i.testCaseType === 'api').map((i) => i.testCaseId!));

    // Wave 1 — everything resolvable straight from the item rows.
    const [flowsByModule, directFlowRows, uiCaseRows, apiCaseRows] = await Promise.all([
      this.fetchFlowsByModules(moduleIds),
      this.fetchFlowRows(directFlowIds),
      this.fetchUiCasesByIds(uiCaseItemIds),
      this.fetchApiCasesByIds(apiCaseItemIds),
    ]);

    // module → flows (fetch order preserved, same as the old per-module loop)
    const moduleFlowIds = new Map<string, string[]>();
    for (const id of moduleIds) moduleFlowIds.set(id, []);
    const flowModule = new Map<string, string | undefined>();
    for (const row of flowsByModule) {
      moduleFlowIds.get(row.module_id!)?.push(row.id);
      flowModule.set(row.id, row.module_id || undefined);
    }
    for (const row of directFlowRows) flowModule.set(row.id, row.module_id || undefined);

    const allFlowIds = uniq([...flowsByModule.map((f) => f.id), ...directFlowIds]);

    // Flows referenced only by a test_case item — their module context is not
    // known until the case rows come back, hence the second wave.
    const caseFlowIds = uniq(
      [...uiCaseRows, ...apiCaseRows]
        .map((c) => c.flow_id)
        .filter((id): id is string => !!id && !flowModule.has(id)),
    );

    // Wave 2
    const [flowCases, caseFlowRows] = await Promise.all([
      this.fetchCasesByFlows(allFlowIds),
      this.fetchFlowRows(caseFlowIds),
    ]);
    for (const row of caseFlowRows) flowModule.set(row.id, row.module_id || undefined);

    const expandFlowFromCache = (flowId: string): ExpandedTestCase[] => {
      const moduleId = flowModule.get(flowId);
      const cases: ExpandedTestCase[] = [];
      for (const tc of flowCases.ui.get(flowId) || []) {
        cases.push({
          testCaseId: tc.id,
          testType: 'ui',
          moduleId,
          flowId,
          name: tc.name,
          platform: tc.platform || undefined,
        });
      }
      for (const tc of flowCases.api.get(flowId) || []) {
        cases.push({
          testCaseId: tc.id,
          testType: 'api',
          moduleId,
          flowId,
          name: tc.name,
        });
      }
      return cases;
    };

    // Assemble in plan-item order — dispatch order is user-visible, so this
    // must match the old sequential walk exactly.
    const expandedCases: ExpandedTestCase[] = [];
    for (const item of items) {
      switch (item.itemType) {
        case 'module':
          if (item.moduleId) {
            const moduleCases = (moduleFlowIds.get(item.moduleId) || []).flatMap(expandFlowFromCache);
            logger.info('[REGRESSION_PLAN_SERVICE] Expanded module', { moduleId: item.moduleId, testCaseCount: moduleCases.length });
            expandedCases.push(...moduleCases);
          }
          break;
        case 'flow':
          if (item.flowId) {
            const flowCasesForItem = expandFlowFromCache(item.flowId);
            logger.info('[REGRESSION_PLAN_SERVICE] Expanded flow', { flowId: item.flowId, testCaseCount: flowCasesForItem.length });
            expandedCases.push(...flowCasesForItem);
          }
          break;
        case 'test_case':
          if (item.testCaseId && item.testCaseType) {
            const row = item.testCaseType === 'ui'
              ? uiCaseRows.find((c) => c.id === item.testCaseId)
              : apiCaseRows.find((c) => c.id === item.testCaseId);
            if (row) {
              expandedCases.push({
                testCaseId: row.id,
                testType: item.testCaseType,
                moduleId: row.flow_id ? flowModule.get(row.flow_id) : undefined,
                flowId: row.flow_id || undefined,
                name: row.name,
                platform: item.testCaseType === 'ui' ? (row as UiCaseRow).platform || undefined : undefined,
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

    // Expand negative test cases for enabled items
    try {
      const { NegativeToggleResolverService } = await import('./negative-toggle-resolver.service');
      const negativeCases = await NegativeToggleResolverService.expandNegatives(planId, deduplicated);
      if (negativeCases.length > 0) {
        logger.info('[REGRESSION_PLAN_SERVICE] Expanded negative test cases', {
          planId,
          negativeCount: negativeCases.length,
        });
        deduplicated.push(...negativeCases);
      }
    } catch (err) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to expand negatives, continuing without', {
        planId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return deduplicated;
  }

  /**
   * Member test-case IDs of a plan — the cheap subset of `expandPlan` for
   * callers that only need "does this id belong to the plan", such as the
   * runs list filtering ad-hoc runs of a plan's test cases. Skips names,
   * platforms, ordering and negative-toggle resolution.
   *
   * Negatives are included by SOURCE (all of them, stale or toggled-off
   * alike) rather than through the toggle resolver: a run that already
   * happened shouldn't disappear from history because someone later
   * disabled its negative.
   */
  static async getMemberTestCaseIds(planId: string): Promise<Set<string>> {
    const items = await this.getItems(planId);

    const moduleIds = uniq(items.filter((i) => i.itemType === 'module' && i.moduleId).map((i) => i.moduleId!));
    const directFlowIds = uniq(items.filter((i) => i.itemType === 'flow' && i.flowId).map((i) => i.flowId!));
    const directCaseIds = uniq(items.filter((i) => i.itemType === 'test_case' && i.testCaseId).map((i) => i.testCaseId!));

    const moduleFlows = await this.fetchFlowsByModules(moduleIds);
    const flowIds = uniq([...moduleFlows.map((f) => f.id), ...directFlowIds]);

    const flowCases = await this.fetchCasesByFlows(flowIds);

    const ids = new Set<string>(directCaseIds);
    const uiIds: string[] = [];
    for (const rows of flowCases.ui.values()) {
      for (const r of rows) { ids.add(r.id); uiIds.push(r.id); }
    }
    for (const rows of flowCases.api.values()) {
      for (const r of rows) ids.add(r.id);
    }

    // Ad-hoc runs of a negative test case carry the negative's own id.
    try {
      const { listNegativesBySources } = await import('@/services/testing/negative/db/negative.db');
      const negatives = await listNegativesBySources(uniq([...uiIds, ...directCaseIds]));
      for (const neg of negatives) ids.add(neg.id);
    } catch (err) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to include negatives in plan membership, continuing without', {
        planId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return ids;
  }

  /** Flows belonging to the given modules, in DB order. */
  private static async fetchFlowsByModules(moduleIds: string[]): Promise<FlowRow[]> {
    return selectAllIn<FlowRow>(moduleIds, 'flows-for-modules', (chunk) =>
      supabaseAdmin.from('test_flows').select('id, module_id').in('module_id', chunk),
    );
  }

  /** Flow rows by id — used only for their module context. */
  private static async fetchFlowRows(flowIds: string[]): Promise<FlowRow[]> {
    return selectAllIn<FlowRow>(flowIds, 'flows-by-id', (chunk) =>
      supabaseAdmin.from('test_flows').select('id, module_id').in('id', chunk),
    );
  }

  /** UI + API test cases of the given flows, grouped by flow id. */
  private static async fetchCasesByFlows(
    flowIds: string[],
  ): Promise<{ ui: Map<string, UiCaseRow[]>; api: Map<string, ApiCaseRow[]> }> {
    const ui = new Map<string, UiCaseRow[]>();
    const api = new Map<string, ApiCaseRow[]>();
    if (flowIds.length === 0) return { ui, api };

    const [uiRows, apiRows] = await Promise.all([
      selectAllIn<UiCaseRow>(flowIds, 'ui-cases-for-flows', (chunk) =>
        supabaseAdmin
          .from('intent_test_cases')
          .select('id, name, platform, flow_id')
          .in('flow_id', chunk)
          .not('status', 'eq', 'archived'),
      ),
      selectAllIn<ApiCaseRow>(flowIds, 'api-cases-for-flows', (chunk) =>
        supabaseAdmin.from('api_test_configs').select('id, name, flow_id').in('flow_id', chunk),
      ),
    ]);

    for (const row of uiRows) {
      if (!row.flow_id) continue;
      const arr = ui.get(row.flow_id) || [];
      arr.push(row);
      ui.set(row.flow_id, arr);
    }
    for (const row of apiRows) {
      if (!row.flow_id) continue;
      const arr = api.get(row.flow_id) || [];
      arr.push(row);
      api.set(row.flow_id, arr);
    }

    return { ui, api };
  }

  /** UI test cases by id (test_case plan items). */
  private static async fetchUiCasesByIds(ids: string[]): Promise<UiCaseRow[]> {
    return selectAllIn<UiCaseRow>(ids, 'ui-cases-by-id', (chunk) =>
      supabaseAdmin.from('intent_test_cases').select('id, name, platform, flow_id').in('id', chunk),
    );
  }

  /** API test cases by id (test_case plan items). */
  private static async fetchApiCasesByIds(ids: string[]): Promise<ApiCaseRow[]> {
    return selectAllIn<ApiCaseRow>(ids, 'api-cases-by-id', (chunk) =>
      supabaseAdmin.from('api_test_configs').select('id, name, flow_id').in('id', chunk),
    );
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
  /**
   * Sync the plan's automation schedule into a `test_schedules` row.
   *
   * Returns the schedule id (created/updated/existing), or `null` ONLY when the
   * schedule is legitimately absent/disabled. When the config says enabled but
   * the row cannot be created/updated, this THROWS — a silent null here is the
   * exact bug that let a plan be "created successfully" while the scheduler had
   * nothing to fire (UI showed "Every day at 23:00", but test_schedules was
   * empty and schedule_id stayed null). The caller surfaces the throw to the
   * user instead of persisting a half-configured plan.
   */
  private static async syncSchedule(
    plan: RegressionPlan,
    scheduleConfig?: PlanScheduleConfig
  ): Promise<string | null> {
    const existingScheduleId = plan.scheduleId;

    // No schedule config or disabled → deactivate existing. This is the ONLY
    // legitimate null return; any failure on the enabled path throws below.
    if (!scheduleConfig || !scheduleConfig.enabled) {
      if (existingScheduleId) {
        const { error } = await supabaseAdmin
          .from('test_schedules')
          .update({ is_active: false })
          .eq('id', existingScheduleId);
        if (error) {
          // Best-effort deactivation: log but don't fail the plan op — the
          // schedule simply stays active until the next sync, no data risk.
          logger.warn('[REGRESSION_PLAN_SERVICE] Failed to deactivate schedule', {
            error: error.message,
            planId: plan.id,
            scheduleId: existingScheduleId,
          });
        } else {
          logger.info('[REGRESSION_PLAN_SERVICE] Deactivated schedule', {
            planId: plan.id,
            scheduleId: existingScheduleId,
          });
        }
      }
      return null;
    }

    const cronExpression = scheduleConfig.customCron || this.buildCronExpression(scheduleConfig);
    const timezone = scheduleConfig.timezone || 'UTC';

    // Validate the cron BEFORE touching the DB so an unsatisfiable/invalid
    // expression fails with a clear message instead of a downstream throw.
    if (!ScheduleService.parseCron(cronExpression)) {
      throw new Error(
        `Schedule has an invalid cron expression: "${cronExpression}". Fix the schedule and try again.`
      );
    }
    // calculateNextRun throws on a structurally-valid-but-unsatisfiable cron.
    const nextRunAt = this.calculateNextRunFromSchedule(cronExpression, timezone);

    if (existingScheduleId) {
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
        throw new Error(`Failed to update the plan's schedule: ${error.message}`);
      }
      logger.info('[REGRESSION_PLAN_SERVICE] Updated schedule', {
        planId: plan.id,
        scheduleId: existingScheduleId,
        cronExpression,
      });
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

    if (error || !data) {
      logger.error('[REGRESSION_PLAN_SERVICE] Failed to create schedule', { error, planId: plan.id });
      throw new Error(`Failed to create the plan's schedule: ${error?.message || 'no row returned'}`);
    }

    logger.info('[REGRESSION_PLAN_SERVICE] Created schedule', {
      planId: plan.id,
      scheduleId: data.id,
      cronExpression,
    });
    return data.id;
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
   * Only links to existing integrations — user must create git-integration first via POST /git-integrations.
   * Priority: integrationId > repositoryUrl (lookup only) > first enabled integration (backward compatible).
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
        // Explicit integration ID — verify it belongs to this project
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
        const repositoryUrl = gitConfig.repositoryUrl.trim();
        let existing = await GitIntegrationService.findByProjectAndRepositoryUrl(
          plan.projectId,
          repositoryUrl
        );
        if (existing) {
          integration = { id: existing.id };
        } else {
          // Auto-create git_integrations row so webhooks find this plan (webhook_secret empty = no verification until user sets it)
          try {
            const provider = GitIntegrationService.detectProviderFromUrl(repositoryUrl);
            const created = await GitIntegrationService.createIntegration({
              projectId: plan.projectId,
              userId: plan.userId,
              provider,
              repositoryUrl,
              webhookSecret: '',
              events: ['push', 'pull_request', 'release'],
            });
            integration = { id: created.id };
            // The row is created with an EMPTY webhook_secret. The webhook path is
            // fail-closed, so until the user supplies a secret (frontend sends it on
            // the create/update integration call) this integration can NEVER fire —
            // every delivery is rejected for "no secret configured". Warn (queryable
            // in Loki) so a "my automation never runs" report is diagnosable.
            const secretless = !created.webhook_secret;
            logger[secretless ? 'warn' : 'info'](
              '[REGRESSION_PLAN_SERVICE] Auto-created git integration for plan',
              {
                planId: plan.id,
                integrationId: created.id,
                repositoryUrl: created.repository_url,
                provider: created.provider,
                secretless,
                willFire: !secretless,
              },
            );
          } catch (createError) {
            logger.warn('[REGRESSION_PLAN_SERVICE] Could not auto-create git integration (e.g. access denied or duplicate)', {
              planId: plan.id,
              projectId: plan.projectId,
              repositoryUrl,
              error: createError instanceof Error ? createError.message : String(createError),
            });
            return;
          }
        }
      } else {
        // Fallback: use first enabled integration for this project (backward compatible)
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
      // Pre-migration rows return null for these — default to 'latest'
      // so the run path doesn't have to handle absent values.
      mobileBuildMode: (row.mobile_build_mode as 'latest' | 'pinned') ?? 'latest',
      pinnedMobileAppBuildId: row.pinned_mobile_app_build_id ?? null,
      mobileVariantLabel: row.mobile_variant_label ?? null,
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
      negativeTestingEnabled: row.negative_testing_enabled ?? null,
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
      parentModuleId: string | null;
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
      /**
       * Raw `intent_test_cases.platform` value — `'web'`, `'mobile_android'`,
       * etc. Present for UI cases so the plan composer can distinguish mobile
       * from web inside a shared `web_ui` module and so reports can render
       * mobile-specific artifacts. Null/undefined for API cases.
       */
      platform?: string | null;
    }>;
  }> {
    // Phase 1: Fetch modules (scoped by project_id)
    const modulesResult = await supabaseAdmin
      .from('test_modules')
      .select('id, name, platform_id, parent_module_id, test_platforms(platform_key)')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('name', { ascending: true });

    if (modulesResult.error) {
      throw new Error(`Failed to get modules: ${modulesResult.error.message}`);
    }

    const modules = modulesResult.data || [];
    if (modules.length === 0) {
      return { modules: [], flows: [], testCases: [] };
    }

    // Build lookup: moduleId → platformKey
    const modulePlatformMap = new Map<string, 'web_ui' | 'api'>();
    const moduleIds: string[] = [];
    for (const m of modules) {
      const pk = (m.test_platforms as any)?.platform_key as 'web_ui' | 'api';
      modulePlatformMap.set(m.id, pk);
      moduleIds.push(m.id);
    }

    // Phase 2: Fetch flows (scoped by project's moduleIds) + UI test cases in parallel
    const [flowsResult, uiTestCasesResult] = await Promise.all([
      supabaseAdmin
        .from('test_flows')
        .select('id, module_id, name, flow_type')
        .in('module_id', moduleIds)
        .eq('user_id', userId)
        .order('order_index', { ascending: true }),

      supabaseAdmin
        .from('intent_test_cases')
        .select('id, flow_id, name, platform')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
    ]);

    if (flowsResult.error) {
      throw new Error(`Failed to get flows: ${flowsResult.error.message}`);
    }

    const projectFlows = flowsResult.data || [];
    const uiTestCases = uiTestCasesResult.data || [];
    const projectFlowIds = projectFlows.map((f: any) => f.id);

    // Phase 3: Fetch API test cases (scoped by project's flowIds)
    let apiTestCases: any[] = [];
    if (projectFlowIds.length > 0) {
      const apiResult = await supabaseAdmin
        .from('api_test_configs')
        .select('id, flow_id, name')
        .in('flow_id', projectFlowIds)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      apiTestCases = apiResult.data || [];
    }

    // Build lookup: flowId → moduleId
    const flowModuleMap = new Map<string, string>();
    for (const f of projectFlows) {
      flowModuleMap.set(f.id, f.module_id);
    }
    const projectFlowIdSet = new Set(projectFlowIds);

    // Count test cases per flow
    const flowUiCount = new Map<string, number>();
    const flowApiCount = new Map<string, number>();

    for (const tc of uiTestCases) {
      if (tc.flow_id && projectFlowIdSet.has(tc.flow_id)) {
        flowUiCount.set(tc.flow_id, (flowUiCount.get(tc.flow_id) || 0) + 1);
      }
    }
    for (const tc of apiTestCases) {
      if (tc.flow_id && projectFlowIdSet.has(tc.flow_id)) {
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
      parentModuleId: m.parent_module_id ?? null,
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
      platform?: string | null;
    }> = [];

    for (const tc of uiTestCases) {
      if (tc.flow_id && projectFlowIdSet.has(tc.flow_id)) {
        const moduleId = flowModuleMap.get(tc.flow_id) || '';
        scopeTestCases.push({
          id: tc.id,
          flowId: tc.flow_id,
          moduleId,
          name: tc.name,
          testType: 'ui',
          platformKey: modulePlatformMap.get(moduleId) || 'web_ui',
          // Raw per-case platform ('web' | 'mobile_android' | …). Plan
          // composer shows this as a badge and can filter by it.
          platform: tc.platform ?? null,
        });
      }
    }

    for (const tc of apiTestCases) {
      if (tc.flow_id && projectFlowIdSet.has(tc.flow_id)) {
        const moduleId = flowModuleMap.get(tc.flow_id) || '';
        scopeTestCases.push({
          id: tc.id,
          flowId: tc.flow_id,
          moduleId,
          name: tc.name,
          testType: 'api',
          platformKey: modulePlatformMap.get(moduleId) || 'api',
          platform: null,
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
        byPlatform: this.emptyHealthBreakdown(),
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

    // Detect flaky tests across all these runs + compute per-platform slices
    // in a single pass so we don't read `test_executions` twice. The flaky
    // detector already scans that table; we piggy-back on it to also tally
    // web / mobile / api totals.
    const { flakyTests, byPlatform } = await this.detectFlakyWithPlatformBreakdown(runIds);

    return { currentHealth, passRate, history, flakyTests, byPlatform };
  }

  /** Zero-filled slices for empty-state responses. Kept co-located with the
   *  method that uses it so the shape doesn't drift. */
  private static emptyHealthBreakdown(): PlanHealthReport['byPlatform'] {
    const zero = { runs: 0, passed: 0, failed: 0, flakyCount: 0 };
    return { web: { ...zero }, mobile: { ...zero }, api: { ...zero } };
  }

  /**
   * Detect flaky tests across multiple runs + compute per-platform totals
   * in a single pass. Flaky heuristic unchanged: fail rate 10–90% with
   * ≥2 runs of the same test case.
   *
   * Combines two previously-separate passes (flaky detection + platform
   * tally) so we only hit `test_executions` once per health report.
   *
   * Platform bucketing:
   *   - `test_executions.platform` (NULL → 'web') for UI rows.
   *   - `test_type === 'api'` → 'api' slice regardless of platform.
   *   - `mobile_*` → 'mobile' slice.
   *
   * Returns both the flaky list (each entry tagged with its platform)
   * AND the platform breakdown. Callers that don't need the breakdown
   * can ignore it — the extra work is a few kB of memory in the shared
   * scan. Kept as a private helper (old `detectFlakyTests` removed).
   */
  private static async detectFlakyWithPlatformBreakdown(
    runIds: string[],
  ): Promise<{
    flakyTests: FlakyTest[];
    byPlatform: PlanHealthReport['byPlatform'];
  }> {
    const byPlatform = this.emptyHealthBreakdown();
    if (!runIds.length) return { flakyTests: [], byPlatform };

    // Select platform + test_type so we can bucket without a second query.
    // `test_type` tells us API vs UI; `platform` tells us web vs mobile_*.
    // `result` carries the env-failure marker (failureCategory) the mobile job
    // stamps when a test never ran (device attach / session setup) — those are
    // excluded below so infrastructure noise doesn't inflate flaky / fail rates.
    const { data: executions } = await supabaseAdmin
      .from('test_executions')
      .select('test_case_id, status, platform, test_type, result')
      .in('run_id', runIds)
      .in('status', ['passed', 'failed']);

    if (!executions || executions.length === 0) {
      return { flakyTests: [], byPlatform };
    }

    // Single pass: tally per-platform AND group by test_case_id for flaky.
    const groups = new Map<string, { total: number; failures: number }>();
    // Track the platform of each test case so we can tag the flaky entry
    // without a second fetch. First-seen wins; executions for the same
    // case are expected to share a platform, which they do because
    // `intent_test_cases.platform` is denormalised onto test_executions
    // at createBatch time (Phase 2).
    const casePlatform = new Map<string, string | null>();

    for (const exec of executions as any[]) {
      // Environment failure = the test never actually ran (emulator stuck,
      // agent didn't attach). Infrastructure noise, not a test outcome —
      // exclude from BOTH the per-platform tally and flaky grouping so it
      // doesn't inflate a case's fail rate (the misleading "70% fail rate").
      if (exec.status === 'failed' && exec.result?.failureCategory === 'environment') {
        continue;
      }

      // Platform bucket
      const bucket = this.healthBucketFor(exec);
      byPlatform[bucket].runs++;
      if (exec.status === 'passed') byPlatform[bucket].passed++;
      else if (exec.status === 'failed') byPlatform[bucket].failed++;

      // Flaky grouping
      if (!exec.test_case_id) continue;
      const g = groups.get(exec.test_case_id) || { total: 0, failures: 0 };
      g.total++;
      if (exec.status === 'failed') g.failures++;
      groups.set(exec.test_case_id, g);
      if (!casePlatform.has(exec.test_case_id)) {
        casePlatform.set(exec.test_case_id, (exec as any).platform ?? null);
      }
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

    if (!flakyIds.length) return { flakyTests: [], byPlatform };

    // Tally flakyCount per bucket using the case-platform map we built
    // above. Cheaper than joining to intent_test_cases again.
    for (const id of flakyIds) {
      const bucket = this.healthBucketForPlatform(casePlatform.get(id) ?? null, false);
      byPlatform[bucket].flakyCount++;
    }

    // Get names
    const { data: names } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name')
      .in('id', flakyIds);

    const nameMap = new Map<string, string>();
    for (const n of names || []) {
      nameMap.set(n.id, n.name);
    }

    const flakyTests: FlakyTest[] = flakyIds.map((id) => {
      const d = flakyData.get(id)!;
      return {
        testCaseId: id,
        testCaseName: nameMap.get(id) || 'Unknown',
        failRate: d.failRate,
        totalRuns: d.total,
        failures: d.failures,
        platform: casePlatform.get(id) ?? null,
      };
    });

    return { flakyTests, byPlatform };
  }

  /** Which slice of the plan-health breakdown a `test_executions` row
   *  belongs to. Shared with `healthBucketForPlatform` — a thin wrapper so
   *  the logic lives in one place. */
  private static healthBucketFor(exec: {
    platform?: string | null;
    test_type?: string;
  }): 'web' | 'mobile' | 'api' {
    return this.healthBucketForPlatform(
      exec.platform ?? null,
      exec.test_type === 'api',
    );
  }

  private static healthBucketForPlatform(
    platform: string | null | undefined,
    isApi: boolean,
  ): 'web' | 'mobile' | 'api' {
    if (isApi) return 'api';
    if (platform && platform.startsWith('mobile_')) return 'mobile';
    return 'web';
  }
}
