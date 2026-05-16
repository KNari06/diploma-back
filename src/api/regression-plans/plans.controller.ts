/**
 * Regression Plans Controller
 * API endpoints for regression plans CRUD
 */

import { supabaseAdmin } from '@/db/supabase';
import { ExecutionService } from '@/services/testing/executions/execution.service';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { TestReportGeneratorService } from '@/services/testing/results/test-report-generator.service';
import {
  AUDIT_EVENTS,
  WorkspaceAuditService,
  getAuditContext,
} from '@/services/core/workspace-audit.service';
import { NotFoundError, ValidationError } from '@/types';
import type { PlanItemType, TestType } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string; role: string };
}

function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new Error('User ID not found');
  return userId;
}

/**
 * Admin snapshot for audit metadata. Used in delete/addItem/removeItem so the
 * audit row survives even when getById's user-filter would skip it. The
 * caller's mutation enforces access; this read just reads name/projectId.
 */
async function loadPlanForAudit(
  planId: string,
): Promise<{ projectId: string; name: string } | null> {
  const { data } = await supabaseAdmin
    .from('regression_plans')
    .select('project_id, name')
    .eq('id', planId)
    .maybeSingle();
  if (!data) return null;
  return { projectId: (data as any).project_id, name: (data as any).name };
}

/**
 * Create a new regression plan
 */
export async function createPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const {
      projectId,
      name,
      description,
      isDefault,
      tags,
      automationConfig,
      notificationsEnabled,
      // Optional bulk initial items — when present, plan + items are
      // created atomically (rollback on any item failure). Frontend
      // wizard sends this to collapse N round-trips into 1. Other
      // callsites that add items to an EXISTING plan still use the
      // dedicated `POST /plans/:id/items` endpoint (addItem below).
      items,
    } = req.body;

    if (!projectId || !name) {
      res.status(400).json({ success: false, error: 'projectId and name are required' });
      return;
    }

    if (items !== undefined && !Array.isArray(items)) {
      res.status(400).json({ success: false, error: 'items must be an array when provided' });
      return;
    }

    const userId = getUserId(req);

    const plan = await RegressionPlanService.create({
      projectId,
      userId,
      name,
      description,
      isDefault,
      tags,
      automationConfig,
      notificationsEnabled,
      items,
    });

    res.json({ success: true, data: plan, timestamp: new Date() });

    void WorkspaceAuditService.logForProject({
      projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.REGRESSION_PLAN_CREATED,
      targetType: 'regression_plan',
      targetId: plan.id,
      metadata: { name: plan.name, is_default: plan.isDefault },
      ...getAuditContext(req),
    });
  } catch (error) {
    logger.error('[PLANS_API] Failed to create plan', { error });
    handleError(res, error, 'Failed to create plan');
  }
}

/**
 * Get a plan by ID with items
 */
export async function getPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const plan = await RegressionPlanService.getWithItems(id, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    // Enrich with health, scope, lastRun (same as listByProject but for single plan)
    const enriched = await RegressionPlanService.enrichPlanWithStats(plan);

    res.json({ success: true, data: enriched, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to get plan', { error });
    handleError(res, error, 'Failed to get plan');
  }
}

/**
 * List plans for a project
 */
export async function listPlans(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }

    const userId = getUserId(req);

    // No caching — health state is computed from live execution data and must
    // always reflect the latest run results. Previously a 30-min cache caused
    // the list to show stale health state (e.g. "passing") while the detail
    // page (uncached) correctly showed the current state (e.g. "failing").
    const plans = await RegressionPlanService.listByProject(projectId, userId);

    res.json({ success: true, data: plans, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to list plans', { error });
    handleError(res, error, 'Failed to list plans');
  }
}

/**
 * Update a plan
 */
export async function updatePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description, isDefault, tags, automationConfig, notificationsEnabled } = req.body;
    const userId = getUserId(req);

    const plan = await RegressionPlanService.update({
      id,
      userId,
      name,
      description,
      isDefault,
      tags,
      automationConfig,
      notificationsEnabled,
    });

    res.json({ success: true, data: plan, timestamp: new Date() });

    if (plan.projectId) {
      const changedFields = Object.entries({
        name,
        description,
        isDefault,
        tags,
        automationConfig,
        notificationsEnabled,
      })
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      void WorkspaceAuditService.logForProject({
        projectId: plan.projectId,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.REGRESSION_PLAN_UPDATED,
        targetType: 'regression_plan',
        targetId: id,
        metadata: { name: plan.name, changed_fields: changedFields },
        ...getAuditContext(req),
      });
    }
  } catch (error) {
    logger.error('[PLANS_API] Failed to update plan', { error });
    handleError(res, error, 'Failed to update plan');
  }
}

/**
 * Delete a plan
 */
export async function deletePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    // Admin snapshot — survives the user_id filter that getById applies.
    const planSnapshot = await loadPlanForAudit(id);

    await RegressionPlanService.delete(id, userId);

    res.json({ success: true, message: 'Plan deleted', timestamp: new Date() });

    if (planSnapshot) {
      void WorkspaceAuditService.logForProject({
        projectId: planSnapshot.projectId,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.REGRESSION_PLAN_DELETED,
        targetType: 'regression_plan',
        targetId: id,
        metadata: { name: planSnapshot.name },
        ...getAuditContext(req),
      });
    }
  } catch (error) {
    logger.error('[PLANS_API] Failed to delete plan', { error });
    handleError(res, error, 'Failed to delete plan');
  }
}

/**
 * Add an item to a plan
 */
export async function addItem(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { itemType, moduleId, flowId, testCaseId, testCaseType, parametersOverride } = req.body;
    const userId = getUserId(req);

    if (!itemType) {
      res.status(400).json({ success: false, error: 'itemType is required' });
      return;
    }

    const item = await RegressionPlanService.addItem({
      planId: id,
      itemType: itemType as PlanItemType,
      moduleId,
      flowId,
      testCaseId,
      testCaseType: testCaseType as TestType,
      parametersOverride,
    });

    res.json({ success: true, data: item, timestamp: new Date() });

    void (async () => {
      const plan = await loadPlanForAudit(id);
      if (!plan) return;
      await WorkspaceAuditService.logForProject({
        projectId: plan.projectId,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.REGRESSION_PLAN_ITEM_ADDED,
        targetType: 'regression_plan',
        targetId: id,
        metadata: {
          plan_name: plan.name,
          item_id: item.id,
          item_type: itemType,
          module_id: moduleId,
          flow_id: flowId,
          test_case_id: testCaseId,
        },
        ...getAuditContext(req),
      });
    })();
  } catch (error) {
    logger.error('[PLANS_API] Failed to add item', { error });
    handleError(res, error, 'Failed to add item');
  }
}

/**
 * Remove an item from a plan
 */
export async function removeItem(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id: planId, itemId } = req.params;
    const userId = getUserId(req);

    await RegressionPlanService.removeItem(itemId, userId);

    res.json({ success: true, message: 'Item removed', timestamp: new Date() });

    if (planId) {
      void (async () => {
        const plan = await loadPlanForAudit(planId);
        if (!plan) return;
        await WorkspaceAuditService.logForProject({
          projectId: plan.projectId,
          actorUserId: userId,
          eventType: AUDIT_EVENTS.REGRESSION_PLAN_ITEM_REMOVED,
          targetType: 'regression_plan',
          targetId: planId,
          metadata: { plan_name: plan.name, item_id: itemId },
          ...getAuditContext(req),
        });
      })();
    }
  } catch (error) {
    logger.error('[PLANS_API] Failed to remove item', { error });
    handleError(res, error, 'Failed to remove item');
  }
}

/**
 * Expand a plan to individual test cases
 */
export async function expandPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    // Verify ownership before expanding
    const plan = await RegressionPlanService.getById(id, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    const testCases = await RegressionPlanService.expandPlan(id);

    res.json({
      success: true,
      data: {
        testCases,
        totalCount: testCases.length,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[PLANS_API] Failed to expand plan', { error });
    handleError(res, error, 'Failed to expand plan');
  }
}

/**
 * Get scope items for regression plan builder (modules, flows, test cases with counts)
 */
export async function getScopeItems(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }

    const userId = getUserId(req);

    const data = await RegressionPlanService.getScopeItems(projectId, userId);

    res.json({ success: true, data, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to get scope items', { error });
    handleError(res, error, 'Failed to get scope items');
  }
}

/**
 * Get plan health report with trend history and flaky tests
 * Also accessible via /api/v1/regression/plans/:planId/health
 */
export async function getPlanHealthReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const planId = req.params.id || req.params.planId;
    const userId = getUserId(req);
    const historyLimit = Math.min(Math.max(parseInt(req.query.historyLimit as string) || 10, 1), 50);

    if (!planId) {
      res.status(400).json({ success: false, error: 'planId is required' });
      return;
    }

    // Verify ownership
    const plan = await RegressionPlanService.getById(planId, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    const report = await RegressionPlanService.getPlanHealthReport(planId, historyLimit);

    res.json({ success: true, data: report, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to get plan health', { error });
    handleError(res, error, 'Failed to get plan health');
  }
}

/**
 * Get bug summary aggregated from recent runs of a plan
 *
 * @route GET /api/v1/regression-plans/:id/bugs/summary
 * @query limit - number of recent runs to analyze (default 5, max 20)
 */
export async function getPlanBugsSummary(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);
    const runLimit = Math.min(Math.max(parseInt(req.query.limit as string) || 5, 1), 20);

    // Verify ownership
    const plan = await RegressionPlanService.getById(id, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    // Get latest N runs for this plan
    const { data: runs, error: runsError } = await supabaseAdmin
      .from('regression_runs')
      .select('id, started_at, status')
      .eq('plan_id', id)
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(runLimit);

    if (runsError || !runs || runs.length === 0) {
      res.json({
        success: true,
        data: {
          total: 0,
          distinct: 0,
          latestRunBugs: 0,
          recurringDistinct: 0,
          bySeverity: {},
          bySeverityDistinct: {},
          byCategory: {},
          topBugs: [],
          recentTrend: [],
          runsAnalyzed: 0,
        },
        timestamp: new Date(),
      });
      return;
    }

    const runIds = runs.map(r => r.id);

    // Get executions for all runs
    const { data: executions } = await supabaseAdmin
      .from('test_executions')
      .select('id, run_id, test_case_id, test_type, status, result')
      .in('run_id', runIds);

    // Extract testIds from UI executions
    const testIds: string[] = [];
    for (const exec of executions || []) {
      const testId = exec.result?.testId;
      if (testId && exec.test_type === 'ui') {
        testIds.push(testId);
      }
    }

    // Batch-fetch bugs from test_results and test_reports in parallel
    const [testResultsMap, testReports] = await Promise.all([
      RegressionRunService.batchGetTestResults(testIds),
      TestReportGeneratorService.batchGetReportsByTestIds(testIds),
    ]);

    const reportsMap = new Map<string, any>();
    for (const report of testReports) {
      reportsMap.set(report.testId, report);
    }

    // Aggregate bugs
    const validSeverities = new Set(['critical', 'high', 'medium', 'low']);
    const validCategories = new Set(['functional', 'performance', 'accessibility', 'visual', 'security']);
    const allBugs: any[] = [];

    // Deduplicate by normalized title, tracking per-run appearances (not just total count)
    // so we can report "seen in X/N runs" and distinguish recurring bugs from one-off ones.
    type BugAgg = {
      title: string;
      severity: string;
      category: string;
      occurrences: number;      // total count across all executions
      runIds: Set<string>;      // distinct runs where this bug appeared
      firstRunIndex: number;    // 0 = latest run (runs are sorted desc)
      lastRunIndex: number;
    };
    const bugOccurrences = new Map<string, BugAgg>();

    // runs are ordered by started_at DESC, so runs[0] is the latest
    const runIndexById = new Map<string, number>();
    runs.forEach((r, i) => runIndexById.set(r.id, i));

    // Track bugs per run for trend
    const bugsPerRun = new Map<string, number>();
    for (const runId of runIds) bugsPerRun.set(runId, 0);

    for (const exec of executions || []) {
      const testId = exec.result?.testId;
      if (!testId || exec.test_type !== 'ui') continue;

      const report = reportsMap.get(testId);
      const testResult = testResultsMap.get(testId);
      const rawBugSource = report?.analysis?.bugs || testResult?.ai_summary?.bugs || [];
      const rawBugs: any[] = Array.isArray(rawBugSource) ? rawBugSource : [];

      bugsPerRun.set(exec.run_id, (bugsPerRun.get(exec.run_id) || 0) + rawBugs.length);
      const runIndex = runIndexById.get(exec.run_id) ?? 0;

      for (const bug of rawBugs) {
        if (!bug || typeof bug !== 'object') continue;
        const title = bug.title || bug.message || bug.description || '';
        const severity = validSeverities.has(bug.severity) ? bug.severity : 'medium';
        const category = validCategories.has(bug.category) ? bug.category : 'functional';

        allBugs.push({ title, severity, category, runId: exec.run_id });

        const key = title.toLowerCase().trim();
        if (key) {
          const existing = bugOccurrences.get(key);
          if (existing) {
            existing.occurrences++;
            existing.runIds.add(exec.run_id);
            existing.firstRunIndex = Math.min(existing.firstRunIndex, runIndex);
            existing.lastRunIndex = Math.max(existing.lastRunIndex, runIndex);
          } else {
            bugOccurrences.set(key, {
              title,
              severity,
              category,
              occurrences: 1,
              runIds: new Set([exec.run_id]),
              firstRunIndex: runIndex,
              lastRunIndex: runIndex,
            });
          }
        }
      }
    }

    // bySeverity/byCategory: count occurrences (legacy, kept for compatibility)
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const bug of allBugs) {
      bySeverity[bug.severity] = (bySeverity[bug.severity] || 0) + 1;
      byCategory[bug.category] = (byCategory[bug.category] || 0) + 1;
    }

    // Distinct counts (what users mean by "how many bugs do I have")
    const bySeverityDistinct: Record<string, number> = {};
    for (const agg of bugOccurrences.values()) {
      bySeverityDistinct[agg.severity] = (bySeverityDistinct[agg.severity] || 0) + 1;
    }

    // Latest run = runs[0]. Headline numbers reflect freshness.
    const latestRunId = runs[0].id;
    const latestRunBugs = bugsPerRun.get(latestRunId) || 0;

    // Recurring = distinct bug titles seen in 2+ runs. Signal for "this isn't a one-off."
    let recurringDistinct = 0;
    for (const agg of bugOccurrences.values()) {
      if (agg.runIds.size >= 2) recurringDistinct++;
    }

    // Top bugs: surface recurring issues first, then by occurrence count.
    // Also include per-bug run-visibility data so UI can show "Seen in X/N runs".
    const topBugs = [...bugOccurrences.values()]
      .sort((a, b) => {
        if (b.runIds.size !== a.runIds.size) return b.runIds.size - a.runIds.size;
        return b.occurrences - a.occurrences;
      })
      .slice(0, 10)
      .map((agg) => ({
        title: agg.title,
        severity: agg.severity,
        category: agg.category,
        occurrences: agg.occurrences,
        runsSeen: agg.runIds.size,
        inLatestRun: agg.runIds.has(latestRunId),
      }));

    // Recent trend: bugs count per run
    const recentTrend = runs.map(r => ({
      runId: r.id,
      startedAt: r.started_at,
      bugsCount: bugsPerRun.get(r.id) || 0,
    }));

    res.json({
      success: true,
      data: {
        total: allBugs.length,                    // legacy: occurrences across all runs
        distinct: bugOccurrences.size,            // distinct bug titles across all runs
        latestRunBugs,                            // occurrences in most recent run (headline)
        recurringDistinct,                        // distinct bugs seen in 2+ runs
        bySeverity,                               // legacy: by occurrence
        bySeverityDistinct,                       // by distinct bug title
        byCategory,
        topBugs,
        recentTrend,
        runsAnalyzed: runs.length,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[PLANS_API] Failed to get plan bugs summary', { error });
    handleError(res, error, 'Failed to get plan bugs summary');
  }
}

/**
 * Get plan-level analytics (trend data over time)
 *
 * @route GET /api/v1/regression-plans/:id/analytics
 * @query metric (pass_rate|duration|flaky_rate), days? (default 30), interval? (1d default)
 */
export async function getPlanAnalytics(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);
    const metric = (req.query.metric as string) || 'pass_rate';
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
    const interval = (req.query.interval as string) || '1d';

    const validMetrics = ['pass_rate', 'duration', 'flaky_rate'];
    if (!validMetrics.includes(metric)) {
      res.status(400).json({ success: false, error: `metric must be one of: ${validMetrics.join(', ')}` });
      return;
    }

    // Verify ownership
    const plan = await RegressionPlanService.getById(id, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Fetch runs for this plan within date range
    const { data: runs, error: runsError } = await supabaseAdmin
      .from('regression_runs')
      .select('id, started_at, completed_at, status')
      .eq('plan_id', id)
      .eq('user_id', userId)
      .gte('started_at', startDate.toISOString())
      .order('started_at', { ascending: true });

    if (runsError || !runs || runs.length === 0) {
      res.json({
        success: true,
        data: { metric, interval, points: [] },
        timestamp: new Date(),
      });
      return;
    }

    const runIds = runs.map(r => r.id);

    // Batch-fetch executions for all runs
    const { data: executions } = await supabaseAdmin
      .from('test_executions')
      .select('id, run_id, test_case_id, status, started_at, completed_at, duration_ms')
      .in('run_id', runIds);

    // Group executions by run_id
    const execsByRun = new Map<string, any[]>();
    for (const exec of executions || []) {
      if (!execsByRun.has(exec.run_id)) execsByRun.set(exec.run_id, []);
      execsByRun.get(exec.run_id)!.push(exec);
    }

    // Compute metric per run
    const runMetrics: Array<{ date: string; value: number; runId: string }> = [];

    for (const run of runs) {
      const runExecs = execsByRun.get(run.id) || [];
      if (runExecs.length === 0) continue;

      let value: number;
      const dateStr = run.started_at ? new Date(run.started_at).toISOString().split('T')[0] : null;
      if (!dateStr) continue;

      if (metric === 'pass_rate') {
        const passed = runExecs.filter(e => e.status === 'passed').length;
        const total = runExecs.filter(e => e.status === 'passed' || e.status === 'failed').length;
        value = total > 0 ? Math.round((passed / total) * 10000) / 100 : 0;
      } else if (metric === 'duration') {
        if (run.started_at && run.completed_at) {
          const diff = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
          value = diff > 0 ? diff : 0;
        } else {
          continue;
        }
      } else {
        // flaky_rate: tests with mixed pass/fail across retries in same run
        const groupedByTestCase = new Map<string, Set<string>>();
        for (const exec of runExecs) {
          if (!groupedByTestCase.has(exec.test_case_id)) {
            groupedByTestCase.set(exec.test_case_id, new Set());
          }
          groupedByTestCase.get(exec.test_case_id)!.add(exec.status);
        }
        let flakyCount = 0;
        for (const statuses of groupedByTestCase.values()) {
          if (statuses.has('passed') && statuses.has('failed')) flakyCount++;
        }
        const uniqueTestCases = groupedByTestCase.size;
        value = uniqueTestCases > 0 ? Math.round((flakyCount / uniqueTestCases) * 10000) / 100 : 0;
      }

      runMetrics.push({ date: dateStr, value, runId: run.id });
    }

    // Bucket by day (interval)
    const intervalMs = parseIntervalMs(interval);
    const buckets = new Map<string, { values: number[]; runCount: number }>();

    for (const rm of runMetrics) {
      const bucketKey = getBucketKey(rm.date, intervalMs);
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { values: [], runCount: 0 });
      }
      const bucket = buckets.get(bucketKey)!;
      bucket.values.push(rm.value);
      bucket.runCount++;
    }

    const points = [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, { values, runCount }]) => ({
        date,
        value: metric === 'duration'
          ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
          : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
        runCount,
      }));

    res.json({
      success: true,
      data: { metric, interval, points },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[PLANS_API] Failed to get plan analytics', { error });
    handleError(res, error, 'Failed to get plan analytics');
  }
}

/**
 * Parse interval string to milliseconds
 */
function parseIntervalMs(interval: string): number {
  const match = interval.match(/^(\d+)(d|h|w)$/);
  if (!match) return 86400000; // default 1 day

  const num = parseInt(match[1]);
  switch (match[2]) {
    case 'h': return num * 3600000;
    case 'd': return num * 86400000;
    case 'w': return num * 604800000;
    default: return 86400000;
  }
}

/**
 * Get the bucket key (date string) for a given date and interval
 */
function getBucketKey(dateStr: string, intervalMs: number): string {
  if (intervalMs <= 86400000) {
    // Daily or finer: use the date as-is
    return dateStr;
  }
  // Weekly: round down to nearest interval start
  const timestamp = new Date(dateStr).getTime();
  const bucketStart = Math.floor(timestamp / intervalMs) * intervalMs;
  return new Date(bucketStart).toISOString().split('T')[0];
}

function handleError(res: Response, error: unknown, defaultMessage: string): void {
  if (res.headersSent) return;

  if (error instanceof NotFoundError) {
    res.status(404).json({ success: false, error: 'Not found', message: error.message });
    return;
  }

  if (error instanceof ValidationError) {
    res.status(422).json({ success: false, error: 'Validation error', message: error.message });
    return;
  }

  res.status(500).json({
    success: false,
    error: defaultMessage,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}
