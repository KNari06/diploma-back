/**
 * Analytics Query Service
 * Provides methods to query workspace analytics data
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { AIUsageQueryService } from '@/services/ai/tracking/ai-usage-query.service';
import { cache } from '@/utils/core/redis-cache';
import type {
  AnalyticsFilters,
  SummaryData,
  ResultsOverview,
  RecentFailure,
  RecentFailuresData,
  CriticalCheck,
  CriticalChecksData,
  HeatmapData,
  HeatmapDay,
  HeatmapMetric,
  HeatmapRange,
  DeploymentEntry,
  DeploymentsData,
  TimeSeriesData,
  TimeSeriesPoint,
  TimeSeriesInterval,
  BugInsightsData,
  BugInsightsRange,
  BugTrendPoint,
  RecurringBug,
} from './analytics.types';

// Analytics results change at most once per regression run, so 2 minutes is plenty.
const ANALYTICS_CACHE_TTL = 120; // seconds

/**
 * Analytics Query Service
 * Static methods for querying test analytics across workspace
 */
/**
 * Format milliseconds into a human-readable duration string
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export class AnalyticsQueryService {
  /**
   * Helper: Get all project IDs for a workspace
   */
  private static async getWorkspaceProjectIds(
    workspaceId: string,
    projectId?: string
  ): Promise<string[]> {
    try {
      let query = supabaseAdmin
        .from('projects')
        .select('id')
        .eq('workspace_id', workspaceId);

      if (projectId) {
        query = query.eq('id', projectId);
      }

      const { data, error } = await query;

      if (error) {
        logger.error('[ANALYTICS] Failed to get workspace projects', { error, workspaceId });
        throw new Error(`Failed to get projects: ${error.message}`);
      }

      return (data || []).map((p) => p.id);
    } catch (error) {
      logger.error('[ANALYTICS] Error getting workspace projects', { error, workspaceId });
      throw error;
    }
  }

  /**
   * Helper: Get regression run IDs for projects within date range
   */
  private static async getRunIdsForProjects(
    projectIds: string[],
    startDate?: Date,
    endDate?: Date
  ): Promise<string[]> {
    if (projectIds.length === 0) {
      return [];
    }

    try {
      let query = supabaseAdmin
        .from('regression_runs')
        .select('id')
        .in('project_id', projectIds);

      if (startDate) {
        query = query.gte('started_at', startDate.toISOString());
      }
      if (endDate) {
        query = query.lte('started_at', endDate.toISOString());
      }

      const { data, error } = await query;

      if (error) {
        logger.error('[ANALYTICS] Failed to get run IDs', { error, projectIds });
        throw new Error(`Failed to get run IDs: ${error.message}`);
      }

      return (data || []).map((r) => r.id);
    } catch (error) {
      logger.error('[ANALYTICS] Error getting run IDs', { error });
      throw error;
    }
  }

  /**
   * Combined helper: resolve projectIds + runIds in one cached call.
   * Avoids repeated sequential cascade when multiple analytics methods
   * are called with the same filters (e.g. dashboard fires 5+ in parallel).
   */
  private static async getWorkspaceRunContext(
    workspaceId: string,
    projectId?: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<{ projectIds: string[]; runIds: string[] }> {
    const cKey = `qait:cache:analytics:run-ctx:${workspaceId}:${projectId ?? '*'}:${startDate?.toISOString() ?? '*'}:${endDate?.toISOString() ?? '*'}`;
    const cached = await cache.get<{ projectIds: string[]; runIds: string[] }>(cKey);
    if (cached) return cached;

    const projectIds = await this.getWorkspaceProjectIds(workspaceId, projectId);
    if (projectIds.length === 0) return { projectIds: [], runIds: [] };

    const runIds = await this.getRunIdsForProjects(projectIds, startDate, endDate);
    const result = { projectIds, runIds };

    // fire-and-forget (cache is fail-safe)
    cache.set(cKey, result, ANALYTICS_CACHE_TTL);
    return result;
  }

  /**
   * Helper: Get API test executions for projects within date range
   */
  private static async getApiTestExecutions(
    projectIds: string[],
    startDate?: Date,
    endDate?: Date
  ): Promise<any[]> {
    if (projectIds.length === 0) return [];

    try {
      let query = supabaseAdmin
        .from('api_test_executions')
        .select('id, success, duration_ms, executed_at, error_message, request_data, workspace_id, project_id')
        .in('project_id', projectIds);

      if (startDate) {
        query = query.gte('executed_at', startDate.toISOString());
      }
      if (endDate) {
        query = query.lte('executed_at', endDate.toISOString());
      }

      const { data, error } = await query;

      if (error) {
        logger.error('[ANALYTICS] Failed to get API test executions', { error, projectIds });
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('[ANALYTICS] Error getting API test executions', { error });
      return [];
    }
  }

  /**
   * Helper: Get failed API test executions for recent failures list
   */
  private static async getApiTestFailures(
    projectIds: string[],
    limit: number
  ): Promise<RecentFailure[]> {
    if (projectIds.length === 0) return [];

    try {
      const { data, error } = await supabaseAdmin
        .from('api_test_executions')
        .select('id, success, error_message, executed_at, request_data, project_id')
        .in('project_id', projectIds)
        .eq('success', false)
        .not('executed_at', 'is', null)
        .order('executed_at', { ascending: false })
        .limit(limit);

      if (error || !data) return [];

      return data.map((f: any) => {
        const method = f.request_data?.method || 'API';
        const url = f.request_data?.url || 'Unknown';
        const shortUrl = url.length > 60 ? url.substring(0, 60) + '...' : url;

        return {
          id: f.id,
          testCaseName: `${method} ${shortUrl}`,
          testCaseId: f.id,
          runId: f.id,
          status: 'failed' as const,
          errorMessage: f.error_message,
          severity: 'failure' as const,
          failedAt: f.executed_at,
          timeAgo: this.getTimeAgo(f.executed_at),
          source: 'api_test' as const,
        };
      });
    } catch (error) {
      logger.error('[ANALYTICS] Error getting API test failures', { error });
      return [];
    }
  }

  /**
   * Helper: Calculate time ago string
   */
  private static getTimeAgo(date: string): string {
    const now = new Date();
    const past = new Date(date);
    const diffMs = now.getTime() - past.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  }

  /**
   * Get summary data (top cards + status + performance)
   */
  static async getSummary(filters: AnalyticsFilters): Promise<SummaryData> {
    // Cache key includes all filter dimensions so different date ranges don't collide
    const cKey = `qait:cache:analytics:summary:${filters.workspaceId}:${filters.projectId ?? '*'}:${filters.startDate?.toISOString() ?? '*'}:${filters.endDate?.toISOString() ?? '*'}`;
    const cached = await cache.get<SummaryData>(cKey);
    if (cached) return cached;

    try {
      const { projectIds, runIds } = await this.getWorkspaceRunContext(
        filters.workspaceId, filters.projectId, filters.startDate, filters.endDate
      );

      if (projectIds.length === 0) {
        return this.getEmptySummary();
      }

      // Parallel queries for performance
      const [executionsResult, runsResult, tokensResult, scheduleResult, apiTestExecs] = await Promise.all([
        // Test executions (steps) — only query if we have run IDs
        runIds.length > 0
          ? supabaseAdmin
              .from('test_executions')
              .select('status, duration_ms, run_id, test_case_id')
              .in('run_id', runIds)
          : Promise.resolve({ data: [], error: null }),

        // Regression runs
        supabaseAdmin
          .from('regression_runs')
          .select('id, status, started_at, completed_at')
          .in('project_id', projectIds)
          .gte('started_at', filters.startDate?.toISOString() || '2020-01-01T00:00:00.000Z')
          .lte('started_at', filters.endDate?.toISOString() || new Date().toISOString())
          .order('completed_at', { ascending: false }),

        // AI tokens (reuse existing service)
        AIUsageQueryService.getWorkspaceUsageStats(
          filters.workspaceId,
          filters.startDate,
          filters.endDate
        ),

        // Next schedule — use maybeSingle() to avoid error when no rows
        supabaseAdmin
          .from('test_schedules')
          .select('cron_expression, next_run_at, last_run_at')
          .in('project_id', projectIds)
          .eq('is_active', true)
          .order('next_run_at', { ascending: true })
          .limit(1)
          .maybeSingle(),

        // API test executions
        this.getApiTestExecutions(projectIds, filters.startDate, filters.endDate),
      ]);

      const executions = executionsResult.data || [];
      const runs = runsResult.data || [];
      const tokens = tokensResult;
      const schedule = scheduleResult.data;

      // API test stats
      const apiTestsRun = apiTestExecs.length;
      const apiTestsPassed = apiTestExecs.filter((e: any) => e.success === true).length;
      const apiTestsFailed = apiTestExecs.filter((e: any) => e.success === false).length;

      // Calculate summary stats
      const testStepsRun = executions.length;
      const totalRuns = runs.length;
      const tokensSpent = Math.round(tokens.totalTokens);
      // Count runs that have at least one failed status (not individual failed steps)
      const failedRunIds = new Set(
        executions.filter((e) => e.status === 'failed').map((e) => e.run_id)
      );
      const failedRunsCount = failedRunIds.size;

      // Flaky detection: find test cases with multiple executions in same run with mixed results
      const flakySteps = this.calculateFlakySteps(executions as any[]);

      const passedSteps = executions.filter((e) => e.status === 'passed').length;
      const failedSteps = executions.filter((e) => e.status === 'failed').length;
      const completed = passedSteps + failedSteps;
      const passRate = completed > 0 ? Math.round((passedSteps / completed) * 100 * 10) / 10 : 0;

      // Status determination
      const criticalFailures = executions.filter((e) => e.status === 'failed').length;
      const state: 'passing' | 'warning' | 'failing' =
        criticalFailures === 0 ? 'passing' : criticalFailures < 5 ? 'warning' : 'failing';
      const message =
        state === 'passing'
          ? 'All critical user flows passing'
          : state === 'warning'
          ? `${criticalFailures} test step${criticalFailures > 1 ? 's' : ''} failing`
          : `${criticalFailures} critical failures detected`;

      const lastRunAt = runs.length > 0 && runs[0].completed_at ? runs[0].completed_at : null;

      // Performance metrics
      const completedRuns = runs.filter(
        (r) => r.completed_at && r.started_at
      );
      const durations = completedRuns
        .map((r) => {
          const start = new Date(r.started_at).getTime();
          const end = new Date(r.completed_at).getTime();
          return end - start;
        })
        .filter((d) => d > 0 && Number.isFinite(d));
      const avgRunTimeMs = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;

      const failedRuns = runs.filter((r) => r.status === 'failed').length;
      const finishedRuns = runs.filter(
        (r) => r.status === 'failed' || r.status === 'passed' || r.status === 'completed'
      );
      const failureRate = finishedRuns.length > 0
        ? Math.round((failedRuns / finishedRuns.length) * 100 * 10) / 10
        : 0;

      // Calculate runs per minute from actual data window
      let runsPerMinute = 0;
      if (completedRuns.length >= 2) {
        const timestamps = completedRuns.map((r) => new Date(r.started_at).getTime());
        const earliest = Math.min(...timestamps);
        const latest = Math.max(...timestamps);
        const windowMinutes = (latest - earliest) / 60000;
        runsPerMinute = windowMinutes > 0
          ? Math.round((completedRuns.length / windowMinutes) * 10) / 10
          : 0;
      }

      const result: SummaryData = {
        summary: {
          testStepsRun,
          totalRuns,
          tokensSpent,
          failedRuns: failedRunsCount,
          flakySteps,
          passRate,
          apiTestsRun: apiTestsRun > 0 ? apiTestsRun : undefined,
          apiTestsPassed: apiTestsRun > 0 ? apiTestsPassed : undefined,
          apiTestsFailed: apiTestsRun > 0 ? apiTestsFailed : undefined,
        },
        status: {
          state,
          message,
          lastRunAt,
          nextSchedule: schedule
            ? {
                cronExpression: schedule.cron_expression,
                nextRunAt: schedule.next_run_at,
              }
            : null,
        },
        performance: {
          avgRunTimeMs,
          avgRunTimeFormatted: formatDuration(avgRunTimeMs),
          failureRate,
          runsPerMinute,
        },
      };

      // Cache the result — fire-and-forget (don't block the response)
      cache.set(cKey, result, ANALYTICS_CACHE_TTL).catch((err) =>
        logger.warn('[ANALYTICS] Failed to cache summary', { err })
      );

      return result;
    } catch (error) {
      logger.error('[ANALYTICS] Failed to get summary', { error, filters });
      throw error;
    }
  }

  /**
   * Helper: Calculate flaky steps count
   * Flaky = same test_case_id + run_id with both passed and failed executions
   */
  private static calculateFlakySteps(executions: Array<{ run_id: string; test_case_id: string; status: string }>): number {
    const groupKey = (e: any) => `${e.run_id}:${e.test_case_id}`;
    const groups = new Map<string, Set<string>>();

    for (const exec of executions) {
      const key = groupKey(exec);
      if (!groups.has(key)) {
        groups.set(key, new Set());
      }
      groups.get(key)!.add(exec.status);
    }

    let flakyCount = 0;
    for (const statuses of groups.values()) {
      if (statuses.has('passed') && statuses.has('failed')) {
        flakyCount++;
      }
    }

    return flakyCount;
  }

  /**
   * Get empty summary (when no data)
   */
  private static getEmptySummary(): SummaryData {
    return {
      summary: {
        testStepsRun: 0,
        totalRuns: 0,
        tokensSpent: 0,
        failedRuns: 0,
        flakySteps: 0,
        passRate: 0,
      },
      status: {
        state: 'passing',
        message: 'No test data available',
        lastRunAt: null,
        nextSchedule: null,
      },
      performance: {
        avgRunTimeMs: 0,
        avgRunTimeFormatted: '0s',
        failureRate: 0,
        runsPerMinute: 0,
      },
    };
  }

  /**
   * Get results overview (donut chart data)
   */
  static async getResultsOverview(filters: AnalyticsFilters): Promise<ResultsOverview> {
    // Cache key includes all filter dimensions
    const cKey = `qait:cache:analytics:results-overview:${filters.workspaceId}:${filters.projectId ?? '*'}:${filters.startDate?.toISOString() ?? '*'}:${filters.endDate?.toISOString() ?? '*'}`;
    const cached = await cache.get<ResultsOverview>(cKey);
    if (cached) return cached;

    try {
      const { projectIds, runIds } = await this.getWorkspaceRunContext(
        filters.workspaceId, filters.projectId, filters.startDate, filters.endDate
      );

      if (projectIds.length === 0) {
        return { passed: 0, failed: 0, skipped: 0, flaky: 0, total: 0, percentages: { passed: 0, failed: 0, skipped: 0, flaky: 0 } };
      }

      if (runIds.length === 0) {
        return { passed: 0, failed: 0, skipped: 0, flaky: 0, total: 0, percentages: { passed: 0, failed: 0, skipped: 0, flaky: 0 } };
      }

      const [execResult, apiTestExecs] = await Promise.all([
        supabaseAdmin
          .from('test_executions')
          .select('status, run_id, test_case_id')
          .in('run_id', runIds),
        this.getApiTestExecutions(projectIds, filters.startDate, filters.endDate),
      ]);

      const execs = execResult.data || [];
      const passed = execs.filter((e) => e.status === 'passed').length;
      // Count unique test_case_ids that have at least one failed execution
      const failedTestCaseIds = new Set(
        execs.filter((e) => e.status === 'failed').map((e) => e.test_case_id)
      );
      const failed = failedTestCaseIds.size;
      const skipped = execs.filter((e) => e.status === 'skipped').length;
      const flaky = this.calculateFlakySteps(execs as any[]);
      const total = execs.length;

      const percentages = {
        passed: total > 0 ? Math.round((passed / total) * 100 * 10) / 10 : 0,
        failed: total > 0 ? Math.round((failed / total) * 100 * 10) / 10 : 0,
        skipped: total > 0 ? Math.round((skipped / total) * 100 * 10) / 10 : 0,
        flaky: total > 0 ? Math.round((flaky / total) * 100 * 10) / 10 : 0,
      };

      // API test breakdown
      const apiTotal = apiTestExecs.length;
      const apiPassed = apiTestExecs.filter((e: any) => e.success === true).length;
      const apiFailed = apiTestExecs.filter((e: any) => e.success === false).length;

      const result: ResultsOverview = {
        passed, failed, skipped, flaky, total, percentages,
        apiTests: apiTotal > 0 ? { total: apiTotal, passed: apiPassed, failed: apiFailed } : undefined,
      };

      // Cache the result — fire-and-forget
      cache.set(cKey, result, ANALYTICS_CACHE_TTL).catch((err) =>
        logger.warn('[ANALYTICS] Failed to cache results overview', { err })
      );

      return result;
    } catch (error) {
      logger.error('[ANALYTICS] Failed to get results overview', { error, filters });
      throw error;
    }
  }

  /**
   * Get recent failures
   */
  static async getRecentFailures(
    workspaceId: string,
    projectId?: string,
    limit: number = 10
  ): Promise<RecentFailuresData> {
    try {
      const projectIds = await this.getWorkspaceProjectIds(workspaceId, projectId);

      if (projectIds.length === 0) {
        return { failures: [] };
      }

      const runIds = await this.getRunIdsForProjects(projectIds);

      // Build regression failures list (only if we have run IDs)
      let result: RecentFailure[] = [];

      if (runIds.length > 0) {
        // Get recent failed executions
        const { data: failures } = await supabaseAdmin
          .from('test_executions')
          .select('id, run_id, test_case_id, status, error_message, completed_at')
          .in('run_id', runIds)
          .eq('status', 'failed')
          .not('completed_at', 'is', null)
          .order('completed_at', { ascending: false })
          .limit(limit);

        if (failures && failures.length > 0) {
          // Get test case names and priorities (separate query — no FK between tables)
          const testCaseIds = [...new Set(failures.map((f) => f.test_case_id))];
          const [testCasesResult, allExecutionsResult] = await Promise.all([
            supabaseAdmin
              .from('intent_test_cases')
              .select('id, name, priority')
              .in('id', testCaseIds),
            // Check for recovery (later passed execution)
            supabaseAdmin
              .from('test_executions')
              .select('test_case_id, status, completed_at')
              .in('test_case_id', testCaseIds)
              .in('status', ['passed', 'failed'])
              .order('completed_at', { ascending: false }),
          ]);

          const testCaseMap = new Map<string, { name: string; priority: string | null }>();
          for (const tc of testCasesResult.data || []) {
            testCaseMap.set(tc.id, { name: tc.name, priority: tc.priority });
          }

          const recoveryMap = new Map<string, boolean>();
          for (const exec of allExecutionsResult.data || []) {
            if (!recoveryMap.has(exec.test_case_id) && exec.status === 'passed') {
              recoveryMap.set(exec.test_case_id, true);
            }
          }

          result = failures.map((f: any) => {
            const testCase = testCaseMap.get(f.test_case_id);
            const isRecovered = recoveryMap.get(f.test_case_id) || false;
            const priority = testCase?.priority || 'medium';

            let severity: 'failure' | 'warn' | 'recovered';
            if (isRecovered) {
              severity = 'recovered';
            } else if (priority === 'critical' || priority === 'high') {
              severity = 'failure';
            } else {
              severity = 'warn';
            }

            return {
              id: f.id,
              testCaseName: testCase?.name || 'Unknown Test',
              testCaseId: f.test_case_id,
              runId: f.run_id,
              status: 'failed' as const,
              errorMessage: f.error_message,
              severity,
              failedAt: f.completed_at,
              timeAgo: this.getTimeAgo(f.completed_at),
              source: 'regression' as const,
            };
          });
        }
      }

      // Also get failed API test executions
      const apiFailures = await this.getApiTestFailures(projectIds, limit);

      // Merge and sort by date descending, then limit
      const allFailures = [...result, ...apiFailures]
        .sort((a, b) => new Date(b.failedAt).getTime() - new Date(a.failedAt).getTime())
        .slice(0, limit);

      return { failures: allFailures };
    } catch (error) {
      logger.error('[ANALYTICS] Failed to get recent failures', { error, workspaceId });
      throw error;
    }
  }

  /**
   * Get critical checks status
   */
  static async getCriticalChecks(
    workspaceId: string,
    projectId?: string
  ): Promise<CriticalChecksData> {
    try {
      const projectIds = await this.getWorkspaceProjectIds(workspaceId, projectId);

      if (projectIds.length === 0) {
        return { checks: [] };
      }

      // Get all critical test cases
      const { data: criticalCases } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name, project_id')
        .in('project_id', projectIds)
        .eq('priority', 'critical')
        .eq('status', 'published');

      if (!criticalCases || criticalCases.length === 0) {
        return { checks: [] };
      }

      const criticalCaseIds = criticalCases.map((c) => c.id);

      // Get latest execution for each critical test case
      const { data: latestExecutions } = await supabaseAdmin
        .from('test_executions')
        .select('test_case_id, status, completed_at, run_id')
        .in('test_case_id', criticalCaseIds)
        .not('completed_at', 'is', null)
        .order('completed_at', { ascending: false });

      // Map latest execution per test case
      const executionMap = new Map<string, any>();
      for (const exec of latestExecutions || []) {
        if (!executionMap.has(exec.test_case_id)) {
          executionMap.set(exec.test_case_id, exec);
        }
      }

      const checks: CriticalCheck[] = criticalCases.map((testCase) => {
        const latestExec = executionMap.get(testCase.id);

        let status: 'ok' | 'failed' | 'unknown';
        if (!latestExec) {
          status = 'unknown';
        } else if (latestExec.status === 'passed') {
          status = 'ok';
        } else if (latestExec.status === 'failed') {
          status = 'failed';
        } else {
          status = 'unknown';
        }

        return {
          id: testCase.id,
          name: testCase.name,
          status,
          lastRunAt: latestExec?.completed_at || null,
          lastRunId: latestExec?.run_id || null,
        };
      });

      return { checks };
    } catch (error) {
      logger.error('[ANALYTICS] Failed to get critical checks', { error, workspaceId });
      throw error;
    }
  }

  /**
   * Get heatmap data
   */
  static async getHeatmap(
    workspaceId: string,
    metric: HeatmapMetric,
    range: HeatmapRange,
    projectId?: string
  ): Promise<HeatmapData> {
    try {
      const projectIds = await this.getWorkspaceProjectIds(workspaceId, projectId);

      if (projectIds.length === 0) {
        return { days: [], maxCount: 0, totalCount: 0 };
      }

      const rangeDays = range === '30d' ? 30 : range === '90d' ? 90 : 365;
      const since = new Date();
      since.setDate(since.getDate() - rangeDays);

      let dailyCounts: Map<string, number>;

      if (metric === 'runs') {
        const [runsResult, apiExecsResult] = await Promise.all([
          supabaseAdmin
            .from('regression_runs')
            .select('started_at')
            .in('project_id', projectIds)
            .gte('started_at', since.toISOString())
            .not('started_at', 'is', null),
          supabaseAdmin
            .from('api_test_executions')
            .select('executed_at')
            .in('project_id', projectIds)
            .gte('executed_at', since.toISOString())
            .not('executed_at', 'is', null),
        ]);

        dailyCounts = new Map();
        for (const run of runsResult.data || []) {
          const dateKey = run.started_at.split('T')[0];
          dailyCounts.set(dateKey, (dailyCounts.get(dateKey) || 0) + 1);
        }
        for (const exec of apiExecsResult.data || []) {
          const dateKey = exec.executed_at.split('T')[0];
          dailyCounts.set(dateKey, (dailyCounts.get(dateKey) || 0) + 1);
        }
      } else if (metric === 'failures') {
        const runIds = await this.getRunIdsForProjects(projectIds, since);
        dailyCounts = new Map();

        // Regression test failures + API test failures in parallel
        const [regressionFailures, apiFailures] = await Promise.all([
          runIds.length > 0
            ? supabaseAdmin
                .from('test_executions')
                .select('completed_at')
                .in('run_id', runIds)
                .eq('status', 'failed')
                .not('completed_at', 'is', null)
            : Promise.resolve({ data: [] }),
          supabaseAdmin
            .from('api_test_executions')
            .select('executed_at')
            .in('project_id', projectIds)
            .eq('success', false)
            .gte('executed_at', since.toISOString())
            .not('executed_at', 'is', null),
        ]);

        for (const exec of regressionFailures.data || []) {
          const dateKey = exec.completed_at.split('T')[0];
          dailyCounts.set(dateKey, (dailyCounts.get(dateKey) || 0) + 1);
        }
        for (const exec of apiFailures.data || []) {
          const dateKey = exec.executed_at.split('T')[0];
          dailyCounts.set(dateKey, (dailyCounts.get(dateKey) || 0) + 1);
        }
      } else {
        // flaky metric
        const runIds = await this.getRunIdsForProjects(projectIds, since);
        dailyCounts = new Map();

        if (runIds.length > 0) {
          const { data: executions } = await supabaseAdmin
            .from('test_executions')
            .select('run_id, test_case_id, status, completed_at')
            .in('run_id', runIds)
            .not('completed_at', 'is', null);

          // Find flaky tests per day
          const groupByDate = new Map<string, Array<any>>();

          for (const exec of executions || []) {
            const dateKey = exec.completed_at.split('T')[0];
            if (!groupByDate.has(dateKey)) {
              groupByDate.set(dateKey, []);
            }
            groupByDate.get(dateKey)!.push(exec);
          }

          for (const [date, execs] of groupByDate.entries()) {
            const flakyCount = this.calculateFlakySteps(execs);
            if (flakyCount > 0) {
              dailyCounts.set(date, flakyCount);
            }
          }
        }
      }

      // Calculate levels (quartiles)
      const counts = Array.from(dailyCounts.values());
      const maxCount = counts.length > 0 ? Math.max(...counts) : 0;
      const totalCount = counts.reduce((a, b) => a + b, 0);

      const days: HeatmapDay[] = [];
      const now = new Date();
      // Use UTC dates consistently (DB timestamps are ISO/UTC)
      const startUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - rangeDays));
      for (let i = 0; i <= rangeDays; i++) {
        const date = new Date(startUtc.getTime() + i * 86400000);
        const dateKey = date.toISOString().split('T')[0];
        const count = dailyCounts.get(dateKey) || 0;

        let level: 0 | 1 | 2 | 3 | 4;
        if (count === 0) {
          level = 0;
        } else if (maxCount === 0) {
          level = 0;
        } else {
          const ratio = count / maxCount;
          if (ratio <= 0.25) level = 1;
          else if (ratio <= 0.5) level = 2;
          else if (ratio <= 0.75) level = 3;
          else level = 4;
        }

        days.push({ date: dateKey, count, level });
      }

      return { days, maxCount, totalCount };
    } catch (error) {
      logger.error('[ANALYTICS] Failed to get heatmap', { error, workspaceId, metric, range });
      throw error;
    }
  }

  /**
   * Get recent deployments
   */
  static async getRecentDeployments(
    workspaceId: string,
    projectId?: string,
    limit: number = 5
  ): Promise<DeploymentsData> {
    try {
      const projectIds = await this.getWorkspaceProjectIds(workspaceId, projectId);

      if (projectIds.length === 0) {
        return { deployments: [] };
      }

      // Check if git integrations exist
      const { data: integrations } = await supabaseAdmin
        .from('git_integrations')
        .select('id, project_id')
        .in('project_id', projectIds);

      if (!integrations || integrations.length === 0) {
        return { deployments: [] };
      }

      const integrationIds = integrations.map((i) => i.id);

      const { data: deliveries } = await supabaseAdmin
        .from('git_webhook_deliveries')
        .select('id, integration_id, provider, event_type, payload, status, received_at, regression_run_id')
        .in('integration_id', integrationIds)
        .in('status', ['processed', 'received', 'queued'])
        .order('received_at', { ascending: false })
        .limit(limit);

      if (!deliveries || deliveries.length === 0) {
        return { deployments: [] };
      }

      // Collect run IDs to look up their statuses
      const runIds = deliveries
        .map((d: any) => d.regression_run_id)
        .filter((id: string | null): id is string => !!id);

      let runStatusMap = new Map<string, string>();
      if (runIds.length > 0) {
        const { data: runs } = await supabaseAdmin
          .from('regression_runs')
          .select('id, status')
          .in('id', runIds);

        if (runs) {
          for (const run of runs) {
            runStatusMap.set(run.id, run.status);
          }
        }
      }

      const deployments: DeploymentEntry[] = deliveries.map((d: any) => {
        const payload = d.payload || {};
        const version = payload.release?.tag_name || payload.ref?.split('/').pop() || null;
        const branch = payload.ref || null;
        const runId = d.regression_run_id || null;

        // Determine deployment status from linked regression run
        let deploymentStatus: 'passed' | 'regression_flagged' | 'pending' | 'no_tests' = 'no_tests';
        if (runId && runStatusMap.has(runId)) {
          const runStatus = runStatusMap.get(runId)!;
          if (runStatus === 'passed' || runStatus === 'completed') {
            deploymentStatus = 'passed';
          } else if (runStatus === 'failed') {
            deploymentStatus = 'regression_flagged';
          } else if (['pending', 'running', 'queued'].includes(runStatus)) {
            deploymentStatus = 'pending';
          }
        }

        return {
          id: d.id,
          version,
          eventType: d.event_type,
          provider: d.provider,
          status: deploymentStatus,
          branch,
          deliveredAt: d.received_at,
          runId,
        };
      });

      return { deployments };
    } catch (error) {
      logger.error('[ANALYTICS] Failed to get deployments', { error, workspaceId });
      throw error;
    }
  }

  /**
   * Get time series data
   */
  static async getTimeSeries(
    filters: AnalyticsFilters & { interval: TimeSeriesInterval }
  ): Promise<TimeSeriesData> {
    try {
      const projectIds = await this.getWorkspaceProjectIds(filters.workspaceId, filters.projectId);

      if (projectIds.length === 0) {
        return { points: [], interval: filters.interval };
      }

      // Default lookback window based on interval so chart isn't empty for infrequent runs
      const defaultLookbackMs: Record<string, number> = {
        '1m':  60 * 60 * 1000,          // 1 hour
        '5m':  6 * 60 * 60 * 1000,      // 6 hours
        '15m': 24 * 60 * 60 * 1000,     // 24 hours
        '1h':  7 * 24 * 60 * 60 * 1000, // 7 days
        '1d':  30 * 24 * 60 * 60 * 1000, // 30 days
      };
      const lookback = defaultLookbackMs[filters.interval] || 3600000;
      const startIso = filters.startDate?.toISOString() || new Date(Date.now() - lookback).toISOString();
      const endIso = filters.endDate?.toISOString() || new Date().toISOString();

      const [runsResult, apiExecsResult] = await Promise.all([
        supabaseAdmin
          .from('regression_runs')
          .select('started_at, status')
          .in('project_id', projectIds)
          .gte('started_at', startIso)
          .lte('started_at', endIso)
          .not('started_at', 'is', null)
          .order('started_at', { ascending: true }),
        supabaseAdmin
          .from('api_test_executions')
          .select('executed_at, success')
          .in('project_id', projectIds)
          .gte('executed_at', startIso)
          .lte('executed_at', endIso)
          .not('executed_at', 'is', null),
      ]);

      const runs = runsResult.data || [];
      const apiExecs = apiExecsResult.data || [];

      if (runs.length === 0 && apiExecs.length === 0) {
        return { points: [], interval: filters.interval };
      }

      // Bucket by interval
      const intervalMs = this.getIntervalMs(filters.interval);
      const buckets = new Map<number, { total: number; passed: number; failed: number; apiTests: number }>();

      for (const run of runs) {
        const timestamp = new Date(run.started_at).getTime();
        const bucketKey = Math.floor(timestamp / intervalMs) * intervalMs;

        if (!buckets.has(bucketKey)) {
          buckets.set(bucketKey, { total: 0, passed: 0, failed: 0, apiTests: 0 });
        }

        const bucket = buckets.get(bucketKey)!;
        bucket.total++;
        if (run.status === 'completed' || run.status === 'passed') bucket.passed++;
        if (run.status === 'failed') bucket.failed++;
      }

      for (const exec of apiExecs) {
        const timestamp = new Date(exec.executed_at).getTime();
        const bucketKey = Math.floor(timestamp / intervalMs) * intervalMs;

        if (!buckets.has(bucketKey)) {
          buckets.set(bucketKey, { total: 0, passed: 0, failed: 0, apiTests: 0 });
        }

        const bucket = buckets.get(bucketKey)!;
        bucket.total++;
        bucket.apiTests++;
        if (exec.success === true) bucket.passed++;
        else if (exec.success === false) bucket.failed++;
      }

      const points: TimeSeriesPoint[] = Array.from(buckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([timestamp, counts]) => ({
          timestamp: new Date(timestamp).toISOString(),
          totalRuns: counts.total,
          passedRuns: counts.passed,
          failedRuns: counts.failed,
          apiTestsRun: counts.apiTests > 0 ? counts.apiTests : undefined,
        }));

      return { points, interval: filters.interval };
    } catch (error) {
      logger.error('[ANALYTICS] Failed to get time series', { error, filters });
      throw error;
    }
  }

  /**
   * Helper: Convert interval string to milliseconds
   */
  private static getIntervalMs(interval: TimeSeriesInterval): number {
    switch (interval) {
      case '1m':
        return 60000;
      case '5m':
        return 300000;
      case '15m':
        return 900000;
      case '1h':
        return 3600000;
      case '1d':
        return 86400000;
      default:
        return 60000;
    }
  }

  /**
   * Get bug insights data (summary, trend, top recurring)
   */
  static async getBugInsights(
    workspaceId: string,
    range: BugInsightsRange = '30d',
    projectId?: string
  ): Promise<BugInsightsData> {
    const cKey = `qait:cache:analytics:bug-insights:${workspaceId}:${projectId ?? '*'}:${range}`;
    const cached = await cache.get<BugInsightsData>(cKey);
    if (cached) return cached;

    try {
      const projectIds = await this.getWorkspaceProjectIds(workspaceId, projectId);

      if (projectIds.length === 0) {
        return this.getEmptyBugInsights();
      }

      // Calculate date range
      const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : 90;
      const since = new Date();
      since.setDate(since.getDate() - rangeDays);

      // Get session IDs for these projects
      const { data: sessions } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id, started_at')
        .in('project_id', projectIds)
        .gte('started_at', since.toISOString());

      const sessionIds = (sessions || []).map(s => s.id);

      if (sessionIds.length === 0) {
        return this.getEmptyBugInsights();
      }

      // Fetch all bug findings for these sessions
      const { data: findings } = await supabaseAdmin
        .from('intelligent_test_findings')
        .select('id, title, severity, status, found_at')
        .in('session_id', sessionIds)
        .eq('finding_type', 'bug');

      const bugs = findings || [];

      if (bugs.length === 0) {
        return this.getEmptyBugInsights();
      }

      // --- Summary ---
      const totalBugs = bugs.length;
      const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
      let newBugs = 0;
      let fixedBugs = 0;

      for (const bug of bugs) {
        const sev = bug.severity as keyof typeof bySeverity;
        if (sev in bySeverity) bySeverity[sev]++;
        if (bug.status === 'new') newBugs++;
        if (bug.status === 'fixed' || bug.status === 'resolved') fixedBugs++;
      }

      // --- Trend (daily buckets with zero-fill) ---
      const dailyBuckets = new Map<string, { count: number; critical: number; high: number; medium: number; low: number }>();

      for (const bug of bugs) {
        const dateKey = bug.found_at ? bug.found_at.split('T')[0] : null;
        if (!dateKey) continue;

        if (!dailyBuckets.has(dateKey)) {
          dailyBuckets.set(dateKey, { count: 0, critical: 0, high: 0, medium: 0, low: 0 });
        }
        const bucket = dailyBuckets.get(dateKey)!;
        bucket.count++;
        const sev = bug.severity as 'critical' | 'high' | 'medium' | 'low';
        if (sev in bucket) bucket[sev]++;
      }

      // Zero-fill all days in range
      const trend: BugTrendPoint[] = [];
      const now = new Date();
      for (let i = rangeDays; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateKey = d.toISOString().split('T')[0];
        const bucket = dailyBuckets.get(dateKey);
        trend.push({
          date: dateKey,
          count: bucket?.count || 0,
          critical: bucket?.critical || 0,
          high: bucket?.high || 0,
          medium: bucket?.medium || 0,
          low: bucket?.low || 0,
        });
      }

      // --- Top recurring (group by normalized title) ---
      const titleMap = new Map<string, { count: number; severity: string; lastSeen: string }>();
      for (const bug of bugs) {
        const normalized = (bug.title || '').toLowerCase().trim();
        if (!normalized) continue;

        const existing = titleMap.get(normalized);
        if (existing) {
          existing.count++;
          if (bug.found_at && bug.found_at > existing.lastSeen) {
            existing.lastSeen = bug.found_at;
            existing.severity = bug.severity;
          }
        } else {
          titleMap.set(normalized, {
            count: 1,
            severity: bug.severity,
            lastSeen: bug.found_at || '',
          });
        }
      }

      const topRecurring: RecurringBug[] = Array.from(titleMap.entries())
        .map(([title, data]) => ({ title, ...data }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const result: BugInsightsData = {
        summary: { totalBugs, bySeverity, newBugs, fixedBugs },
        trend,
        topRecurring,
      };

      cache.set(cKey, result, ANALYTICS_CACHE_TTL).catch((err) =>
        logger.warn('[ANALYTICS] Failed to cache bug insights', { err })
      );

      return result;
    } catch (error) {
      logger.error('[ANALYTICS] Failed to get bug insights', { error, workspaceId, range });
      throw error;
    }
  }

  /**
   * Get empty bug insights (when no data)
   */
  private static getEmptyBugInsights(): BugInsightsData {
    return {
      summary: {
        totalBugs: 0,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
        newBugs: 0,
        fixedBugs: 0,
      },
      trend: [],
      topRecurring: [],
    };
  }
}
