/**
 * Analytics Query Service
 * Provides methods to query workspace analytics data
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { AIUsageQueryService } from '@/services/ai/tracking/ai-usage-query.service';
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
} from './analytics.types';

/**
 * Analytics Query Service
 * Static methods for querying test analytics across workspace
 */
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
    try {
      const projectIds = await this.getWorkspaceProjectIds(filters.workspaceId, filters.projectId);

      if (projectIds.length === 0) {
        return this.getEmptySummary();
      }

      const runIds = await this.getRunIdsForProjects(projectIds, filters.startDate, filters.endDate);

      // Parallel queries for performance
      const [executionsResult, runsResult, tokensResult, scheduleResult] = await Promise.all([
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
          .gte('started_at', filters.startDate?.toISOString() || '2020-01-01')
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
      ]);

      const executions = executionsResult.data || [];
      const runs = runsResult.data || [];
      const tokens = tokensResult;
      const schedule = scheduleResult.data;

      // Calculate summary stats
      const testStepsRun = executions.length;
      const totalRuns = runs.length;
      const tokensSpent = Math.round(tokens.totalTokens);
      const errorSteps = executions.filter((e) => e.status === 'failed').length;

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
      const durations = completedRuns.map((r) => {
        const start = new Date(r.started_at).getTime();
        const end = new Date(r.completed_at).getTime();
        return end - start;
      });
      const avgRunTimeMs = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;

      const failedRuns = runs.filter((r) => r.status === 'failed').length;
      const failureRate = runs.length > 0 ? Math.round((failedRuns / runs.length) * 100 * 10) / 10 : 0;

      // Calculate runs per minute (last hour of activity)
      const oneHourAgo = new Date(Date.now() - 3600000);
      const recentRuns = runs.filter(
        (r) => r.started_at && new Date(r.started_at) > oneHourAgo
      );
      const runsPerMinute = Math.round((recentRuns.length / 60) * 10) / 10;

      return {
        summary: {
          testStepsRun,
          totalRuns,
          tokensSpent,
          errorSteps,
          flakySteps,
          passRate,
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
          failureRate,
          runsPerMinute,
        },
      };
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
        errorSteps: 0,
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
        failureRate: 0,
        runsPerMinute: 0,
      },
    };
  }

  /**
   * Get results overview (donut chart data)
   */
  static async getResultsOverview(filters: AnalyticsFilters): Promise<ResultsOverview> {
    try {
      const projectIds = await this.getWorkspaceProjectIds(filters.workspaceId, filters.projectId);

      if (projectIds.length === 0) {
        return { passed: 0, failed: 0, skipped: 0, flaky: 0, total: 0, percentages: { passed: 0, failed: 0, skipped: 0, flaky: 0 } };
      }

      const runIds = await this.getRunIdsForProjects(projectIds, filters.startDate, filters.endDate);

      if (runIds.length === 0) {
        return { passed: 0, failed: 0, skipped: 0, flaky: 0, total: 0, percentages: { passed: 0, failed: 0, skipped: 0, flaky: 0 } };
      }

      const { data: executions } = await supabaseAdmin
        .from('test_executions')
        .select('status, run_id, test_case_id')
        .in('run_id', runIds);

      const execs = executions || [];
      const passed = execs.filter((e) => e.status === 'passed').length;
      const failed = execs.filter((e) => e.status === 'failed').length;
      const skipped = execs.filter((e) => e.status === 'skipped').length;
      const flaky = this.calculateFlakySteps(execs as any[]);
      const total = execs.length;

      const percentages = {
        passed: total > 0 ? Math.round((passed / total) * 100 * 10) / 10 : 0,
        failed: total > 0 ? Math.round((failed / total) * 100 * 10) / 10 : 0,
        skipped: total > 0 ? Math.round((skipped / total) * 100 * 10) / 10 : 0,
        flaky: total > 0 ? Math.round((flaky / total) * 100 * 10) / 10 : 0,
      };

      return { passed, failed, skipped, flaky, total, percentages };
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

      if (runIds.length === 0) {
        return { failures: [] };
      }

      // Get recent failed executions
      const { data: failures } = await supabaseAdmin
        .from('test_executions')
        .select('id, run_id, test_case_id, status, error_message, completed_at')
        .in('run_id', runIds)
        .eq('status', 'failed')
        .not('completed_at', 'is', null)
        .order('completed_at', { ascending: false })
        .limit(limit);

      if (!failures || failures.length === 0) {
        return { failures: [] };
      }

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

      const result: RecentFailure[] = failures.map((f: any) => {
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
        };
      });

      return { failures: result };
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
        const { data: runs } = await supabaseAdmin
          .from('regression_runs')
          .select('started_at')
          .in('project_id', projectIds)
          .gte('started_at', since.toISOString())
          .not('started_at', 'is', null);

        dailyCounts = new Map();
        for (const run of runs || []) {
          const dateKey = run.started_at.split('T')[0];
          dailyCounts.set(dateKey, (dailyCounts.get(dateKey) || 0) + 1);
        }
      } else if (metric === 'failures') {
        const runIds = await this.getRunIdsForProjects(projectIds, since);
        dailyCounts = new Map();

        if (runIds.length > 0) {
          const { data: executions } = await supabaseAdmin
            .from('test_executions')
            .select('completed_at')
            .in('run_id', runIds)
            .eq('status', 'failed')
            .not('completed_at', 'is', null);

          for (const exec of executions || []) {
            const dateKey = exec.completed_at.split('T')[0];
            dailyCounts.set(dateKey, (dailyCounts.get(dateKey) || 0) + 1);
          }
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
      for (let i = 0; i < rangeDays; i++) {
        const date = new Date(since);
        date.setDate(date.getDate() + i);
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
        .select('id, integration_id, provider, event_type, payload, status, received_at')
        .in('integration_id', integrationIds)
        .in('status', ['processed', 'received', 'queued'])
        .order('received_at', { ascending: false })
        .limit(limit);

      if (!deliveries || deliveries.length === 0) {
        return { deployments: [] };
      }

      const deployments: DeploymentEntry[] = deliveries.map((d: any) => {
        const payload = d.payload || {};
        const version = payload.release?.tag_name || payload.ref?.split('/').pop() || null;
        const branch = payload.ref || null;

        return {
          id: d.id,
          version,
          eventType: d.event_type,
          provider: d.provider,
          status: 'no_tests' as const,
          branch,
          deliveredAt: d.received_at,
          runId: null,
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

      const { data: runs } = await supabaseAdmin
        .from('regression_runs')
        .select('started_at, status')
        .in('project_id', projectIds)
        .gte('started_at', filters.startDate?.toISOString() || new Date(Date.now() - 3600000).toISOString())
        .lte('started_at', filters.endDate?.toISOString() || new Date().toISOString())
        .not('started_at', 'is', null)
        .order('started_at', { ascending: true });

      if (!runs || runs.length === 0) {
        return { points: [], interval: filters.interval };
      }

      // Bucket by interval
      const intervalMs = this.getIntervalMs(filters.interval);
      const buckets = new Map<number, { total: number; passed: number; failed: number }>();

      for (const run of runs) {
        const timestamp = new Date(run.started_at).getTime();
        const bucketKey = Math.floor(timestamp / intervalMs) * intervalMs;

        if (!buckets.has(bucketKey)) {
          buckets.set(bucketKey, { total: 0, passed: 0, failed: 0 });
        }

        const bucket = buckets.get(bucketKey)!;
        bucket.total++;
        if (run.status === 'completed') bucket.passed++;
        if (run.status === 'failed') bucket.failed++;
      }

      const points: TimeSeriesPoint[] = Array.from(buckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([timestamp, counts]) => ({
          timestamp: new Date(timestamp).toISOString(),
          totalRuns: counts.total,
          passedRuns: counts.passed,
          failedRuns: counts.failed,
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
}
