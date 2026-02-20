import { supabaseAdmin } from '@/db/supabase';
import { PatternsQueryService } from '@/services/kb/patterns-query.service';
import { CoverageAnalysisService } from '@/services/testing/analysis/coverage-analysis.service';
import { FailureAnalysisService } from '@/services/testing/analysis/failure-analysis.service';
import { TestRecommendationService } from '@/services/testing/analysis/test-recommendation.service';
import { AnalyticsQueryService } from '@/services/analytics/analytics-query.service';
import { AIUsageQueryService } from '@/services/ai/tracking/ai-usage-query.service';
import { FixtureService } from '@/services/testing/fixtures/fixture.service';
import { ApiConfigService } from '@/services/api/api-config.service';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { ModuleService } from '@/services/testing/modules/module.service';
import { FlowService } from '@/services/testing/flows/flow.service';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { SkillContext, SkillResult } from '../types';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QA TOOL HANDLERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handler functions for each QA skill tool.
 * Each handler: validate args → query DB → format result → return SkillResult.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Helper: Resolve project_id with server-side context taking precedence.
 * SECURITY: Always prefer context.projectId (server-verified) over args.project_id (LLM-supplied)
 * to prevent prompt injection attacks from overriding the project scope.
 */
function resolveProjectId(args: Record<string, any>, context: SkillContext): string | undefined {
  return context.projectId || args.project_id;
}

/**
 * qa_list_test_cases — Query saved test cases with filters
 */
export async function handleListTestCases(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const status = args.status || 'published';
  const search = args.search as string | undefined;
  const limit = Math.min(args.limit || 20, 50);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    let query = supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, url, start_url, status, priority, tags, updated_at')
      .eq('project_id', projectId)
      .eq('status', status)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (search) {
      // Escape Postgres wildcards and PostgREST special chars to prevent filter injection
      const escaped = search
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')
        .replace(/[,.()"]/g, '');
      query = query.or(`name.ilike.%${escaped}%,url.ilike.%${escaped}%`);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('[QA_TOOL] Failed to list test cases', { error: error.message, projectId });
      return { success: false, message: `Database error: ${error.message}`, displayToUser: false };
    }

    const testCases = (data || []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      url: tc.url || tc.start_url,
      status: tc.status,
      priority: tc.priority,
      tags: tc.tags || [],
      updatedAt: tc.updated_at,
    }));

    return {
      success: true,
      data: { testCases, total: testCases.length },
      message: `Found ${testCases.length} ${status} test cases`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListTestCases error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list test cases: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_test_executions — Query recent test execution results
 */
export async function handleListTestExecutions(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const days = Math.min(args.days || 30, 90);
  const status = args.status as string | undefined;
  const testCaseId = args.test_case_id as string | undefined;
  const limit = Math.min(args.limit || 20, 50);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    // Step 1: Get run IDs for this project within time range
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    const { data: runs, error: runsError } = await supabaseAdmin
      .from('regression_runs')
      .select('id')
      .eq('project_id', projectId)
      .gte('started_at', sinceDate.toISOString());

    if (runsError) {
      logger.error('[QA_TOOL] Failed to get runs', { error: runsError.message, projectId });
      return { success: false, message: `Database error: ${runsError.message}`, displayToUser: false };
    }

    const runIds = (runs || []).map((r) => r.id);

    if (runIds.length === 0) {
      return {
        success: true,
        data: { executions: [], total: 0 },
        message: `No regression runs found in the last ${days} days`,
        displayToUser: false,
      };
    }

    // Step 2: Query executions for those runs (batched to avoid URL length limits)
    const batchSize = 100;
    let allExecRows: any[] = [];

    for (let i = 0; i < runIds.length; i += batchSize) {
      const batch = runIds.slice(i, i + batchSize);
      let query = supabaseAdmin
        .from('test_executions')
        .select('id, test_case_id, status, duration_ms, browser, created_at, error_message')
        .in('run_id', batch)
        .order('created_at', { ascending: false });

      if (status) {
        query = query.eq('status', status);
      }
      if (testCaseId) {
        query = query.eq('test_case_id', testCaseId);
      }

      const { data: batchExecs, error: execError } = await query;

      if (execError) {
        logger.error('[QA_TOOL] Failed to get executions batch', { error: execError.message });
        return { success: false, message: `Database error: ${execError.message}`, displayToUser: false };
      }

      if (batchExecs) {
        allExecRows.push(...batchExecs);
      }
    }

    // Sort combined results and apply limit
    allExecRows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const executions = allExecRows.slice(0, limit);

    // Step 3: Resolve test case names
    const testCaseIds = [...new Set((executions || []).map((e) => e.test_case_id).filter(Boolean))];
    let nameMap: Record<string, string> = {};

    if (testCaseIds.length > 0) {
      const { data: cases } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name')
        .in('id', testCaseIds);

      if (cases) {
        nameMap = Object.fromEntries(cases.map((c) => [c.id, c.name]));
      }
    }

    const results = (executions || []).map((e) => ({
      id: e.id,
      testCaseId: e.test_case_id,
      testCaseName: nameMap[e.test_case_id] || null,
      status: e.status,
      durationMs: e.duration_ms,
      browser: e.browser,
      errorMessage: e.error_message || null,
      createdAt: e.created_at,
    }));

    return {
      success: true,
      data: { executions: results, total: results.length },
      message: `Found ${results.length} test executions in the last ${days} days${status ? ` (status: ${status})` : ''}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListTestExecutions error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list executions: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_page_visits — Get page visit patterns
 */
export async function handleListPageVisits(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const limit = Math.min(args.limit || 30, 50);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const patterns = await PatternsQueryService.getPagePatterns(projectId, limit);

    return {
      success: true,
      data: { pageVisits: patterns, total: patterns.length },
      message: `Found ${patterns.length} page visit patterns`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListPageVisits error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list page visits: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_test_case — Get detailed info about a single test case
 */
export async function handleGetTestCase(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const testCaseId = args.test_case_id;

  if (!testCaseId) {
    return { success: false, message: 'Missing required field: test_case_id', displayToUser: false };
  }

  try {
    const projectId = resolveProjectId(args, context);
    let query = supabaseAdmin
      .from('intent_test_cases')
      .select(
        'id, name, description, url, start_url, status, steps_json, commands, tags, priority, preconditions, expected_result, project_id, created_at, updated_at'
      )
      .eq('id', testCaseId);

    // SECURITY: Always scope to project (prevents cross-project data access)
    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data, error } = await query.single();

    if (error) {
      logger.error('[QA_TOOL] Failed to get test case', { error: error.message, testCaseId });
      return {
        success: false,
        message: error.code === 'PGRST116' ? `Test case not found: ${testCaseId}` : `Database error: ${error.message}`,
        displayToUser: false,
      };
    }

    // Truncate large fields to prevent blowing up the LLM context window
    const truncateField = (val: any, maxLen: number) => {
      if (!val) return null;
      const str = typeof val === 'string' ? val : JSON.stringify(val);
      return str.length > maxLen ? str.substring(0, maxLen) + '... [truncated]' : str;
    };

    const testCase = {
      id: data.id,
      name: data.name,
      description: data.description,
      url: data.url || data.start_url,
      status: data.status,
      stepsJson: truncateField(data.steps_json, 5000),
      commands: truncateField(data.commands, 3000),
      tags: data.tags || [],
      priority: data.priority,
      preconditions: data.preconditions,
      expectedResult: data.expected_result,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };

    return {
      success: true,
      data: { testCase },
      message: `Test case: ${data.name}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetTestCase error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get test case: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_run_report — Get a regression run report with execution results
 */
export async function handleGetRunReport(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const runId = args.run_id;

  if (!runId) {
    return { success: false, message: 'Missing required field: run_id', displayToUser: false };
  }

  try {
    const projectId = resolveProjectId(args, context);

    // Get run metadata (SECURITY: always scope to project)
    let runQuery = supabaseAdmin
      .from('regression_runs')
      .select('id, status, started_at, completed_at, trigger, summary, plan_id, project_id')
      .eq('id', runId);

    if (projectId) {
      runQuery = runQuery.eq('project_id', projectId);
    }

    const { data: run, error: runError } = await runQuery.single();

    if (runError) {
      logger.error('[QA_TOOL] Failed to get run', { error: runError.message, runId });
      return {
        success: false,
        message: runError.code === 'PGRST116' ? `Run not found: ${runId}` : `Database error: ${runError.message}`,
        displayToUser: false,
      };
    }

    // Get executions for this run (capped to prevent context blowup)
    const MAX_REPORT_EXECUTIONS = 200;
    const { data: executions, error: execError } = await supabaseAdmin
      .from('test_executions')
      .select('id, test_case_id, status, duration_ms, browser, error_message, created_at')
      .eq('run_id', runId)
      .order('created_at', { ascending: true })
      .limit(MAX_REPORT_EXECUTIONS);

    if (execError) {
      logger.error('[QA_TOOL] Failed to get run executions', { error: execError.message, runId });
      return { success: false, message: `Database error: ${execError.message}`, displayToUser: false };
    }

    // Resolve test case names (batched to avoid URL length limits)
    const testCaseIds = [...new Set((executions || []).map((e) => e.test_case_id).filter(Boolean))];
    let nameMap: Record<string, string> = {};

    const nameBatchSize = 100;
    for (let i = 0; i < testCaseIds.length; i += nameBatchSize) {
      const batch = testCaseIds.slice(i, i + nameBatchSize);
      const { data: cases } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name')
        .in('id', batch);

      if (cases) {
        for (const c of cases) {
          nameMap[c.id] = c.name;
        }
      }
    }

    const allExecs = executions || [];
    const passed = allExecs.filter((e) => e.status === 'passed').length;
    const failed = allExecs.filter((e) => e.status === 'failed').length;
    const totalDuration = allExecs.reduce((sum, e) => sum + (e.duration_ms || 0), 0);

    // Return first 50 detailed executions to LLM, plus full stats
    const DETAIL_LIMIT = 50;
    const report = {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      durationMs: totalDuration,
      planId: run.plan_id,
      summary: run.summary,
      executions: allExecs.slice(0, DETAIL_LIMIT).map((e) => ({
        id: e.id,
        testCaseId: e.test_case_id,
        testCaseName: nameMap[e.test_case_id] || null,
        status: e.status,
        durationMs: e.duration_ms,
        browser: e.browser,
        errorMessage: e.error_message || null,
      })),
      executionsTruncated: allExecs.length > DETAIL_LIMIT,
      stats: {
        total: allExecs.length,
        passed,
        failed,
        skipped: allExecs.length - passed - failed,
        passRate: allExecs.length > 0 ? Math.round((passed / allExecs.length) * 100) : 0,
      },
    };

    return {
      success: true,
      data: { report },
      message: `Run ${runId}: ${report.stats.passed}/${report.stats.total} passed (${report.stats.passRate}%)`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetRunReport error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get run report: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_regression_plans — List regression plans for the project
 */
export async function handleListRegressionPlans(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const { data: plans, error: plansError } = await supabaseAdmin
      .from('regression_plans')
      .select('id, name, description, is_default, tags, created_at, updated_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (plansError) {
      logger.error('[QA_TOOL] Failed to list plans', { error: plansError.message, projectId });
      return { success: false, message: `Database error: ${plansError.message}`, displayToUser: false };
    }

    // Get test counts per plan (batched to avoid URL length limits)
    const planIds = (plans || []).map((p) => p.id);
    let countMap: Record<string, number> = {};

    const planBatchSize = 100;
    for (let i = 0; i < planIds.length; i += planBatchSize) {
      const batch = planIds.slice(i, i + planBatchSize);
      const { data: items } = await supabaseAdmin
        .from('regression_plan_items')
        .select('plan_id')
        .in('plan_id', batch);

      if (items) {
        for (const item of items) {
          countMap[item.plan_id] = (countMap[item.plan_id] || 0) + 1;
        }
      }
    }

    const result = (plans || []).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      isDefault: p.is_default,
      testCount: countMap[p.id] || 0,
      tags: p.tags || [],
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }));

    return {
      success: true,
      data: { plans: result, total: result.length },
      message: `Found ${result.length} regression plans`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListRegressionPlans error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list plans: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_analytics_summary — Get high-level analytics summary
 */
export async function handleGetAnalyticsSummary(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const days = Math.min(args.days || 30, 90);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    // Get runs for the period
    const { data: runs, error: runsError } = await supabaseAdmin
      .from('regression_runs')
      .select('id, status, started_at, completed_at')
      .eq('project_id', projectId)
      .gte('started_at', sinceDate.toISOString())
      .order('started_at', { ascending: false });

    if (runsError) {
      logger.error('[QA_TOOL] Failed to get runs for analytics', { error: runsError.message });
      return { success: false, message: `Database error: ${runsError.message}`, displayToUser: false };
    }

    const allRuns = runs || [];
    const runIds = allRuns.map((r) => r.id);

    if (runIds.length === 0) {
      return {
        success: true,
        data: {
          summary: {
            totalRuns: 0,
            totalExecutions: 0,
            passRate: 0,
            failRate: 0,
            avgDurationMs: 0,
            topFailures: [],
            periodDays: days,
          },
        },
        message: `No regression runs found in the last ${days} days`,
        displayToUser: false,
      };
    }

    // Get all executions for those runs (batched, with hard cap to prevent memory exhaustion)
    const batchSize = 100;
    const MAX_ANALYTICS_EXECUTIONS = 10000;
    const allExecutions: any[] = [];

    for (let i = 0; i < runIds.length; i += batchSize) {
      const batch = runIds.slice(i, i + batchSize);
      const { data: execs } = await supabaseAdmin
        .from('test_executions')
        .select('id, test_case_id, status, duration_ms, error_message')
        .in('run_id', batch);

      if (execs) {
        allExecutions.push(...execs);
      }

      // Hard cap to prevent OOM on very active projects
      if (allExecutions.length >= MAX_ANALYTICS_EXECUTIONS) {
        logger.warn('[QA_TOOL] Analytics execution cap reached', {
          cap: MAX_ANALYTICS_EXECUTIONS,
          totalRuns: runIds.length,
          processedBatches: Math.ceil((i + batchSize) / batchSize),
        });
        break;
      }
    }

    const passed = allExecutions.filter((e) => e.status === 'passed').length;
    const failed = allExecutions.filter((e) => e.status === 'failed').length;
    const validDurations = allExecutions.filter((e) => e.duration_ms > 0);
    const avgDuration =
      validDurations.length > 0
        ? Math.round(validDurations.reduce((sum, e) => sum + e.duration_ms, 0) / validDurations.length)
        : 0;

    // Top failures: group by test_case_id, count failures
    const failureMap = new Map<string, number>();
    for (const exec of allExecutions) {
      if (exec.status === 'failed' && exec.test_case_id) {
        failureMap.set(exec.test_case_id, (failureMap.get(exec.test_case_id) || 0) + 1);
      }
    }

    // Resolve names for top failures
    const topFailureEntries = Array.from(failureMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const failureCaseIds = topFailureEntries.map(([id]) => id);
    let failureNameMap: Record<string, string> = {};

    if (failureCaseIds.length > 0) {
      const { data: cases } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name')
        .in('id', failureCaseIds);

      if (cases) {
        failureNameMap = Object.fromEntries(cases.map((c) => [c.id, c.name]));
      }
    }

    const topFailures = topFailureEntries.map(([id, count]) => ({
      testCaseId: id,
      testCaseName: failureNameMap[id] || 'Unknown',
      failureCount: count,
    }));

    const summary = {
      totalRuns: allRuns.length,
      totalExecutions: allExecutions.length,
      passRate: allExecutions.length > 0 ? Math.round((passed / allExecutions.length) * 100) : 0,
      failRate: allExecutions.length > 0 ? Math.round((failed / allExecutions.length) * 100) : 0,
      avgDurationMs: avgDuration,
      topFailures,
      periodDays: days,
    };

    return {
      success: true,
      data: { summary },
      message: `Analytics for last ${days} days: ${summary.totalRuns} runs, ${summary.totalExecutions} executions, ${summary.passRate}% pass rate`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetAnalyticsSummary error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get analytics: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_test_results — Get test artifacts: video, screenshot, logs, errors, AI summary
 */
export async function handleGetTestResults(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const testId = args.test_id;
  const projectId = resolveProjectId(args, context);

  if (!testId) {
    return { success: false, message: 'Missing required field: test_id', displayToUser: false };
  }

  try {
    // Verify test execution belongs to current project (prevents cross-project access)
    if (projectId) {
      const { data: exec, error: execError } = await supabaseAdmin
        .from('test_executions')
        .select('id, run_id, regression_runs!inner(project_id)')
        .eq('id', testId)
        .eq('regression_runs.project_id', projectId)
        .maybeSingle();

      if (execError) {
        logger.error('[QA_TOOL] Failed to verify test ownership', { error: execError.message, testId });
        return { success: false, message: `Database error: ${execError.message}`, displayToUser: false };
      }

      if (!exec) {
        return { success: false, message: `Test execution not found: ${testId}`, displayToUser: false };
      }
    }

    const { data, error } = await supabaseAdmin
      .from('test_results')
      .select('test_id, video_url, trace_url, screenshot, logs, network_logs, errors, ai_summary, created_at')
      .eq('test_id', testId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error('[QA_TOOL] Failed to get test results', { error: error.message, testId });
      return { success: false, message: `Database error: ${error.message}`, displayToUser: false };
    }

    if (!data) {
      return { success: true, data: { testResult: null }, message: `No results found for test: ${testId}`, displayToUser: false };
    }

    // Parse AI summary for bugs/recommendations if present
    let bugs: any[] = [];
    let recommendations: any[] = [];
    if (data.ai_summary) {
      try {
        const summary = typeof data.ai_summary === 'string' ? JSON.parse(data.ai_summary) : data.ai_summary;
        bugs = summary.bugs || [];
        recommendations = summary.recommendations || [];
      } catch (parseError) {
        logger.warn('[QA_TOOL] Failed to parse ai_summary', { testId, error: String(parseError) });
        // Continue with empty bugs/recommendations rather than failing
      }
    }

    // Truncate large fields to keep token usage reasonable
    const truncate = (val: any, maxLen: number) => {
      if (!val) return null;
      const str = typeof val === 'string' ? val : JSON.stringify(val);
      return str.length > maxLen ? str.substring(0, maxLen) + '... [truncated]' : str;
    };

    const testResult = {
      testId: data.test_id,
      videoUrl: data.video_url || null,
      traceUrl: data.trace_url || null,
      screenshot: data.screenshot || null,
      consoleLogs: truncate(data.logs, 2000),
      networkLogs: truncate(data.network_logs, 2000),
      errors: data.errors || null,
      bugs,
      recommendations,
      createdAt: data.created_at,
    };

    return {
      success: true,
      data: { testResult },
      message: `Test results for ${testId}${data.video_url ? ' (video available)' : ''}${bugs.length > 0 ? `, ${bugs.length} bugs found` : ''}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetTestResults error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get test results: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_test_findings — List bugs/findings from autonomous test sessions
 */
export async function handleListTestFindings(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const severity = args.severity as string | undefined;
  const limit = Math.min(args.limit || 20, 50);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    // Step 1: Get session IDs for this project
    const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from('intelligent_test_sessions')
      .select('id')
      .eq('project_id', projectId);

    if (sessionsError) {
      logger.error('[QA_TOOL] Failed to get sessions for findings', { error: sessionsError.message });
      return { success: false, message: `Database error: ${sessionsError.message}`, displayToUser: false };
    }

    const sessionIds = (sessions || []).map((s) => s.id);

    if (sessionIds.length === 0) {
      return {
        success: true,
        data: { findings: [], total: 0 },
        message: 'No autonomous test sessions found for this project',
        displayToUser: false,
      };
    }

    // Step 2: Query findings (batched)
    const batchSize = 100;
    let allFindings: any[] = [];

    for (let i = 0; i < sessionIds.length; i += batchSize) {
      const batch = sessionIds.slice(i, i + batchSize);
      let query = supabaseAdmin
        .from('intelligent_test_findings')
        .select('id, session_id, finding_type, severity, title, description, found_at')
        .in('session_id', batch)
        .order('found_at', { ascending: false });

      if (severity) {
        query = query.eq('severity', severity);
      }

      const { data: batchFindings, error: findingsError } = await query;

      if (findingsError) {
        logger.error('[QA_TOOL] Failed to get findings batch', { error: findingsError.message });
        return { success: false, message: `Database error: ${findingsError.message}`, displayToUser: false };
      }

      if (batchFindings) {
        allFindings.push(...batchFindings);
      }
    }

    // Sort and limit
    allFindings.sort((a, b) => new Date(b.found_at).getTime() - new Date(a.found_at).getTime());
    const findings = allFindings.slice(0, limit).map((f) => ({
      id: f.id,
      findingType: f.finding_type,
      severity: f.severity,
      title: f.title,
      description: f.description,
      foundAt: f.found_at,
    }));

    return {
      success: true,
      data: { findings, total: findings.length },
      message: `Found ${findings.length} test findings${severity ? ` (severity: ${severity})` : ''}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListTestFindings error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list findings: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_test_modules — List test modules for the project
 */
export async function handleListTestModules(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const platformKey = args.platform_key as string | undefined;

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    let query = supabaseAdmin
      .from('test_modules')
      .select('id, name, description, platform_id, tags, priority, created_at, updated_at, test_platforms!inner(platform_key)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (platformKey) {
      query = query.eq('test_platforms.platform_key', platformKey);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('[QA_TOOL] Failed to list modules', { error: error.message, projectId });
      return { success: false, message: `Database error: ${error.message}`, displayToUser: false };
    }

    const modules = (data || []).map((m: any) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      platformKey: m.test_platforms?.platform_key || null,
      tags: m.tags || [],
      priority: m.priority,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    }));

    return {
      success: true,
      data: { modules, total: modules.length },
      message: `Found ${modules.length} test modules${platformKey ? ` (platform: ${platformKey})` : ''}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListTestModules error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list modules: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_test_flows — List test flows within a module
 */
export async function handleListTestFlows(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const moduleId = args.module_id;
  const projectId = resolveProjectId(args, context);

  if (!moduleId) {
    return { success: false, message: 'Missing required field: module_id', displayToUser: false };
  }

  try {
    // Verify module belongs to the current project (prevents cross-project access)
    if (projectId) {
      const { data: mod, error: modError } = await supabaseAdmin
        .from('test_modules')
        .select('id')
        .eq('id', moduleId)
        .eq('project_id', projectId)
        .maybeSingle();

      if (modError) {
        logger.error('[QA_TOOL] Failed to verify module ownership', { error: modError.message, moduleId });
        return { success: false, message: `Database error: ${modError.message}`, displayToUser: false };
      }

      if (!mod) {
        return { success: false, message: `Module not found: ${moduleId}`, displayToUser: false };
      }
    }

    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .select('id, module_id, name, description, order_index, flow_type, tags, priority, preconditions, expected_result, created_at, updated_at')
      .eq('module_id', moduleId)
      .order('order_index', { ascending: true });

    if (error) {
      logger.error('[QA_TOOL] Failed to list flows', { error: error.message, moduleId });
      return { success: false, message: `Database error: ${error.message}`, displayToUser: false };
    }

    const flows = (data || []).map((f) => ({
      id: f.id,
      moduleId: f.module_id,
      name: f.name,
      description: f.description,
      orderIndex: f.order_index,
      flowType: f.flow_type,
      tags: f.tags || [],
      priority: f.priority,
      preconditions: f.preconditions,
      expectedResult: f.expected_result,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    }));

    return {
      success: true,
      data: { flows, total: flows.length },
      message: `Found ${flows.length} test flows in module`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListTestFlows error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list flows: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_schedules — List test schedules for the project
 */
export async function handleListSchedules(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const activeOnly = args.active_only === true;

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    let query = supabaseAdmin
      .from('test_schedules')
      .select('id, name, cron_expression, timezone, is_active, module_id, plan_id, last_run_at, next_run_at, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (activeOnly) {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('[QA_TOOL] Failed to list schedules', { error: error.message, projectId });
      return { success: false, message: `Database error: ${error.message}`, displayToUser: false };
    }

    const schedules = (data || []).map((s) => ({
      id: s.id,
      name: s.name,
      cronExpression: s.cron_expression,
      timezone: s.timezone,
      isActive: s.is_active,
      moduleId: s.module_id || null,
      planId: s.plan_id || null,
      lastRunAt: s.last_run_at || null,
      nextRunAt: s.next_run_at || null,
      createdAt: s.created_at,
    }));

    return {
      success: true,
      data: { schedules, total: schedules.length },
      message: `Found ${schedules.length} schedules${activeOnly ? ' (active only)' : ''}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListSchedules error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list schedules: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_detect_flaky_tests — Find test cases with inconsistent results (both passed and failed)
 */
export async function handleDetectFlakyTests(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const days = Math.min(args.days || 30, 90);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    // Step 1: Get run IDs for this project
    const { data: runs, error: runsError } = await supabaseAdmin
      .from('regression_runs')
      .select('id')
      .eq('project_id', projectId)
      .gte('started_at', sinceDate.toISOString());

    if (runsError) {
      logger.error('[QA_TOOL] Failed to get runs for flaky detection', { error: runsError.message });
      return { success: false, message: `Database error: ${runsError.message}`, displayToUser: false };
    }

    const runIds = (runs || []).map((r) => r.id);

    if (runIds.length === 0) {
      return {
        success: true,
        data: { flakyTests: [], total: 0 },
        message: `No regression runs found in the last ${days} days`,
        displayToUser: false,
      };
    }

    // Step 2: Get all executions with pass/fail status (batched)
    const batchSize = 100;
    const allExecs: Array<{ test_case_id: string; status: string }> = [];

    for (let i = 0; i < runIds.length; i += batchSize) {
      const batch = runIds.slice(i, i + batchSize);
      const { data: execs } = await supabaseAdmin
        .from('test_executions')
        .select('test_case_id, status')
        .in('run_id', batch)
        .in('status', ['passed', 'failed']);

      if (execs) {
        allExecs.push(...execs);
      }
    }

    // Step 3: Group by test_case_id and find those with both passed AND failed
    const caseStats = new Map<string, { passed: number; failed: number }>();

    for (const exec of allExecs) {
      if (!exec.test_case_id) continue;
      const stats = caseStats.get(exec.test_case_id) || { passed: 0, failed: 0 };
      if (exec.status === 'passed') stats.passed++;
      if (exec.status === 'failed') stats.failed++;
      caseStats.set(exec.test_case_id, stats);
    }

    const flakyIds: string[] = [];
    const flakyStatsMap = new Map<string, { passed: number; failed: number }>();

    for (const [caseId, stats] of caseStats.entries()) {
      if (stats.passed > 0 && stats.failed > 0) {
        flakyIds.push(caseId);
        flakyStatsMap.set(caseId, stats);
      }
    }

    if (flakyIds.length === 0) {
      return {
        success: true,
        data: { flakyTests: [], total: 0 },
        message: `No flaky tests detected in the last ${days} days`,
        displayToUser: false,
      };
    }

    // Step 4: Resolve test case names (batched to avoid URL length limits)
    const flakyBatchSize = 100;
    const nameMap = new Map<string, any>();

    for (let i = 0; i < flakyIds.length; i += flakyBatchSize) {
      const batch = flakyIds.slice(i, i + flakyBatchSize);
      const { data: cases } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name, url, priority')
        .in('id', batch);

      if (cases) {
        for (const c of cases) {
          nameMap.set(c.id, c);
        }
      }
    }

    const flakyTests = flakyIds
      .map((id) => {
        const stats = flakyStatsMap.get(id)!;
        const total = stats.passed + stats.failed;
        const caseInfo = nameMap.get(id);
        return {
          testCaseId: id,
          testCaseName: caseInfo?.name || 'Unknown',
          url: caseInfo?.url || null,
          priority: caseInfo?.priority || null,
          passedCount: stats.passed,
          failedCount: stats.failed,
          totalRuns: total,
          flakinessRate: Math.round((Math.min(stats.passed, stats.failed) / total) * 100),
        };
      })
      .sort((a, b) => b.flakinessRate - a.flakinessRate);

    return {
      success: true,
      data: { flakyTests, total: flakyTests.length },
      message: `Found ${flakyTests.length} flaky tests in the last ${days} days`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleDetectFlakyTests error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to detect flaky tests: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4c — NEW TOOL HANDLERS (Tools 14–26)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * qa_list_api_test_configs — List saved API test configs + endpoints for a project
 */
export async function handleListApiTestConfigs(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const environments = await ApiConfigService.getEnvironments(context.userId, projectId);

    // For each environment, get endpoint count and list endpoints
    const envSummaries: any[] = [];
    const allEndpoints: any[] = [];

    for (const env of environments) {
      const endpoints = await ApiConfigService.getEndpoints(env.id, context.userId);

      envSummaries.push({
        name: env.name,
        baseUrl: env.base_url,
        authType: env.auth_type,
        endpointCount: endpoints.length,
      });

      for (const ep of endpoints) {
        allEndpoints.push({
          method: ep.method,
          path: ep.path,
          name: ep.name,
          category: ep.category || null,
          tags: ep.tags || [],
        });
      }
    }

    return {
      success: true,
      data: { environments: envSummaries, endpoints: allEndpoints },
      message: `Found ${envSummaries.length} environments with ${allEndpoints.length} total endpoints`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListApiTestConfigs error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list API test configs: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_api_test_history — List recent API test execution results
 */
export async function handleListApiTestHistory(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const limit = Math.min(args.limit || 20, 50);
  const successFilter = args.success as boolean | undefined;

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    // Get chat sessions for this project to scope API test executions
    const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from('chat_sessions')
      .select('id')
      .eq('project_id', projectId);

    if (sessionsError) {
      logger.error('[QA_TOOL] Failed to get sessions for API history', { error: sessionsError.message });
      return { success: false, message: `Database error: ${sessionsError.message}`, displayToUser: false };
    }

    const sessionIds = (sessions || []).map((s) => s.id);

    if (sessionIds.length === 0) {
      return {
        success: true,
        data: { executions: [], total: 0 },
        message: 'No API test history found for this project',
        displayToUser: false,
      };
    }

    // Query api_test_executions scoped by sessions (batched)
    const batchSize = 100;
    let allRows: any[] = [];

    for (let i = 0; i < sessionIds.length; i += batchSize) {
      const batch = sessionIds.slice(i, i + batchSize);
      let query = supabaseAdmin
        .from('api_test_executions')
        .select('id, method, url, status_code, duration_ms, success, fuzzing_score, executed_at')
        .in('session_id', batch)
        .order('executed_at', { ascending: false });

      if (successFilter !== undefined) {
        query = query.eq('success', successFilter);
      }

      const { data: batchData, error: batchError } = await query;

      if (batchError) {
        logger.error('[QA_TOOL] Failed to get API test history batch', { error: batchError.message });
        return { success: false, message: `Database error: ${batchError.message}`, displayToUser: false };
      }

      if (batchData) {
        allRows.push(...batchData);
      }
    }

    // Sort and limit
    allRows.sort((a, b) => new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime());
    const executions = allRows.slice(0, limit).map((e) => ({
      id: e.id,
      method: e.method,
      url: e.url,
      statusCode: e.status_code,
      durationMs: e.duration_ms,
      success: e.success,
      fuzzingScore: e.fuzzing_score || null,
      executedAt: e.executed_at,
    }));

    return {
      success: true,
      data: { executions, total: executions.length },
      message: `Found ${executions.length} API test executions`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListApiTestHistory error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list API test history: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_coverage_report — Get full coverage analysis with score, gaps, and summary
 */
export async function handleGetCoverageReport(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const report = await CoverageAnalysisService.analyze(projectId, context.userId, context.workspaceId);

    return {
      success: true,
      data: {
        score: report.score,
        totalUrls: report.totalUrls,
        coveredUrls: report.coveredUrls,
        totalTestCases: report.totalTestCases,
        staleTestCases: report.staleTestCases,
        gaps: report.gaps,
        summary: report.summary,
      },
      message: `Coverage score: ${report.score}% (${report.coveredUrls}/${report.totalUrls} URLs covered, ${report.gaps.length} gaps found)`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetCoverageReport error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get coverage report: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_analyze_failure — AI-powered root cause analysis for a failed test
 */
export async function handleAnalyzeFailure(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const testId = args.test_id;

  if (!testId) {
    return { success: false, message: 'Missing required field: test_id', displayToUser: false };
  }

  try {
    const result = await FailureAnalysisService.analyze(testId, context.userId);

    return {
      success: true,
      data: {
        rootCause: result.rootCause,
        category: result.category,
        severity: result.severity,
        suggestions: result.suggestions,
        affectedStep: result.affectedStep || null,
        errorDetails: result.errorDetails,
      },
      message: `Failure analysis: ${result.category} (${result.severity}) — ${result.rootCause.substring(0, 100)}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleAnalyzeFailure error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to analyze failure: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_recommendations — AI-powered test suggestions
 */
export async function handleGetRecommendations(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const recommendations = await TestRecommendationService.getRecommendations(
      projectId,
      context.userId,
      context.workspaceId
    );

    const results = recommendations.map((r) => ({
      type: r.type,
      title: r.title,
      reason: r.reason,
      url: r.url || null,
      relatedTestCaseId: r.relatedTestCaseId || null,
      priority: r.priority,
    }));

    return {
      success: true,
      data: { recommendations: results, total: results.length },
      message: `Generated ${results.length} test recommendations`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetRecommendations error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get recommendations: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_recent_failures — Recent test failures with severity and error context
 */
export async function handleGetRecentFailures(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const limit = Math.min(args.limit || 10, 20);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const result = await AnalyticsQueryService.getRecentFailures(context.workspaceId, projectId, limit);

    return {
      success: true,
      data: { failures: result.failures, total: result.failures.length },
      message: `Found ${result.failures.length} recent failures`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetRecentFailures error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get recent failures: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_critical_checks — Status of all critical-priority test cases
 */
export async function handleGetCriticalChecks(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const result = await AnalyticsQueryService.getCriticalChecks(context.workspaceId, projectId);

    return {
      success: true,
      data: { checks: result.checks, total: result.checks.length },
      message: `Found ${result.checks.length} critical checks`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetCriticalChecks error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get critical checks: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_test_fixtures — List reusable test data (fixtures) for a project
 */
export async function handleListTestFixtures(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const scope = args.scope as 'global' | 'project' | 'module' | 'flow' | undefined;

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const fixtures = await FixtureService.listByProject(projectId, context.userId, scope);

    // Truncate data field to prevent context blowup
    const results = fixtures.map((f) => {
      const dataStr = f.data ? (typeof f.data === 'string' ? f.data : JSON.stringify(f.data)) : '';
      return {
        id: f.id,
        name: f.name,
        description: f.description || null,
        scope: f.scope,
        tags: f.tags || [],
        data: dataStr.length > 1000 ? dataStr.substring(0, 1000) + '... [truncated]' : dataStr,
        createdAt: f.createdAt,
      };
    });

    return {
      success: true,
      data: { fixtures: results, total: results.length },
      message: `Found ${results.length} test fixtures${scope ? ` (scope: ${scope})` : ''}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListTestFixtures error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list fixtures: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_api_environments — List configured API environments (strip secrets)
 */
export async function handleListApiEnvironments(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const environments = await ApiConfigService.getEnvironments(context.userId, projectId);

    // SECURITY: Strip auth_config (contains tokens/secrets). Only return authType + variable keys.
    const results = environments.map((env) => ({
      id: env.id,
      name: env.name,
      baseUrl: env.base_url,
      authType: env.auth_type,
      isDefault: env.is_default,
      variableKeys: env.variables ? Object.keys(env.variables) : [],
    }));

    return {
      success: true,
      data: { environments: results, total: results.length },
      message: `Found ${results.length} API environments`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListApiEnvironments error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list API environments: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_ai_usage — AI token usage and cost summary for workspace
 */
export async function handleGetAiUsage(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const days = Math.min(args.days || 30, 90);

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [usageStats, operationBreakdown] = await Promise.all([
      AIUsageQueryService.getWorkspaceUsageStats(context.workspaceId, startDate),
      AIUsageQueryService.getUsageByOperationType(context.workspaceId, startDate),
    ]);

    return {
      success: true,
      data: {
        totalTokens: usageStats.totalTokens,
        totalCostUSD: usageStats.totalCostUSD,
        totalCalls: usageStats.totalCalls,
        breakdown: operationBreakdown.map((op) => ({
          operationType: op.operationType,
          tokens: op.totalTokens,
          cost: op.totalCost,
          count: op.count,
        })),
        periodDays: days,
      },
      message: `AI usage over ${days} days: ${usageStats.totalTokens} tokens, $${usageStats.totalCostUSD.toFixed(4)} cost, ${usageStats.totalCalls} calls`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetAiUsage error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get AI usage: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_deployments — Recent deployments/webhook events and their test run results
 */
export async function handleListDeployments(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const limit = Math.min(args.limit || 5, 20);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const result = await AnalyticsQueryService.getRecentDeployments(context.workspaceId, projectId, limit);

    return {
      success: true,
      data: { deployments: result.deployments, total: result.deployments.length },
      message: `Found ${result.deployments.length} recent deployments`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListDeployments error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list deployments: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_jira_issues — Jira issues linked to test results
 */
export async function handleListJiraIssues(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const limit = Math.min(args.limit || 20, 50);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    // Raw query: test_jira_issues → test_executions → regression_runs for project scoping
    const { data, error } = await supabaseAdmin
      .from('test_jira_issues')
      .select(`
        id,
        test_id,
        jira_issue_key,
        jira_issue_url,
        created_at,
        test_executions!inner(
          id,
          run_id,
          regression_runs!inner(
            project_id
          )
        )
      `)
      .eq('test_executions.regression_runs.project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('[QA_TOOL] Failed to list Jira issues', { error: error.message, projectId });
      return { success: false, message: `Database error: ${error.message}`, displayToUser: false };
    }

    const issues = (data || []).map((j: any) => ({
      testId: j.test_id,
      jiraIssueKey: j.jira_issue_key,
      jiraIssueUrl: j.jira_issue_url,
      createdAt: j.created_at,
    }));

    return {
      success: true,
      data: { issues, total: issues.length },
      message: `Found ${issues.length} Jira issues linked to tests`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListJiraIssues error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list Jira issues: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_list_element_interactions — Element interaction patterns (unreliable selectors)
 */
export async function handleListElementInteractions(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const limit = Math.min(args.limit || 20, 50);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const patterns = await PatternsQueryService.getElementPatterns(projectId, limit);

    return {
      success: true,
      data: { elements: patterns, total: patterns.length },
      message: `Found ${patterns.length} element interaction patterns`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleListElementInteractions error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to list element interactions: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WRITE TOOLS (require confirm=true from agent after user approval)
// ═══════════════════════════════════════════════════════════════════════════

/** Allowed IntentStep action types — reject anything else */
const VALID_STEP_TYPES = new Set([
  'type', 'click', 'wait', 'assert', 'navigate', 'select', 'hover',
  'scroll', 'press', 'check', 'uncheck', 'toggle', 'open', 'close',
  'ai_check', 'wait_for', 'upload',
]);

/**
 * qa_update_test_case_steps — Update steps of a test case (WRITE operation)
 *
 * Safety:
 * - Requires `confirm: true` — agent MUST describe changes and get user approval first
 * - Ownership enforced by IntentTestCaseService (user_id check)
 * - Project scoping via resolveProjectId
 * - Returns previous step count so agent can inform user what changed
 */
export async function handleUpdateTestCaseSteps(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const testCaseId = args.test_case_id;
  const steps = args.steps as IntentStep[] | undefined;
  const confirm = args.confirm === true;

  if (!testCaseId) {
    return { success: false, message: 'Missing required field: test_case_id', displayToUser: false };
  }

  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return { success: false, message: 'Missing or empty required field: steps (array of step objects)', displayToUser: false };
  }

  // Gate: agent must explicitly set confirm=true after user approval
  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  // Validate step structure
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.id || typeof step.id !== 'string') {
      return { success: false, message: `Step ${i}: missing or invalid "id" (must be a string UUID)`, displayToUser: false };
    }
    if (!step.type || !VALID_STEP_TYPES.has(step.type)) {
      return {
        success: false,
        message: `Step ${i}: invalid "type" "${step.type}". Allowed: ${[...VALID_STEP_TYPES].join(', ')}`,
        displayToUser: false,
      };
    }
    if (!step.description || typeof step.description !== 'string') {
      return { success: false, message: `Step ${i}: missing or invalid "description" (must be a non-empty string)`, displayToUser: false };
    }
  }

  try {
    const projectId = resolveProjectId(args, context);

    // Fetch current test case to verify it exists, check ownership, and get previous state
    let verifyQuery = supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, steps_json, project_id, user_id')
      .eq('id', testCaseId);

    if (projectId) {
      verifyQuery = verifyQuery.eq('project_id', projectId);
    }

    const { data: existing, error: fetchError } = await verifyQuery.single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return { success: false, message: `Test case not found: ${testCaseId}`, displayToUser: false };
      }
      return { success: false, message: `Database error: ${fetchError.message}`, displayToUser: false };
    }

    // Check ownership before attempting update
    if (existing.user_id !== context.userId) {
      return {
        success: false,
        message: 'You can only update test cases you created. This test case belongs to another user.',
        displayToUser: false,
      };
    }

    const previousSteps: IntentStep[] = Array.isArray(existing.steps_json) ? existing.steps_json : [];
    const previousStepCount = previousSteps.length;

    // Merge LLM-provided steps with existing step data to preserve compiled/evidence/bindingHints.
    // For steps whose id matches an existing step, carry over fields the LLM cannot provide.
    const existingStepMap = new Map<string, IntentStep>();
    for (const s of previousSteps) {
      if (s.id) existingStepMap.set(s.id, s);
    }

    const mergedSteps: IntentStep[] = steps.map((incoming) => {
      const prev = existingStepMap.get(incoming.id);
      if (!prev) {
        // New step — use as-is
        return incoming;
      }

      // If the action type or description changed, the old compiled/evidence are stale — discard them
      const typeChanged = incoming.type !== prev.type;
      const descChanged = incoming.description !== prev.description;
      const stepModified = typeChanged || descChanged;

      // Existing step — carry over compiled/evidence/bindingHints/options,
      // but let LLM-provided fields (type, description, value, assertionText) take precedence
      return {
        ...prev,
        ...incoming,
        // Preserve complex fields only if step wasn't modified and LLM didn't provide them
        bindingHints: incoming.bindingHints || prev.bindingHints,
        evidence: stepModified ? undefined : (incoming.evidence || prev.evidence),
        compiled: stepModified ? undefined : (incoming.compiled || prev.compiled),
        options: incoming.options || prev.options,
      };
    });

    // Perform the update via IntentTestCaseService (also enforces user_id ownership)
    const updated = await IntentTestCaseService.update({
      id: testCaseId,
      userId: context.userId,
      steps: mergedSteps,
    });

    logger.info('[QA_TOOL] Test case steps updated', {
      testCaseId,
      userId: context.userId,
      previousStepCount,
      newStepCount: steps.length,
    });

    return {
      success: true,
      data: {
        testCaseId: updated.id,
        testCaseName: updated.name,
        previousStepCount,
        newStepCount: updated.stepsJson.length,
      },
      message: `Updated test case "${updated.name}": ${previousStepCount} → ${updated.stepsJson.length} steps`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleUpdateTestCaseSteps error', {
      error: error instanceof Error ? error.message : String(error),
      testCaseId,
    });
    return {
      success: false,
      message: `Failed to update test case steps: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 1 — HIGH PRIORITY WRITE TOOLS (Tools 28–30)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * qa_update_test_case — Update test case metadata (NOT steps)
 *
 * Safety:
 * - Requires `confirm: true`
 * - Ownership enforced (user_id check)
 * - At least one field besides confirm must be provided
 */
export async function handleUpdateTestCase(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const testCaseId = args.test_case_id as string | undefined;
  const confirm = args.confirm === true;

  if (!testCaseId) {
    return { success: false, message: 'Missing required field: test_case_id', displayToUser: false };
  }

  // Gate: confirm required
  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  // Validate at least one updatable field is provided
  const updatableFields = ['name', 'status', 'priority', 'tags', 'description'];
  const providedFields = updatableFields.filter((f) => args[f] !== undefined);

  if (providedFields.length === 0) {
    return {
      success: false,
      message: 'At least one field to update must be provided: name, status, priority, tags, description',
      displayToUser: false,
    };
  }

  // Validate enum values
  if (args.status !== undefined && !['draft', 'published', 'archived'].includes(args.status)) {
    return { success: false, message: `Invalid status: ${args.status}. Must be draft, published, or archived.`, displayToUser: false };
  }
  if (args.priority !== undefined && !['critical', 'high', 'medium', 'low'].includes(args.priority)) {
    return { success: false, message: `Invalid priority: ${args.priority}. Must be critical, high, medium, or low.`, displayToUser: false };
  }

  try {
    const projectId = resolveProjectId(args, context);

    // Ownership check
    let verifyQuery = supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, user_id')
      .eq('id', testCaseId);

    if (projectId) {
      verifyQuery = verifyQuery.eq('project_id', projectId);
    }

    const { data: existing, error: fetchError } = await verifyQuery.single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return { success: false, message: `Test case not found: ${testCaseId}`, displayToUser: false };
      }
      return { success: false, message: `Database error: ${fetchError.message}`, displayToUser: false };
    }

    if (existing.user_id !== context.userId) {
      return {
        success: false,
        message: 'You can only update test cases you created. This test case belongs to another user.',
        displayToUser: false,
      };
    }

    // Build update params
    const updateParams: {
      id: string;
      userId: string;
      name?: string;
      status?: 'draft' | 'published' | 'archived';
      priority?: 'critical' | 'high' | 'medium' | 'low';
      tags?: string[];
      description?: string;
    } = {
      id: testCaseId,
      userId: context.userId,
    };

    if (args.name !== undefined) updateParams.name = args.name;
    if (args.status !== undefined) updateParams.status = args.status;
    if (args.priority !== undefined) updateParams.priority = args.priority;
    if (args.tags !== undefined) updateParams.tags = args.tags;
    if (args.description !== undefined) updateParams.description = args.description;

    const updated = await IntentTestCaseService.update(updateParams);

    logger.info('[QA_TOOL] Test case metadata updated', {
      testCaseId,
      userId: context.userId,
      updatedFields: providedFields,
    });

    return {
      success: true,
      data: {
        testCaseId: updated.id,
        name: updated.name,
        status: updated.status,
        priority: updated.priority,
        tags: updated.tags || [],
        updatedFields: providedFields,
      },
      message: `Updated test case "${updated.name}": ${providedFields.join(', ')}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleUpdateTestCase error', {
      error: error instanceof Error ? error.message : String(error),
      testCaseId,
    });
    return {
      success: false,
      message: `Failed to update test case: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_run_test — Run a test case, plan, module, flow, or filter by tag/priority
 *
 * Safety:
 * - Requires `confirm: true`
 * - Always uses trigger: 'chat'
 */
export async function handleRunTest(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const runType = args.run_type as string | undefined;
  const confirm = args.confirm === true;

  if (!runType) {
    return { success: false, message: 'Missing required field: run_type', displayToUser: false };
  }

  const validRunTypes = ['test_case', 'plan', 'module', 'flow', 'tag', 'priority'];
  if (!validRunTypes.includes(runType)) {
    return { success: false, message: `Invalid run_type: ${runType}. Must be one of: ${validRunTypes.join(', ')}`, displayToUser: false };
  }

  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe what will be run to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  try {
    const targetId = args.target_id as string | undefined;
    const tag = args.tag as string | undefined;
    const priorityFilter = args.priority_filter as string | undefined;
    const projectId = resolveProjectId(args, context);

    switch (runType) {
      case 'test_case': {
        if (!targetId) {
          return { success: false, message: 'Missing required field: target_id (test case ID)', displayToUser: false };
        }
        const result = await RegressionRunService.runSavedTestCase({
          savedTestCaseId: targetId,
          userId: context.userId,
          trigger: 'chat',
        });
        return {
          success: true,
          data: { runId: result.runId, testId: result.testId, runType },
          message: `Started test case run: ${result.runId}`,
          displayToUser: true,
        };
      }

      case 'plan': {
        if (!targetId) {
          return { success: false, message: 'Missing required field: target_id (plan ID)', displayToUser: false };
        }
        const result = await RegressionRunService.runPlan({
          planId: targetId,
          userId: context.userId,
          trigger: 'chat',
        });
        return {
          success: true,
          data: { runId: result.runId, totalTests: result.totalTests, runType },
          message: `Started plan run: ${result.runId} (${result.totalTests} tests)`,
          displayToUser: true,
        };
      }

      case 'module': {
        if (!targetId) {
          return { success: false, message: 'Missing required field: target_id (module ID)', displayToUser: false };
        }
        const result = await RegressionRunService.runModule({
          moduleId: targetId,
          userId: context.userId,
          trigger: 'chat',
        });
        return {
          success: true,
          data: { runId: result.runId, totalTests: result.totalTests, runType },
          message: `Started module run: ${result.runId} (${result.totalTests} tests)`,
          displayToUser: true,
        };
      }

      case 'flow': {
        if (!targetId) {
          return { success: false, message: 'Missing required field: target_id (flow ID)', displayToUser: false };
        }
        const result = await RegressionRunService.runFlow({
          flowId: targetId,
          userId: context.userId,
          trigger: 'chat',
        });
        return {
          success: true,
          data: { runId: result.runId, totalTests: result.totalTests, runType },
          message: `Started flow run: ${result.runId} (${result.totalTests} tests)`,
          displayToUser: true,
        };
      }

      case 'tag': {
        if (!tag) {
          return { success: false, message: 'Missing required field: tag', displayToUser: false };
        }
        if (!projectId) {
          return { success: false, message: 'Missing required field: project_id (required for tag-based runs)', displayToUser: false };
        }
        const result = await RegressionRunService.runByTag({
          projectId,
          tag,
          userId: context.userId,
          trigger: 'chat',
        });
        return {
          success: true,
          data: { runId: result.runId, totalTests: result.totalTests, runType, tag },
          message: `Started tag run "${tag}": ${result.runId} (${result.totalTests} tests)`,
          displayToUser: true,
        };
      }

      case 'priority': {
        if (!priorityFilter || !['critical', 'high', 'medium', 'low'].includes(priorityFilter)) {
          return { success: false, message: 'Missing or invalid priority_filter. Must be critical, high, medium, or low.', displayToUser: false };
        }
        if (!projectId) {
          return { success: false, message: 'Missing required field: project_id (required for priority-based runs)', displayToUser: false };
        }
        const result = await RegressionRunService.runByPriority({
          projectId,
          priority: priorityFilter as 'critical' | 'high' | 'medium' | 'low',
          userId: context.userId,
          trigger: 'chat',
        });
        return {
          success: true,
          data: { runId: result.runId, totalTests: result.totalTests, runType, priority: priorityFilter },
          message: `Started priority run "${priorityFilter}": ${result.runId} (${result.totalTests} tests)`,
          displayToUser: true,
        };
      }

      default:
        return { success: false, message: `Unknown run_type: ${runType}`, displayToUser: false };
    }
  } catch (error) {
    logger.error('[QA_TOOL] handleRunTest error', {
      error: error instanceof Error ? error.message : String(error),
      runType,
    });
    return {
      success: false,
      message: `Failed to run test: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_create_test_case — Create a new test case with steps
 *
 * Safety:
 * - Requires `confirm: true`
 * - Steps validated against VALID_STEP_TYPES
 */
export async function handleCreateTestCase(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const name = args.name as string | undefined;
  const steps = args.steps as IntentStep[] | undefined;
  const confirm = args.confirm === true;

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }
  if (!name) {
    return { success: false, message: 'Missing required field: name', displayToUser: false };
  }
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return { success: false, message: 'Missing or empty required field: steps (array of step objects)', displayToUser: false };
  }

  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe the test case you will create to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  // Validate step structure
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.id || typeof step.id !== 'string') {
      return { success: false, message: `Step ${i}: missing or invalid "id" (must be a string UUID)`, displayToUser: false };
    }
    if (!step.type || !VALID_STEP_TYPES.has(step.type)) {
      return {
        success: false,
        message: `Step ${i}: invalid "type" "${step.type}". Allowed: ${[...VALID_STEP_TYPES].join(', ')}`,
        displayToUser: false,
      };
    }
    if (!step.description || typeof step.description !== 'string') {
      return { success: false, message: `Step ${i}: missing or invalid "description" (must be a non-empty string)`, displayToUser: false };
    }
  }

  try {
    const created = await IntentTestCaseService.create({
      projectId,
      userId: context.userId,
      name,
      description: args.description || undefined,
      startUrl: args.start_url || undefined,
      steps,
      status: args.status || 'draft',
    });

    // Apply tags and priority via update if provided
    if (args.tags || args.priority) {
      await IntentTestCaseService.update({
        id: created.id,
        userId: context.userId,
        ...(args.tags ? { tags: args.tags } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
      });
    }

    logger.info('[QA_TOOL] Test case created', {
      testCaseId: created.id,
      userId: context.userId,
      stepCount: steps.length,
    });

    return {
      success: true,
      data: {
        testCaseId: created.id,
        name: created.name,
        status: created.status,
        stepCount: steps.length,
      },
      message: `Created test case "${created.name}" with ${steps.length} steps`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleCreateTestCase error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to create test case: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 2 — MEDIUM PRIORITY WRITE TOOLS (Tools 31–33)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * qa_manage_regression_plan — Create/update plan + add/remove items
 *
 * Safety:
 * - Requires `confirm: true`
 * - Compound tool: action determines behavior
 */
export async function handleManageRegressionPlan(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const action = args.action as string | undefined;
  const confirm = args.confirm === true;

  if (!action) {
    return { success: false, message: 'Missing required field: action', displayToUser: false };
  }

  const validActions = ['create', 'update', 'add_item', 'remove_item'];
  if (!validActions.includes(action)) {
    return { success: false, message: `Invalid action: ${action}. Must be one of: ${validActions.join(', ')}`, displayToUser: false };
  }

  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  try {
    switch (action) {
      case 'create': {
        const projectId = resolveProjectId(args, context);
        const name = args.name as string | undefined;

        if (!projectId) {
          return { success: false, message: 'Missing required field: project_id', displayToUser: false };
        }
        if (!name) {
          return { success: false, message: 'Missing required field: name', displayToUser: false };
        }

        const plan = await RegressionPlanService.create({
          projectId,
          userId: context.userId,
          name,
          description: args.description || undefined,
          tags: args.tags || undefined,
          isDefault: args.is_default || false,
        });

        logger.info('[QA_TOOL] Regression plan created', { planId: plan.id, userId: context.userId });

        return {
          success: true,
          data: { planId: plan.id, name: plan.name, isDefault: plan.isDefault },
          message: `Created regression plan "${plan.name}"`,
          displayToUser: true,
        };
      }

      case 'update': {
        const planId = args.plan_id as string | undefined;
        if (!planId) {
          return { success: false, message: 'Missing required field: plan_id', displayToUser: false };
        }

        const plan = await RegressionPlanService.update({
          id: planId,
          userId: context.userId,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.is_default !== undefined ? { isDefault: args.is_default } : {}),
        });

        logger.info('[QA_TOOL] Regression plan updated', { planId: plan.id, userId: context.userId });

        return {
          success: true,
          data: { planId: plan.id, name: plan.name, isDefault: plan.isDefault },
          message: `Updated regression plan "${plan.name}"`,
          displayToUser: true,
        };
      }

      case 'add_item': {
        const planId = args.plan_id as string | undefined;
        const itemType = args.item_type as string | undefined;
        const itemId = args.item_id as string | undefined;

        if (!planId) {
          return { success: false, message: 'Missing required field: plan_id', displayToUser: false };
        }
        if (!itemType || !['module', 'flow', 'test_case'].includes(itemType)) {
          return { success: false, message: 'Missing or invalid item_type. Must be module, flow, or test_case.', displayToUser: false };
        }
        if (!itemId) {
          return { success: false, message: 'Missing required field: item_id', displayToUser: false };
        }

        const item = await RegressionPlanService.addItem({
          planId,
          itemType: itemType as 'module' | 'flow' | 'test_case',
          ...(itemType === 'module' ? { moduleId: itemId } : {}),
          ...(itemType === 'flow' ? { flowId: itemId } : {}),
          ...(itemType === 'test_case' ? { testCaseId: itemId } : {}),
        });

        logger.info('[QA_TOOL] Plan item added', { planId, itemType, itemId, userId: context.userId });

        return {
          success: true,
          data: { planItemId: item.id, planId, itemType, itemId },
          message: `Added ${itemType} to plan`,
          displayToUser: true,
        };
      }

      case 'remove_item': {
        const itemId = args.item_id as string | undefined;
        if (!itemId) {
          return { success: false, message: 'Missing required field: item_id (the plan item ID to remove)', displayToUser: false };
        }

        await RegressionPlanService.removeItem(itemId, context.userId);

        logger.info('[QA_TOOL] Plan item removed', { itemId, userId: context.userId });

        return {
          success: true,
          data: { removedItemId: itemId },
          message: `Removed item from plan`,
          displayToUser: true,
        };
      }

      default:
        return { success: false, message: `Unknown action: ${action}`, displayToUser: false };
    }
  } catch (error) {
    logger.error('[QA_TOOL] handleManageRegressionPlan error', {
      error: error instanceof Error ? error.message : String(error),
      action,
    });
    return {
      success: false,
      message: `Failed to ${action} regression plan: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_manage_schedule — Create/update/toggle/delete schedule
 *
 * Safety:
 * - Requires `confirm: true`
 * - Create validates exactly one of plan_id/module_id
 */
export async function handleManageSchedule(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const action = args.action as string | undefined;
  const confirm = args.confirm === true;

  if (!action) {
    return { success: false, message: 'Missing required field: action', displayToUser: false };
  }

  const validActions = ['create', 'update', 'activate', 'deactivate', 'delete'];
  if (!validActions.includes(action)) {
    return { success: false, message: `Invalid action: ${action}. Must be one of: ${validActions.join(', ')}`, displayToUser: false };
  }

  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  try {
    switch (action) {
      case 'create': {
        const projectId = resolveProjectId(args, context);
        const name = args.name as string | undefined;
        const cronExpression = args.cron_expression as string | undefined;

        if (!projectId) {
          return { success: false, message: 'Missing required field: project_id', displayToUser: false };
        }
        if (!name) {
          return { success: false, message: 'Missing required field: name', displayToUser: false };
        }
        if (!cronExpression) {
          return { success: false, message: 'Missing required field: cron_expression', displayToUser: false };
        }

        // Validate exactly one of plan_id/module_id
        const hasPlanId = !!args.plan_id;
        const hasModuleId = !!args.module_id;
        if (!hasPlanId && !hasModuleId) {
          return { success: false, message: 'Must provide exactly one of plan_id or module_id', displayToUser: false };
        }
        if (hasPlanId && hasModuleId) {
          return { success: false, message: 'Must provide exactly one of plan_id or module_id, not both', displayToUser: false };
        }

        const schedule = await ScheduleService.create({
          projectId,
          userId: context.userId,
          name,
          cronExpression,
          timezone: args.timezone || undefined,
          planId: args.plan_id || undefined,
          moduleId: args.module_id || undefined,
        });

        logger.info('[QA_TOOL] Schedule created', { scheduleId: schedule.id, userId: context.userId });

        return {
          success: true,
          data: {
            scheduleId: schedule.id,
            name: schedule.name,
            cronExpression: schedule.cronExpression,
            isActive: schedule.isActive,
            nextRunAt: schedule.nextRunAt,
          },
          message: `Created schedule "${schedule.name}" (${schedule.cronExpression})`,
          displayToUser: true,
        };
      }

      case 'update': {
        const scheduleId = args.schedule_id as string | undefined;
        if (!scheduleId) {
          return { success: false, message: 'Missing required field: schedule_id', displayToUser: false };
        }

        const schedule = await ScheduleService.update({
          id: scheduleId,
          userId: context.userId,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.cron_expression !== undefined ? { cronExpression: args.cron_expression } : {}),
          ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
          ...(args.is_active !== undefined ? { isActive: args.is_active } : {}),
        });

        logger.info('[QA_TOOL] Schedule updated', { scheduleId: schedule.id, userId: context.userId });

        return {
          success: true,
          data: {
            scheduleId: schedule.id,
            name: schedule.name,
            cronExpression: schedule.cronExpression,
            isActive: schedule.isActive,
            nextRunAt: schedule.nextRunAt,
          },
          message: `Updated schedule "${schedule.name}"`,
          displayToUser: true,
        };
      }

      case 'activate': {
        const scheduleId = args.schedule_id as string | undefined;
        if (!scheduleId) {
          return { success: false, message: 'Missing required field: schedule_id', displayToUser: false };
        }

        const schedule = await ScheduleService.activate(scheduleId, context.userId);

        logger.info('[QA_TOOL] Schedule activated', { scheduleId, userId: context.userId });

        return {
          success: true,
          data: {
            scheduleId: schedule.id,
            name: schedule.name,
            isActive: true,
            nextRunAt: schedule.nextRunAt,
          },
          message: `Activated schedule "${schedule.name}"`,
          displayToUser: true,
        };
      }

      case 'deactivate': {
        const scheduleId = args.schedule_id as string | undefined;
        if (!scheduleId) {
          return { success: false, message: 'Missing required field: schedule_id', displayToUser: false };
        }

        const schedule = await ScheduleService.deactivate(scheduleId, context.userId);

        logger.info('[QA_TOOL] Schedule deactivated', { scheduleId, userId: context.userId });

        return {
          success: true,
          data: {
            scheduleId: schedule.id,
            name: schedule.name,
            isActive: false,
          },
          message: `Deactivated schedule "${schedule.name}"`,
          displayToUser: true,
        };
      }

      case 'delete': {
        const scheduleId = args.schedule_id as string | undefined;
        if (!scheduleId) {
          return { success: false, message: 'Missing required field: schedule_id', displayToUser: false };
        }

        await ScheduleService.delete(scheduleId, context.userId);

        logger.info('[QA_TOOL] Schedule deleted', { scheduleId, userId: context.userId });

        return {
          success: true,
          data: { deleted: true, scheduleId },
          message: `Deleted schedule`,
          displayToUser: true,
        };
      }

      default:
        return { success: false, message: `Unknown action: ${action}`, displayToUser: false };
    }
  } catch (error) {
    logger.error('[QA_TOOL] handleManageSchedule error', {
      error: error instanceof Error ? error.message : String(error),
      action,
    });
    return {
      success: false,
      message: `Failed to ${action} schedule: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_delete_test_case — Delete test case permanently (separate tool for extra safety)
 *
 * Safety:
 * - Requires `confirm: true` with extra-stern warning
 * - Ownership check before delete
 * - Fetches name for response before deleting
 */
export async function handleDeleteTestCase(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const testCaseId = args.test_case_id as string | undefined;
  const confirm = args.confirm === true;

  if (!testCaseId) {
    return { success: false, message: 'Missing required field: test_case_id', displayToUser: false };
  }

  if (!confirm) {
    return {
      success: false,
      message: 'DESTRUCTIVE operation: permanently deletes test case. Cannot be undone. You MUST first warn the user about permanent deletion, wait for their explicit approval ("yes", "delete it", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  try {
    const projectId = resolveProjectId(args, context);

    // Fetch name and verify ownership before deleting
    let verifyQuery = supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, user_id')
      .eq('id', testCaseId);

    if (projectId) {
      verifyQuery = verifyQuery.eq('project_id', projectId);
    }

    const { data: existing, error: fetchError } = await verifyQuery.single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return { success: false, message: `Test case not found: ${testCaseId}`, displayToUser: false };
      }
      return { success: false, message: `Database error: ${fetchError.message}`, displayToUser: false };
    }

    if (existing.user_id !== context.userId) {
      return {
        success: false,
        message: 'You can only delete test cases you created. This test case belongs to another user.',
        displayToUser: false,
      };
    }

    const testCaseName = existing.name;

    await IntentTestCaseService.delete(testCaseId, context.userId);

    logger.info('[QA_TOOL] Test case deleted', { testCaseId, testCaseName, userId: context.userId });

    return {
      success: true,
      data: { deleted: true, testCaseId, testCaseName },
      message: `Permanently deleted test case "${testCaseName}"`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleDeleteTestCase error', {
      error: error instanceof Error ? error.message : String(error),
      testCaseId,
    });
    return {
      success: false,
      message: `Failed to delete test case: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 3 — LOW PRIORITY WRITE TOOLS (Tools 34–37)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * qa_manage_fixture — Create/update/delete test fixtures
 *
 * Safety:
 * - Requires `confirm: true`
 */
export async function handleManageFixture(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const action = args.action as string | undefined;
  const confirm = args.confirm === true;

  if (!action) {
    return { success: false, message: 'Missing required field: action', displayToUser: false };
  }

  const validActions = ['create', 'update', 'delete'];
  if (!validActions.includes(action)) {
    return { success: false, message: `Invalid action: ${action}. Must be one of: ${validActions.join(', ')}`, displayToUser: false };
  }

  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  try {
    switch (action) {
      case 'create': {
        const projectId = resolveProjectId(args, context);
        const name = args.name as string | undefined;
        const data = args.data;

        if (!projectId) {
          return { success: false, message: 'Missing required field: project_id', displayToUser: false };
        }
        if (!name) {
          return { success: false, message: 'Missing required field: name', displayToUser: false };
        }
        if (data === undefined || data === null) {
          return { success: false, message: 'Missing required field: data', displayToUser: false };
        }

        const fixture = await FixtureService.create({
          projectId,
          userId: context.userId,
          name,
          data,
          description: args.description || undefined,
          scope: args.scope || undefined,
          tags: args.tags || undefined,
        });

        logger.info('[QA_TOOL] Fixture created', { fixtureId: fixture.id, userId: context.userId });

        return {
          success: true,
          data: { fixtureId: fixture.id, name: fixture.name, scope: fixture.scope },
          message: `Created fixture "${fixture.name}"`,
          displayToUser: true,
        };
      }

      case 'update': {
        const fixtureId = args.fixture_id as string | undefined;
        if (!fixtureId) {
          return { success: false, message: 'Missing required field: fixture_id', displayToUser: false };
        }

        const fixture = await FixtureService.update({
          id: fixtureId,
          userId: context.userId,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
        });

        logger.info('[QA_TOOL] Fixture updated', { fixtureId: fixture.id, userId: context.userId });

        return {
          success: true,
          data: { fixtureId: fixture.id, name: fixture.name, scope: fixture.scope },
          message: `Updated fixture "${fixture.name}"`,
          displayToUser: true,
        };
      }

      case 'delete': {
        const fixtureId = args.fixture_id as string | undefined;
        if (!fixtureId) {
          return { success: false, message: 'Missing required field: fixture_id', displayToUser: false };
        }

        await FixtureService.delete(fixtureId, context.userId);

        logger.info('[QA_TOOL] Fixture deleted', { fixtureId, userId: context.userId });

        return {
          success: true,
          data: { deleted: true, fixtureId },
          message: `Deleted fixture`,
          displayToUser: true,
        };
      }

      default:
        return { success: false, message: `Unknown action: ${action}`, displayToUser: false };
    }
  } catch (error) {
    logger.error('[QA_TOOL] handleManageFixture error', {
      error: error instanceof Error ? error.message : String(error),
      action,
    });
    return {
      success: false,
      message: `Failed to ${action} fixture: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_manage_module — Create or update test modules
 *
 * Safety:
 * - Requires `confirm: true`
 * - For create: resolves platform_key → platform_id via DB
 * - No delete — cascading delete is too dangerous for chat
 */
export async function handleManageModule(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const action = args.action as string | undefined;
  const confirm = args.confirm === true;

  if (!action) {
    return { success: false, message: 'Missing required field: action', displayToUser: false };
  }

  const validActions = ['create', 'update'];
  if (!validActions.includes(action)) {
    return { success: false, message: `Invalid action: ${action}. Must be one of: ${validActions.join(', ')}`, displayToUser: false };
  }

  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  try {
    switch (action) {
      case 'create': {
        const projectId = resolveProjectId(args, context);
        const name = args.name as string | undefined;
        const platformKey = args.platform_key as string | undefined;

        if (!projectId) {
          return { success: false, message: 'Missing required field: project_id', displayToUser: false };
        }
        if (!name) {
          return { success: false, message: 'Missing required field: name', displayToUser: false };
        }
        if (!platformKey || !['web_ui', 'api'].includes(platformKey)) {
          return { success: false, message: 'Missing or invalid platform_key. Must be web_ui or api.', displayToUser: false };
        }

        // Resolve platform_key → platform_id
        const { data: platform, error: platformError } = await supabaseAdmin
          .from('test_platforms')
          .select('id')
          .eq('platform_key', platformKey)
          .single();

        if (platformError || !platform) {
          return { success: false, message: `Could not resolve platform: ${platformKey}`, displayToUser: false };
        }

        const mod = await ModuleService.create({
          projectId,
          userId: context.userId,
          platformId: platform.id,
          name,
          description: args.description || undefined,
          tags: args.tags || undefined,
          priority: args.priority || undefined,
        });

        logger.info('[QA_TOOL] Module created', { moduleId: mod.id, userId: context.userId });

        return {
          success: true,
          data: { moduleId: mod.id, name: mod.name, platformKey },
          message: `Created module "${mod.name}" (${platformKey})`,
          displayToUser: true,
        };
      }

      case 'update': {
        const moduleId = args.module_id as string | undefined;
        if (!moduleId) {
          return { success: false, message: 'Missing required field: module_id', displayToUser: false };
        }

        const mod = await ModuleService.update({
          id: moduleId,
          userId: context.userId,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
        });

        logger.info('[QA_TOOL] Module updated', { moduleId: mod.id, userId: context.userId });

        return {
          success: true,
          data: { moduleId: mod.id, name: mod.name },
          message: `Updated module "${mod.name}"`,
          displayToUser: true,
        };
      }

      default:
        return { success: false, message: `Unknown action: ${action}`, displayToUser: false };
    }
  } catch (error) {
    logger.error('[QA_TOOL] handleManageModule error', {
      error: error instanceof Error ? error.message : String(error),
      action,
    });
    return {
      success: false,
      message: `Failed to ${action} module: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_manage_flow — Create, update, or reorder test flows
 *
 * Safety:
 * - Requires `confirm: true`
 */
export async function handleManageFlow(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const action = args.action as string | undefined;
  const confirm = args.confirm === true;

  if (!action) {
    return { success: false, message: 'Missing required field: action', displayToUser: false };
  }

  const validActions = ['create', 'update', 'reorder'];
  if (!validActions.includes(action)) {
    return { success: false, message: `Invalid action: ${action}. Must be one of: ${validActions.join(', ')}`, displayToUser: false };
  }

  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  try {
    switch (action) {
      case 'create': {
        const moduleId = args.module_id as string | undefined;
        const name = args.name as string | undefined;

        if (!moduleId) {
          return { success: false, message: 'Missing required field: module_id', displayToUser: false };
        }
        if (!name) {
          return { success: false, message: 'Missing required field: name', displayToUser: false };
        }

        const flow = await FlowService.create({
          moduleId,
          userId: context.userId,
          name,
          description: args.description || undefined,
          flowType: args.flow_type || undefined,
          tags: args.tags || undefined,
          priority: args.priority || undefined,
          preconditions: args.preconditions || undefined,
          expectedResult: args.expected_result || undefined,
        });

        logger.info('[QA_TOOL] Flow created', { flowId: flow.id, userId: context.userId });

        return {
          success: true,
          data: { flowId: flow.id, name: flow.name, flowType: flow.flowType },
          message: `Created flow "${flow.name}"`,
          displayToUser: true,
        };
      }

      case 'update': {
        const flowId = args.flow_id as string | undefined;
        if (!flowId) {
          return { success: false, message: 'Missing required field: flow_id', displayToUser: false };
        }

        const flow = await FlowService.update({
          id: flowId,
          userId: context.userId,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.flow_type !== undefined ? { flowType: args.flow_type } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
        });

        logger.info('[QA_TOOL] Flow updated', { flowId: flow.id, userId: context.userId });

        return {
          success: true,
          data: { flowId: flow.id, name: flow.name, flowType: flow.flowType },
          message: `Updated flow "${flow.name}"`,
          displayToUser: true,
        };
      }

      case 'reorder': {
        const moduleId = args.module_id as string | undefined;
        const flowIds = args.flow_ids as string[] | undefined;

        if (!moduleId) {
          return { success: false, message: 'Missing required field: module_id', displayToUser: false };
        }
        if (!flowIds || !Array.isArray(flowIds) || flowIds.length === 0) {
          return { success: false, message: 'Missing or empty required field: flow_ids (array of flow IDs in new order)', displayToUser: false };
        }

        await FlowService.reorder(moduleId, flowIds, context.userId);

        logger.info('[QA_TOOL] Flows reordered', { moduleId, flowCount: flowIds.length, userId: context.userId });

        return {
          success: true,
          data: { moduleId, reorderedCount: flowIds.length },
          message: `Reordered ${flowIds.length} flows in module`,
          displayToUser: true,
        };
      }

      default:
        return { success: false, message: `Unknown action: ${action}`, displayToUser: false };
    }
  } catch (error) {
    logger.error('[QA_TOOL] handleManageFlow error', {
      error: error instanceof Error ? error.message : String(error),
      action,
    });
    return {
      success: false,
      message: `Failed to ${action} flow: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_bulk_tag — Add or remove a tag from multiple test cases
 *
 * Safety:
 * - Requires `confirm: true`
 * - Capped at 50 IDs to prevent abuse
 * - Ownership enforced per-case by service
 */
export async function handleBulkTag(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const action = args.action as string | undefined;
  const tag = args.tag as string | undefined;
  const testCaseIds = args.test_case_ids as string[] | undefined;
  const confirm = args.confirm === true;

  if (!action || !['add', 'remove'].includes(action)) {
    return { success: false, message: 'Missing or invalid action. Must be add or remove.', displayToUser: false };
  }
  if (!tag || typeof tag !== 'string') {
    return { success: false, message: 'Missing required field: tag', displayToUser: false };
  }
  if (!testCaseIds || !Array.isArray(testCaseIds) || testCaseIds.length === 0) {
    return { success: false, message: 'Missing or empty required field: test_case_ids', displayToUser: false };
  }
  if (testCaseIds.length > 50) {
    return { success: false, message: 'Too many test case IDs. Maximum is 50.', displayToUser: false };
  }

  if (!confirm) {
    return {
      success: false,
      message: 'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
      displayToUser: false,
    };
  }

  try {
    let updatedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    for (const tcId of testCaseIds) {
      try {
        // Fetch current tags
        const { data: tc, error: fetchError } = await supabaseAdmin
          .from('intent_test_cases')
          .select('id, tags')
          .eq('id', tcId)
          .single();

        if (fetchError || !tc) {
          failedCount++;
          errors.push(`${tcId}: not found`);
          continue;
        }

        const currentTags: string[] = tc.tags || [];
        let newTags: string[];

        if (action === 'add') {
          if (currentTags.includes(tag)) {
            updatedCount++; // Already has the tag, count as success
            continue;
          }
          newTags = [...currentTags, tag];
        } else {
          if (!currentTags.includes(tag)) {
            updatedCount++; // Doesn't have the tag, count as success
            continue;
          }
          newTags = currentTags.filter((t) => t !== tag);
        }

        await IntentTestCaseService.update({
          id: tcId,
          userId: context.userId,
          tags: newTags,
        });

        updatedCount++;
      } catch (err) {
        failedCount++;
        errors.push(`${tcId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logger.info('[QA_TOOL] Bulk tag operation completed', {
      action,
      tag,
      updatedCount,
      failedCount,
      userId: context.userId,
    });

    return {
      success: true,
      data: {
        tag,
        action,
        updatedCount,
        failedCount,
        ...(errors.length > 0 ? { errors } : {}),
      },
      message: `Bulk ${action} tag "${tag}": ${updatedCount} updated, ${failedCount} failed`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleBulkTag error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to bulk ${action} tag: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}
