import { supabaseAdmin } from '@/db/supabase';
import { PatternsQueryService } from '@/services/kb/patterns-query.service';
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
