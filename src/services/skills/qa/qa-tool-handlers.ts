import { supabaseAdmin } from '@/db/supabase';
import { AutomationActionService } from '@/services/automation/automation-action.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import { PatternsQueryService } from '@/services/kb/patterns-query.service';
import { CoverageAnalysisService } from '@/services/testing/analysis/coverage-analysis.service';
import { FailureAnalysisService } from '@/services/testing/analysis/failure-analysis.service';
import { TestRecommendationService } from '@/services/testing/analysis/test-recommendation.service';
import { AnalyticsQueryService } from '@/services/analytics/analytics-query.service';
import { AIUsageQueryService } from '@/services/ai/tracking/ai-usage-query.service';
import { FixtureService } from '@/services/testing/fixtures/fixture.service';
import { ApiConfigService } from '@/services/api/api-config.service';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { sanitizeSteps } from '@/services/testing/shared/step-sanitizer';
import { containsBoundSecretPlaceholder } from '@/utils/interpolation/redact-secrets';
import { CredentialAuthoringFeature } from '@/config/features/credential-authoring';
import type { resolveNamedCredentialSecret } from '@/services/testing/ui/preview/named-credential-secret';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { ModuleService } from '@/services/testing/modules/module.service';
import { FlowService } from '@/services/testing/flows/flow.service';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { SkillContext, SkillResult } from '../types';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import * as crypto from 'crypto';

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

/** Upper bound on iterative-authoring rounds we'll ever bill for. Defends
 * against a runaway/garbage `roundsExecuted` charging a user a huge amount.
 * Matches the service's DEFAULT_MAX_ROUNDS (12) with headroom. */
export const MAX_BILLABLE_AUTHORING_ROUNDS = 20;

/**
 * Credits to charge for iterative authoring, ON TOP OF the base 1 the chat turn
 * already deducts. Pure + total-safe so billing can never go wrong:
 *   - Only charges on success (the chat turn only takes its base 1 on success,
 *     so total = rounds on success, 0 on failure — symmetric, no cross-file
 *     assumptions beyond the shared success signal).
 *   - NaN / non-finite / negative rounds → 0 (never charge garbage).
 *   - rounds clamped to MAX_BILLABLE_AUTHORING_ROUNDS (never over-charge).
 *   - Returns `rounds - 1` (the base 1 is the turn's) → never negative.
 *
 * @returns extra credits to deduct here (0 means: charge nothing beyond base).
 */
export function computeAuthoringExtraCredits(success: boolean, roundsExecuted: number): number {
  if (!success) return 0;
  if (!Number.isFinite(roundsExecuted) || roundsExecuted <= 0) return 0;
  const rounds = Math.min(Math.floor(roundsExecuted), MAX_BILLABLE_AUTHORING_ROUNDS);
  return Math.max(0, rounds - 1); // base 1 is taken by the chat turn
}

// ── Name → ID resolvers ───────────────────────────────────────────────────
// Allow users to reference entities by name instead of UUID.
// Each resolver returns the ID if exactly one match is found,
// or a descriptive error if zero or multiple matches are found.

type ResolveResult = { id: string } | { error: string };

async function resolveByName(
  table: string,
  nameColumn: string,
  name: string,
  projectId: string,
  label: string,
): Promise<ResolveResult> {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('id, ' + nameColumn)
    .eq('project_id', projectId)
    .ilike(nameColumn, `%${name}%`) as { data: any[] | null; error: any };

  if (error) return { error: `Failed to search ${label}: ${error.message}` };
  if (!data || data.length === 0) return { error: `No ${label} found matching "${name}"` };
  if (data.length === 1) return { id: data[0].id };

  // Multiple matches — return list so the AI can disambiguate
  const list = data.slice(0, 5).map((r: any) => `• ${r[nameColumn]} (${r.id})`).join('\n');
  return { error: `Multiple ${label}s match "${name}":\n${list}\nPlease specify the exact name or ID.` };
}

async function resolvePlanByName(name: string, projectId: string): Promise<ResolveResult> {
  return resolveByName('regression_plans', 'name', name, projectId, 'regression plan');
}

async function resolveModuleByName(name: string, projectId: string): Promise<ResolveResult> {
  return resolveByName('test_modules', 'name', name, projectId, 'module');
}

async function resolveScheduleByName(name: string, projectId: string): Promise<ResolveResult> {
  return resolveByName('test_schedules', 'name', name, projectId, 'schedule');
}

async function resolveTestCaseByName(name: string, projectId: string): Promise<ResolveResult> {
  return resolveByName('intent_test_cases', 'name', name, projectId, 'test case');
}

async function resolveFlowByName(name: string, moduleId: string): Promise<ResolveResult> {
  const { data, error } = await supabaseAdmin
    .from('test_flows')
    .select('id, name')
    .eq('module_id', moduleId)
    .ilike('name', `%${name}%`) as { data: any[] | null; error: any };

  if (error) return { error: `Failed to search flow: ${error.message}` };
  if (!data || data.length === 0) return { error: `No flow found matching "${name}"` };
  if (data.length === 1) return { id: data[0].id };

  const list = data.slice(0, 5).map((r: any) => `• ${r.name} (${r.id})`).join('\n');
  return { error: `Multiple flows match "${name}":\n${list}\nPlease specify the exact name or ID.` };
}

/**
 * Resolve a flow by name within a PROJECT (flows are module-scoped, so we join
 * through test_modules). Used by add_item, where only a project is in scope —
 * not a specific module. Mirrors the resolveByName contract.
 */
async function resolveFlowByNameInProject(name: string, projectId: string): Promise<ResolveResult> {
  const { data, error } = await supabaseAdmin
    .from('test_flows')
    .select('id, name, test_modules!inner(project_id)')
    .eq('test_modules.project_id', projectId)
    .ilike('name', `%${name}%`) as { data: any[] | null; error: any };

  if (error) return { error: `Failed to search flow: ${error.message}` };
  if (!data || data.length === 0) return { error: `No flow found matching "${name}"` };
  if (data.length === 1) return { id: data[0].id };

  const list = data.slice(0, 5).map((r: any) => `• ${r.name} (${r.id})`).join('\n');
  return { error: `Multiple flows match "${name}":\n${list}\nPlease specify the exact name or ID.` };
}

async function resolveAutomationActionByName(name: string, userId: string): Promise<ResolveResult> {
  const { data, error } = await supabaseAdmin
    .from('automation_actions')
    .select('id, name')
    .eq('user_id', userId)
    .ilike('name', `%${name}%`) as { data: any[] | null; error: any };

  if (error) return { error: `Failed to search automation action: ${error.message}` };
  if (!data || data.length === 0) return { error: `No automation action found matching "${name}"` };
  if (data.length === 1) return { id: data[0].id };

  const list = data.slice(0, 5).map((r: any) => `• ${r.name} (${r.id})`).join('\n');
  return { error: `Multiple automation actions match "${name}":\n${list}\nPlease specify the exact name or ID.` };
}

/**
 * Resolve a run_id: if the user provides a plan name instead of UUID,
 * find the latest run for that plan. Used by qa_get_run_status, qa_cancel_run, qa_share_result.
 */
async function resolveRunId(
  runId: string | undefined,
  search: string | undefined,
  projectId: string | undefined,
  userId: string,
): Promise<{ id: string | undefined; error?: string }> {
  if (runId && isUUID(runId)) return { id: runId };

  // If runId looks like a name or search is provided, resolve via plan name → latest run
  const nameQuery = (runId && !isUUID(runId)) ? runId : search;
  if (!nameQuery) return { id: undefined };
  if (!projectId) return { id: undefined, error: 'project_id required when searching runs by name' };

  // Find plans matching the name
  const { data: plans } = await supabaseAdmin
    .from('regression_plans')
    .select('id, name')
    .eq('project_id', projectId)
    .ilike('name', `%${nameQuery}%`);

  if (!plans || plans.length === 0) {
    return { id: undefined, error: `No regression plan found matching "${nameQuery}"` };
  }

  const planIds = plans.map(p => p.id);

  // Get the latest run for matching plans
  const { data: latestRun } = await supabaseAdmin
    .from('regression_runs')
    .select('id, plan_id')
    .eq('user_id', userId)
    .in('plan_id', planIds)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestRun) {
    const planNames = plans.map(p => p.name).join(', ');
    return { id: undefined, error: `No regression runs found for plan(s): ${planNames}` };
  }

  return { id: latestRun.id };
}

/** Resolve an ID param: if it looks like a UUID, use directly; otherwise treat as name search. */
function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}


/**
 * qa_list_test_cases — Query saved test cases with filters
 */
export async function handleListTestCases(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const status = args.status || 'all';
  const search = args.search as string | undefined;
  const limit = Math.min(args.limit || 20, 50);
  const sortBy = (['created_at', 'updated_at', 'name', 'priority'].includes(args.sort_by) ? args.sort_by : 'created_at') as string;
  const sortOrder = args.sort_order === 'asc' ? true : false; // ascending = true for 'asc'

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    let query = supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, url, start_url, status, priority, tags, created_at, updated_at')
      .eq('project_id', projectId)
      .order(sortBy, { ascending: sortOrder })
      .limit(limit);

    // Apply status filter only if not "all"
    if (status !== 'all') {
      query = query.eq('status', status);
    }

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
      createdAt: tc.created_at,
      updatedAt: tc.updated_at,
    }));

    logger.info('[QA_TOOL] handleListTestCases result', {
      projectId,
      projectIdSource: context.projectId ? 'context' : 'args',
      status,
      sortBy,
      sortOrder: sortOrder ? 'asc' : 'desc',
      limit,
      search: search || null,
      resultCount: testCases.length,
    });

    const statusLabel = status === 'all' ? '' : ` ${status}`;

    // When zero results, include project_id in response so the AI can help the user diagnose
    if (testCases.length === 0) {
      return {
        success: true,
        data: { testCases: [], total: 0, projectId },
        message: `No test cases found in project ${projectId} (status filter: ${status || 'all'}, search: ${search || 'none'}). This could mean: (1) the project has no test cases yet, (2) the user might be in the wrong project/chat session. Suggest the user check which project they are working in.`,
        displayToUser: false,
      };
    }

    return {
      success: true,
      data: { testCases, total: testCases.length },
      message: `Found ${testCases.length}${statusLabel} test cases (sorted by ${sortBy} ${sortOrder ? 'asc' : 'desc'})`,
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
  let testCaseId = args.test_case_id as string | undefined;
  const limit = Math.min(args.limit || 20, 50);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  // Resolve test_case_id by name
  if (testCaseId && !isUUID(testCaseId)) {
    const r = await resolveTestCaseByName(testCaseId, projectId);
    if ('error' in r) return { success: false, message: r.error, displayToUser: true };
    testCaseId = r.id;
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
      logger.info('[QA_TOOL] handleListTestExecutions: no runs', { projectId, days });
      return {
        success: true,
        data: { executions: [], total: 0, projectId },
        message: `No regression runs found in project ${projectId} in the last ${days} days. The user may not have run any tests yet, or the test results might be in a different project.`,
        displayToUser: false,
      };
    }

    // Step 2: Query executions for those runs (batched to avoid URL length limits)
    const batchSize = 100;
    let allExecRows: any[] = [];
    const ascending = args.sort_order === 'asc';

    for (let i = 0; i < runIds.length; i += batchSize) {
      const batch = runIds.slice(i, i + batchSize);
      let query = supabaseAdmin
        .from('test_executions')
        .select('id, test_case_id, status, duration_ms, browser, created_at, error_message')
        .in('run_id', batch)
        .order('created_at', { ascending });

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
    allExecRows.sort((a, b) => {
      const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return ascending ? diff : -diff;
    });
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

// ── Sensitive Data Sanitization ────────────────────────────────────────────
// Masks credential values in test steps before sending to the LLM.
// The AI sees the step structure but not actual passwords/tokens/secrets.

/** Patterns that indicate a step's value contains sensitive data. */
const SENSITIVE_STEP_PATTERNS = /password|passwd|secret|token|api[_-]?key|auth|credential|pin|otp|cvv/i;

/**
 * Sanitize steps_json for AI consumption:
 * - Masks values on steps whose description or type matches sensitive patterns
 * - Preserves step structure so AI understands the test flow
 */
function sanitizeStepsForAI(stepsJson: any): any {
  if (!stepsJson) return stepsJson;

  // steps_json can be stored as string or array in Supabase jsonb
  let steps: any[];
  if (typeof stepsJson === 'string') {
    try {
      steps = JSON.parse(stepsJson);
    } catch {
      return stepsJson; // Unparseable — return as-is (truncateField will handle)
    }
  } else if (Array.isArray(stepsJson)) {
    steps = stepsJson;
  } else {
    return stepsJson;
  }

  return steps.map((step: any) => {
    if (!step || typeof step !== 'object') return step;

    const desc = (step.description || '').toLowerCase();
    const stepType = (step.type || '').toLowerCase();

    // Mask value if description or type hints at sensitive data
    const isSensitive =
      SENSITIVE_STEP_PATTERNS.test(desc) ||
      SENSITIVE_STEP_PATTERNS.test(stepType) ||
      (stepType === 'type' && SENSITIVE_STEP_PATTERNS.test(desc));

    if (isSensitive && step.value) {
      return { ...step, value: '••••••••' };
    }
    return step;
  });
}

// ── Test Type Inference ───────────────────────────────────────────────────

/** Action types that indicate a UI test. */
const UI_ACTION_TYPES = new Set([
  'click', 'type', 'navigate', 'scroll', 'hover', 'select',
  'press', 'wait', 'ai_check', 'drag', 'upload', 'screenshot',
]);

/**
 * Infer whether a test case is a UI test or API test based on its steps.
 * Returns 'ui' | 'api' | 'mixed' | 'unknown'.
 */
function inferTestType(stepsJson: any): 'ui' | 'api' | 'mixed' | 'unknown' {
  if (!stepsJson) return 'unknown';

  let steps: any[];
  if (typeof stepsJson === 'string') {
    try {
      steps = JSON.parse(stepsJson);
    } catch {
      return 'unknown';
    }
  } else if (Array.isArray(stepsJson)) {
    steps = stepsJson;
  } else {
    return 'unknown';
  }

  if (steps.length === 0) return 'unknown';

  let uiCount = 0;
  let apiCount = 0;

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const t = (step.type || '').toLowerCase();
    if (UI_ACTION_TYPES.has(t)) {
      uiCount++;
    } else if (t === 'http_request' || t === 'api_call' || t === 'graphql') {
      apiCount++;
    }
  }

  if (uiCount > 0 && apiCount > 0) return 'mixed';
  if (uiCount > 0) return 'ui';
  if (apiCount > 0) return 'api';
  return 'unknown';
}

/**
 * qa_get_test_case — Get detailed info about a single test case
 */
export async function handleGetTestCase(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  let testCaseId = args.test_case_id as string | undefined;

  // Resolve test_case_id by name
  if (testCaseId && !isUUID(testCaseId)) {
    const projectId = resolveProjectId(args, context);
    if (projectId) {
      const r = await resolveTestCaseByName(testCaseId, projectId);
      if ('error' in r) return { success: false, message: r.error, displayToUser: true };
      testCaseId = r.id;
    }
  }

  if (!testCaseId) {
    return { success: false, message: 'Missing required field: test_case_id (UUID or name)', displayToUser: false };
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

    // Infer test type from step actions (ui/api/mixed/unknown)
    const testType = inferTestType(data.steps_json);

    // Sanitize sensitive values (passwords, tokens) before sending to LLM
    const sanitizedSteps = sanitizeStepsForAI(data.steps_json);

    const testCase = {
      id: data.id,
      name: data.name,
      description: data.description,
      url: data.url || data.start_url,
      status: data.status,
      testType,
      stepsJson: truncateField(sanitizedSteps, 5000),
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
      message: `Test case: ${data.name} (${testType} test)`,
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
  let runId = args.run_id as string | undefined;

  // Resolve run_id: accept UUID or plan name (finds latest run for that plan)
  if (runId && !isUUID(runId)) {
    const projectId = resolveProjectId(args, context);
    const resolved = await resolveRunId(runId, undefined, projectId, context.userId);
    if (resolved.error) return { success: false, message: resolved.error, displayToUser: true };
    runId = resolved.id;
  }

  if (!runId) {
    return { success: false, message: 'Missing required field: run_id (UUID or plan name)', displayToUser: false };
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
  const search = args.search as string | undefined;
  const sortBy = (['created_at', 'updated_at', 'name'].includes(args.sort_by) ? args.sort_by : 'created_at') as string;
  const sortOrder = args.sort_order === 'asc' ? true : false;
  const limit = args.limit ? Math.min(args.limit, 50) : undefined;

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    let plansQuery = supabaseAdmin
      .from('regression_plans')
      .select('id, name, description, is_default, tags, created_at, updated_at')
      .eq('project_id', projectId)
      .order(sortBy, { ascending: sortOrder });

    if (search) {
      const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/[,.()"]/g, '');
      plansQuery = plansQuery.ilike('name', `%${escaped}%`);
    }

    if (limit) {
      plansQuery = plansQuery.limit(limit);
    }

    const { data: plans, error: plansError } = await plansQuery;

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
    // Support custom date range OR days lookback
    let sinceDate: Date;
    let untilDate: Date | undefined;

    if (args.start_date) {
      sinceDate = new Date(args.start_date);
      if (isNaN(sinceDate.getTime())) {
        return { success: false, message: 'Invalid start_date format. Use ISO 8601 (e.g. 2025-01-01)', displayToUser: false };
      }
      if (args.end_date) {
        untilDate = new Date(args.end_date);
        if (isNaN(untilDate.getTime())) {
          return { success: false, message: 'Invalid end_date format. Use ISO 8601 (e.g. 2025-01-31)', displayToUser: false };
        }
      }
    } else {
      sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
    }

    // Get runs for the period
    let runsQuery = supabaseAdmin
      .from('regression_runs')
      .select('id, status, started_at, completed_at')
      .eq('project_id', projectId)
      .gte('started_at', sinceDate.toISOString());
    if (untilDate) {
      runsQuery = runsQuery.lte('started_at', untilDate.toISOString());
    }
    const { data: runs, error: runsError } = await runsQuery.order('started_at', { ascending: false });

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
 * Accepts test_id (execution ID) directly, OR test_case_id (name or UUID) to auto-resolve the latest execution.
 */
export async function handleGetTestResults(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  let testId = args.test_id as string | undefined;
  const projectId = resolveProjectId(args, context);

  // If test_case_id is provided instead of test_id, find the latest execution for that test case
  if (!testId && args.test_case_id) {
    let testCaseId = args.test_case_id as string;

    // Resolve test case by name if not UUID
    if (!isUUID(testCaseId) && projectId) {
      const r = await resolveTestCaseByName(testCaseId, projectId);
      if ('error' in r) return { success: false, message: r.error, displayToUser: true };
      testCaseId = r.id;
    }

    // Find the latest execution for this test case
    const { data: latestExec } = await supabaseAdmin
      .from('test_executions')
      .select('id')
      .eq('test_case_id', testCaseId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestExec) {
      return { success: true, data: { testResult: null }, message: `No executions found for test case: ${args.test_case_id}. The test hasn't been run yet.`, displayToUser: false };
    }
    testId = latestExec.id;
  }

  if (!testId) {
    return { success: false, message: 'Missing required field: test_id or test_case_id', displayToUser: false };
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
  const search = args.search as string | undefined;
  const days = args.days ? Math.min(args.days, 90) : undefined;
  const limit = Math.min(args.limit || 20, 50);

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    // Step 1: Get session IDs for this project
    let sessionsQuery = supabaseAdmin
      .from('intelligent_test_sessions')
      .select('id')
      .eq('project_id', projectId);

    if (days) {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      // Column is `started_at`, not `created_at` — see schema in
      // supabase-migrations/features/intelligent-test-scenarios.sql:46.
      // Every other call site in the codebase (analytics-query.service.ts,
      // ai-analysis.job.ts, intelligentTest.controller.ts) uses
      // `started_at` for this table; this handler was added later and
      // missed the convention.
      sessionsQuery = sessionsQuery.gte('started_at', sinceDate.toISOString());
    }

    const { data: sessions, error: sessionsError } = await sessionsQuery;

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

    // Sort, search-filter, and limit
    allFindings.sort((a, b) => new Date(b.found_at).getTime() - new Date(a.found_at).getTime());

    // Apply text search filter post-fetch (title + description)
    if (search) {
      const searchLower = search.toLowerCase();
      allFindings = allFindings.filter(
        (f) =>
          (f.title && f.title.toLowerCase().includes(searchLower)) ||
          (f.description && f.description.toLowerCase().includes(searchLower))
      );
    }

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
      message: `Found ${findings.length} test findings${severity ? ` (severity: ${severity})` : ''}${search ? ` matching "${search}"` : ''}${days ? ` in the last ${days} days` : ''}`,
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
  const sortBy = (['created_at', 'updated_at', 'name'].includes(args.sort_by) ? args.sort_by : 'created_at') as string;
  const sortOrder = args.sort_order === 'asc' ? true : false;
  const limit = args.limit ? Math.min(args.limit, 50) : undefined;

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    // LEFT join by default so platform-agnostic folders (platform_id NULL) are
    // included; inner join only when filtering by platformKey so the embedded
    // filter actually excludes non-matching rows.
    const moduleSelect = platformKey
      ? 'id, name, description, platform_id, tags, priority, created_at, updated_at, test_platforms!inner(platform_key)'
      : 'id, name, description, platform_id, tags, priority, created_at, updated_at, test_platforms(platform_key)';
    let query = supabaseAdmin
      .from('test_modules')
      .select(moduleSelect)
      .eq('project_id', projectId)
      .order(sortBy, { ascending: sortOrder });

    if (limit) {
      query = query.limit(limit);
    }

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
  let moduleId = args.module_id as string | undefined;
  const projectId = resolveProjectId(args, context);

  // Resolve module_id by name
  if (moduleId && !isUUID(moduleId) && projectId) {
    const r = await resolveModuleByName(moduleId, projectId);
    if ('error' in r) return { success: false, message: r.error, displayToUser: true };
    moduleId = r.id;
  }

  if (!moduleId) {
    return { success: false, message: 'Missing required field: module_id (UUID or name)', displayToUser: false };
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

    const sortBy = (['order_index', 'created_at', 'updated_at', 'name'].includes(args.sort_by) ? args.sort_by : 'order_index') as string;
    const sortOrder = args.sort_order === 'desc' ? false : true; // default asc for flows (order_index)
    const flowLimit = args.limit ? Math.min(args.limit, 50) : undefined;

    let flowQuery = supabaseAdmin
      .from('test_flows')
      .select('id, module_id, name, description, order_index, flow_type, tags, priority, preconditions, expected_result, created_at, updated_at')
      .eq('module_id', moduleId)
      .order(sortBy, { ascending: sortOrder });

    if (flowLimit) {
      flowQuery = flowQuery.limit(flowLimit);
    }

    const { data, error } = await flowQuery;

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
  const search = args.search as string | undefined;
  const sortBy = (['created_at', 'next_run_at', 'name'].includes(args.sort_by) ? args.sort_by : 'created_at') as string;
  const sortOrder = args.sort_order === 'asc' ? true : false;
  const limit = args.limit ? Math.min(args.limit, 50) : undefined;
  const planId = args.plan_id as string | undefined;
  const moduleId = args.module_id as string | undefined;

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    let query = supabaseAdmin
      .from('test_schedules')
      .select('id, name, schedule_type, cron_expression, run_at, timezone, is_active, module_id, plan_id, last_run_at, next_run_at, created_at')
      .eq('project_id', projectId)
      .order(sortBy, { ascending: sortOrder });

    if (activeOnly) {
      query = query.eq('is_active', true);
    }
    if (search) {
      const escaped = search.replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/[,.()"]/g, '');
      query = query.ilike('name', `%${escaped}%`);
    }
    if (planId) {
      query = query.eq('plan_id', planId);
    }
    if (moduleId) {
      query = query.eq('module_id', moduleId);
    }
    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('[QA_TOOL] Failed to list schedules', { error: error.message, projectId });
      return { success: false, message: `Database error: ${error.message}`, displayToUser: false };
    }

    const schedules = (data || []).map((s) => {
      const scheduleType = (s.schedule_type as 'recurring' | 'one_time') || 'recurring';
      return {
        id: s.id,
        name: s.name,
        scheduleType,
        cronExpression: s.cron_expression || null,
        runAt: s.run_at || null,
        // Human-readable "when" so the chat agent can describe either mode.
        when: scheduleType === 'one_time'
          ? (s.run_at ? `once at ${ScheduleService.formatRunAtForHuman(s.run_at, s.timezone)}` : 'one-time (time unset)')
          : (s.cron_expression || 'recurring'),
        timezone: s.timezone,
        isActive: s.is_active,
        moduleId: s.module_id || null,
        planId: s.plan_id || null,
        lastRunAt: s.last_run_at || null,
        nextRunAt: s.next_run_at || null,
        createdAt: s.created_at,
      };
    });

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
  const urlSearch = args.url_search as string | undefined;
  const methodFilter = args.method as string | undefined;
  const days = Math.min(args.days || 30, 90);
  const ascending = args.sort_order === 'asc';

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    // Get chat sessions for this project to scope API test executions
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

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
        data: { executions: [], total: 0, projectId },
        message: `No API test history found in project ${projectId}. The user may not have run any API tests yet.`,
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
        .gte('executed_at', sinceDate.toISOString())
        .order('executed_at', { ascending });

      if (successFilter !== undefined) {
        query = query.eq('success', successFilter);
      }
      if (methodFilter) {
        query = query.eq('method', methodFilter.toUpperCase());
      }
      if (urlSearch) {
        const escaped = urlSearch.replace(/%/g, '\\%').replace(/_/g, '\\_').replace(/[,.()"]/g, '');
        query = query.ilike('url', `%${escaped}%`);
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
    allRows.sort((a, b) => {
      const diff = new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime();
      return ascending ? diff : -diff;
    });
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
      message: `Found ${executions.length} API test executions in the last ${days} days`,
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
// ANALYTICS DEEP-DIVE TOOLS (direct Supabase queries, no REST API)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * qa_get_results_overview — Donut chart: passed/failed/skipped/flaky counts + API tests
 */
export async function handleGetResultsOverview(
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
      .select('id')
      .eq('project_id', projectId)
      .gte('started_at', sinceDate.toISOString());

    if (runsError) {
      logger.error('[QA_TOOL] Failed to get runs for results overview', { error: runsError.message });
      return { success: false, message: `Database error: ${runsError.message}`, displayToUser: false };
    }

    const runIds = (runs || []).map((r) => r.id);

    // Parallel: executions (batched to avoid URL length limits) + API tests
    const batchSize = 100;
    const execsPromise = (async () => {
      if (runIds.length === 0) return [];
      const allExecs: any[] = [];
      for (let i = 0; i < runIds.length; i += batchSize) {
        const batch = runIds.slice(i, i + batchSize);
        const { data } = await supabaseAdmin
          .from('test_executions')
          .select('status, run_id, test_case_id')
          .in('run_id', batch);
        if (data) allExecs.push(...data);
      }
      return allExecs;
    })();

    const [execs, apiResult] = await Promise.all([
      execsPromise,
      supabaseAdmin
        .from('api_test_executions')
        .select('success')
        .eq('project_id', projectId)
        .gte('executed_at', sinceDate.toISOString()),
    ]);

    const passed = execs.filter((e: any) => e.status === 'passed').length;
    const failed = execs.filter((e: any) => e.status === 'failed').length;
    const skipped = execs.filter((e: any) => e.status === 'skipped').length;
    const total = execs.length;

    // Flaky detection
    const groups = new Map<string, Set<string>>();
    for (const exec of execs) {
      const key = `${(exec as any).run_id}:${(exec as any).test_case_id}`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key)!.add((exec as any).status);
    }
    let flaky = 0;
    for (const statuses of groups.values()) {
      if (statuses.has('passed') && statuses.has('failed')) flaky++;
    }

    const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

    // API tests
    const apiExecs = apiResult.data || [];
    const apiTotal = apiExecs.length;
    const apiPassed = apiExecs.filter((e: any) => e.success === true).length;
    const apiFailed = apiExecs.filter((e: any) => e.success === false).length;

    return {
      success: true,
      data: {
        passed,
        failed,
        skipped,
        flaky,
        total,
        percentages: { passed: pct(passed), failed: pct(failed), skipped: pct(skipped), flaky: pct(flaky) },
        ...(apiTotal > 0 ? { apiTests: { total: apiTotal, passed: apiPassed, failed: apiFailed } } : {}),
        periodDays: days,
      },
      message: `Results overview (${days}d): ${total} total — ${passed} passed (${pct(passed)}%), ${failed} failed (${pct(failed)}%), ${skipped} skipped, ${flaky} flaky`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetResultsOverview error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get results overview: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_heatmap — Daily activity heatmap (runs/failures/flaky) with intensity levels
 */
export async function handleGetHeatmap(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const metric = (['runs', 'failures', 'flaky'].includes(args.metric) ? args.metric : 'runs') as 'runs' | 'failures' | 'flaky';
  const range = (['30d', '90d', '365d'].includes(args.range) ? args.range : '30d') as '30d' | '90d' | '365d';

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const result = await AnalyticsQueryService.getHeatmap(context.workspaceId, metric, range, projectId);

    // Summarize for LLM — don't send hundreds of day-entries, send a compact summary
    const activeDays = result.days.filter((d) => d.count > 0);
    const topDays = [...activeDays].sort((a, b) => b.count - a.count).slice(0, 10);

    return {
      success: true,
      data: {
        metric,
        range,
        totalCount: result.totalCount,
        maxCount: result.maxCount,
        activeDays: activeDays.length,
        totalDays: result.days.length,
        busiestDays: topDays.map((d) => ({ date: d.date, count: d.count, level: d.level })),
      },
      message: `Heatmap (${metric}, ${range}): ${result.totalCount} total across ${activeDays.length} active days, peak ${result.maxCount} in a single day`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetHeatmap error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get heatmap: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_time_series — Bucketed run counts over time (1m/5m/15m/1h/1d intervals)
 */
export async function handleGetTimeSeries(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const interval = (['1m', '5m', '15m', '1h', '1d'].includes(args.interval) ? args.interval : '1h') as '1m' | '5m' | '15m' | '1h' | '1d';
  const hours = Math.min(args.hours || 24, 720); // default 24h, max 30 days

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }

  try {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - hours * 3600000);

    const result = await AnalyticsQueryService.getTimeSeries({
      workspaceId: context.workspaceId,
      projectId,
      startDate,
      endDate,
      interval,
    });

    // Compute totals from ALL non-zero points before truncation
    const nonZeroPoints = result.points.filter((p) => p.totalRuns > 0);
    const totalRuns = nonZeroPoints.reduce((s, p) => s + p.totalRuns, 0);
    const totalPassed = nonZeroPoints.reduce((s, p) => s + p.passedRuns, 0);
    const totalFailed = nonZeroPoints.reduce((s, p) => s + p.failedRuns, 0);

    // Compact for LLM: keep only last 50 non-zero points to save tokens
    const points = nonZeroPoints.length > 50 ? nonZeroPoints.slice(-50) : nonZeroPoints;

    return {
      success: true,
      data: {
        interval,
        hours,
        points,
        summary: { totalRuns, totalPassed, totalFailed, dataPoints: points.length },
      },
      message: `Time series (${interval}, ${hours}h): ${totalRuns} runs — ${totalPassed} passed, ${totalFailed} failed across ${points.length} data points`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetTimeSeries error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get time series: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_full_dashboard — Composite: summary + results overview + recent failures in ONE call
 * Saves agent from making 3-4 separate tool calls for dashboard questions.
 */
export async function handleGetFullDashboard(
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

    const filters = {
      workspaceId: context.workspaceId,
      projectId,
      startDate: sinceDate,
      endDate: new Date(),
    };

    // Run all queries in parallel
    const [summary, resultsOverview, recentFailures, criticalChecks] = await Promise.all([
      AnalyticsQueryService.getSummary(filters),
      AnalyticsQueryService.getResultsOverview(filters),
      AnalyticsQueryService.getRecentFailures(context.workspaceId, projectId, 5),
      AnalyticsQueryService.getCriticalChecks(context.workspaceId, projectId),
    ]);

    return {
      success: true,
      data: {
        summary: summary.summary,
        status: summary.status,
        performance: summary.performance,
        resultsOverview: {
          passed: resultsOverview.passed,
          failed: resultsOverview.failed,
          skipped: resultsOverview.skipped,
          flaky: resultsOverview.flaky,
          total: resultsOverview.total,
          percentages: resultsOverview.percentages,
          ...(resultsOverview.apiTests ? { apiTests: resultsOverview.apiTests } : {}),
        },
        recentFailures: recentFailures.failures.map((f) => ({
          testCaseName: f.testCaseName,
          severity: f.severity,
          errorMessage: f.errorMessage?.substring(0, 200) || null,
          timeAgo: f.timeAgo,
          source: f.source,
        })),
        criticalChecks: criticalChecks.checks.map((c) => ({
          name: c.name,
          status: c.status,
          lastRunAt: c.lastRunAt,
        })),
        periodDays: days,
      },
      message: `Dashboard (${days}d): ${summary.summary.totalRuns} runs, ${summary.summary.passRate}% pass rate, ${summary.status.state} status, ${recentFailures.failures.length} recent failures, ${criticalChecks.checks.length} critical checks`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetFullDashboard error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get dashboard: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_agent_health — Agent pipeline performance metrics from ai_usage_log
 */
export async function handleGetAgentHealth(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const days = Math.min(args.days || 7, 30);

  try {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);

    // Query ai_usage_log for chat operations with pipeline_metrics
    const { data, error } = await supabaseAdmin
      .from('ai_usage_log')
      .select('pipeline_metrics, total_tokens, total_cost_usd, session_duration_ms, created_at')
      .eq('workspace_id', context.workspaceId)
      .eq('operation_type', 'chat')
      .gte('created_at', sinceDate.toISOString())
      .not('pipeline_metrics', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      return { success: false, message: `Database error: ${error.message}`, displayToUser: false };
    }

    const rows = data || [];
    if (rows.length === 0) {
      return {
        success: true,
        data: { message: 'No pipeline metrics found for this period', periodDays: days },
        message: `No agent pipeline data in the last ${days} days`,
        displayToUser: false,
      };
    }

    // Aggregate metrics
    let successCount = 0;
    let fallbackCount = 0;
    let totalMs = 0;
    const pathCounts: Record<string, number> = {};
    const toolCounts: Record<string, number> = {};
    let totalConfidence = 0;
    let confidenceCount = 0;

    for (const row of rows) {
      const m = row.pipeline_metrics as any;
      if (!m) continue;

      if (m.success) successCount++;
      else fallbackCount++;

      totalMs += m.totalMs || 0;

      const path = m.path || 'unknown';
      pathCounts[path] = (pathCounts[path] || 0) + 1;

      if (Array.isArray(m.toolsExecuted)) {
        for (const tool of m.toolsExecuted) {
          toolCounts[tool] = (toolCounts[tool] || 0) + 1;
        }
      }

      if (typeof m.routerConfidence === 'number') {
        totalConfidence += m.routerConfidence;
        confidenceCount++;
      }
    }

    const total = successCount + fallbackCount;
    const successRate = total > 0 ? Math.round((successCount / total) * 100) : 0;
    const avgLatencyMs = total > 0 ? Math.round(totalMs / total) : 0;
    const avgConfidence = confidenceCount > 0 ? Math.round((totalConfidence / confidenceCount) * 100) / 100 : 0;

    // Top 5 most used tools
    const topTools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    return {
      success: true,
      data: {
        periodDays: days,
        totalRequests: total,
        successRate,
        fallbackRate: 100 - successRate,
        avgLatencyMs,
        avgRouterConfidence: avgConfidence,
        pathDistribution: pathCounts,
        topTools,
      },
      message: `Agent health (${days}d): ${total} requests, ${successRate}% success rate, ${avgLatencyMs}ms avg latency, ${avgConfidence} avg router confidence`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetAgentHealth error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get agent health: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WRITE TOOLS (require confirm=true from agent after user approval)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The single shape every write tool's confirm gate returns.
 *
 * `needsConfirmation` is the machine-readable half: a two-phase-confirm caller
 * has to tell "this call was refused pending approval" apart from "this call
 * failed", and the prose below is written FOR THE MODEL — it gets reworded, so
 * matching on it is not a contract. Every gate goes through here so the flag
 * can never be set on some refusals and forgotten on others.
 */
function confirmationRequired(message: string): SkillResult {
  return { success: false, message, displayToUser: false, needsConfirmation: true };
}

/** Allowed IntentStep action types — reject anything else.
 *  Exported so step-validator-agent can reuse instead of hardcoding. */
export const VALID_STEP_TYPES = new Set([
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
  let testCaseId = args.test_case_id as string | undefined;
  const confirm = args.confirm === true;

  // Steps may come from the model OR from the server-held draft.
  //
  // `qa_author_test_iteratively` deliberately does NOT return its steps to the
  // model — they carry compiled locator plans and a credential `resource_id`
  // that must never travel through the LLM — so it caches them and returns only
  // a count. In test-case scope the prompt then tells the model to "save" via
  // this tool "with the new steps", which it cannot do: it has none. Observed
  // consequence: the model called no tool at all and replied "Saved the login
  // flow as a reusable test case" while nothing was written. Falling back to the
  // cache makes "save" mean what the user was told it meant.
  const argSteps = args.steps as IntentStep[] | undefined;
  const cachedDraft = context.chatSessionId
    ? (await import('@/services/testing/ui/preview/draft-steps-cache')).DraftStepsCache.get(
      context.chatSessionId,
    )
    : undefined;
  const cachedUsable =
    !!cachedDraft && cachedDraft.userId === context.userId && cachedDraft.steps.length > 0;
  const usingCachedDraft =
    (!argSteps || !Array.isArray(argSteps) || argSteps.length === 0) && cachedUsable;
  const steps: IntentStep[] | undefined = usingCachedDraft
    ? (cachedDraft!.steps as IntentStep[])
    : argSteps;

  // Resolve test_case_id by name
  if (testCaseId && !isUUID(testCaseId)) {
    const projectId = resolveProjectId(args, context);
    if (projectId) {
      const r = await resolveTestCaseByName(testCaseId, projectId);
      if ('error' in r) return { success: false, message: r.error, displayToUser: true };
      testCaseId = r.id;
    }
  }

  if (!testCaseId) {
    return { success: false, message: 'Missing required field: test_case_id (UUID or name)', displayToUser: false };
  }

  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return {
      success: false,
      message:
        'Missing or empty required field: steps (array of step objects). If you meant to persist steps you just authored on the live preview, there is no cached draft for this chat session — re-author them first.',
      displayToUser: false,
    };
  }

  // Gate: agent must explicitly set confirm=true after user approval
  if (!confirm) {
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
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
        expectedOutcome: incoming.expectedOutcome ?? prev.expectedOutcome,
      };
    });

    // Carry the authored credential binding onto the test case, on the same
    // fail-closed rule the create path uses: attach it ONLY while the steps
    // being written still reference `{{secrets.*}}`. A required binding on
    // steps that use no placeholder would demand a resource nothing reads;
    // placeholders with no binding is the worse half — the saved test resolves
    // them to nothing and 401s. Bindings come from the cache only, never from
    // `args`: the model must not be able to name a `resource_id`.
    const stepsReferenceSecret = mergedSteps.some(
      (s) => containsBoundSecretPlaceholder(s.value) || containsBoundSecretPlaceholder(s.assertionText),
    );
    const bindingsToSave =
      cachedDraft?.resourceBindings?.length && stepsReferenceSecret
        ? cachedDraft.resourceBindings
        : undefined;
    if (cachedDraft?.resourceBindings?.length && !stepsReferenceSecret) {
      logger.warn('[QA_TOOL] Dropping credential binding on update — steps reference no {{secrets.*}}', {
        testCaseId,
        stepCount: mergedSteps.length,
      });
    }

    // Perform the update via IntentTestCaseService (also enforces user_id ownership)
    const updated = await IntentTestCaseService.update({
      id: testCaseId,
      userId: context.userId,
      steps: mergedSteps,
      ...(bindingsToSave ? { resourceBindings: bindingsToSave } : {}),
    });

    logger.info('[QA_TOOL] Test case steps updated', {
      testCaseId,
      userId: context.userId,
      previousStepCount,
      newStepCount: steps.length,
      fromCachedDraft: usingCachedDraft,
      credentialBindingAttached: !!bindingsToSave,
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
  let testCaseId = args.test_case_id as string | undefined;
  const confirm = args.confirm === true;

  // Resolve test_case_id by name
  if (testCaseId && !isUUID(testCaseId)) {
    const projectId = resolveProjectId(args, context);
    if (projectId) {
      const r = await resolveTestCaseByName(testCaseId, projectId);
      if ('error' in r) return { success: false, message: r.error, displayToUser: true };
      testCaseId = r.id;
    }
  }

  if (!testCaseId) {
    return { success: false, message: 'Missing required field: test_case_id (UUID or name)', displayToUser: false };
  }

  // Gate: confirm required
  if (!confirm) {
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
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

  const validRunTypes = ['test_case', 'plan', 'module', 'flow', 'tag', 'priority', 'preview'];
  if (!validRunTypes.includes(runType)) {
    return { success: false, message: `Invalid run_type: ${runType}. Must be one of: ${validRunTypes.join(', ')}`, displayToUser: false };
  }

  if (!confirm) {
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe what will be run to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
  }

  try {
    let targetId = args.target_id as string | undefined;
    const tag = args.tag as string | undefined;
    const priorityFilter = args.priority_filter as string | undefined;
    const projectId = resolveProjectId(args, context);

    // Smart name→ID resolution for target_id based on run_type
    if (targetId && !isUUID(targetId) && projectId) {
      const resolverMap: Record<string, (name: string, scope: string) => Promise<ResolveResult>> = {
        test_case: resolveTestCaseByName,
        plan: resolvePlanByName,
        module: resolveModuleByName,
      };
      const resolver = resolverMap[runType];
      if (resolver) {
        const resolved = await resolver(targetId, projectId);
        if ('error' in resolved) return { success: false, message: resolved.error, displayToUser: true };
        targetId = resolved.id;
      }

      // Flow: resolve by name using module_id scope
      if (runType === 'flow') {
        let moduleId = args.module_id as string | undefined;
        if (moduleId && !isUUID(moduleId)) {
          const mr = await resolveModuleByName(moduleId, projectId);
          if ('id' in mr) moduleId = mr.id;
        }
        if (moduleId) {
          const fr = await resolveFlowByName(targetId!, moduleId);
          if ('error' in fr) return { success: false, message: fr.error, displayToUser: true };
          targetId = fr.id;
        }
      }
    }

    switch (runType) {
      case 'test_case': {
        if (!targetId) {
          return { success: false, message: 'Missing required field: target_id (test case ID or name)', displayToUser: false };
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
          return { success: false, message: 'Missing required field: target_id (plan ID or name)', displayToUser: false };
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
          return { success: false, message: 'Missing required field: target_id (module ID or name)', displayToUser: false };
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
          return { success: false, message: 'Missing required field: target_id (flow ID or name)', displayToUser: false };
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

      case 'preview': {
        if (!targetId) {
          return { success: false, message: 'Missing required field: target_id (intent test case ID)', displayToUser: false };
        }
        if (!context.previewSessionId) {
          return { success: false, message: 'Preview run requires an active editor preview session. This run_type is only available in editor mode.', displayToUser: false };
        }
        const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
        if (PreviewRunService.isRunning(context.previewSessionId)) {
          return { success: false, message: 'A run is already in progress on this preview session. Wait for it to finish or cancel it first.', displayToUser: false };
        }
        // Await the run so the AI agent sees the actual outcome (passed/failed/error)
        // and can respond with a meaningful summary. Frontend keeps getting realtime
        // progress via WebSocket events.
        try {
          const summary = await PreviewRunService.runSavedSteps(
            context.previewSessionId,
            targetId,
            context.userId,
          );
          const durationSec = (summary.duration / 1000).toFixed(1);
          const statusWord = summary.success
            ? 'completed successfully'
            : summary.cancelled
              ? 'cancelled'
              : summary.timedOut
                ? 'timed out'
                : 'failed';
          const failedHint = summary.firstError
            ? ` First failure: ${summary.firstError.substring(0, 200)}`
            : '';
          return {
            success: summary.success,
            data: {
              intentTestCaseId: targetId,
              previewSessionId: context.previewSessionId,
              runType,
              ...summary,
            },
            message: `Test case run ${statusWord} in ${durationSec}s — ${summary.passedSteps}/${summary.totalSteps} steps passed${summary.failedSteps > 0 ? `, ${summary.failedSteps} failed` : ''}${summary.skippedSteps > 0 ? `, ${summary.skippedSteps} skipped` : ''}.${failedHint}`,
            displayToUser: true,
          };
        } catch (previewErr) {
          const errorMessage = previewErr instanceof Error ? previewErr.message : String(previewErr);
          logger.error('[QA_TOOL] Preview run failed before starting', {
            error: errorMessage,
            previewSessionId: context.previewSessionId,
            intentTestCaseId: targetId,
          });
          return {
            success: false,
            message: `Failed to start preview run: ${errorMessage}`,
            displayToUser: true,
          };
        }
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
 * qa_run_draft_steps — Execute draft steps on live preview without DB persistence
 *
 * Safety:
 * - Requires `confirm: true`
 * - Steps validated against VALID_STEP_TYPES
 * - Requires active preview session (editor mode only)
 * - Fire-and-forget: progress streamed via WebSocket (same events as runSavedSteps)
 */
export async function handleRunDraftSteps(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const steps = args.steps as IntentStep[] | undefined;
  const startUrl = args.start_url as string | undefined;
  const suggestedNameRaw = args.suggested_name;
  const suggestedName = typeof suggestedNameRaw === 'string' && suggestedNameRaw.trim()
    ? suggestedNameRaw.trim().slice(0, 120) // hard cap to avoid abuse via giant strings
    : undefined;
  const confirm = args.confirm === true;

  // 2. Validate steps array (needed for both author-only and run paths)
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return { success: false, message: 'Missing or empty required field: steps (array of step objects)', displayToUser: false };
  }

  // 3. Validate start_url
  if (!startUrl) {
    return { success: false, message: 'Missing required field: start_url', displayToUser: false };
  }

  // 5b. Validate step structure up front so the author-only path also rejects
  //     malformed steps (same checks as the run path / handleCreateTestCase).
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

  // 1. Author-only path (confirm=false, the DEFAULT): cache the draft + surface
  //    it to the chat as editable step widgets, do NOT run on the preview. The
  //    user reviews/edits in the card, then confirms in the UI (which drives
  //    web's live-preview run). Mirrors the mobile agent's confirm=false model.
  //    confirm=true still runs immediately below.
  if (!confirm) {
    if (context.chatSessionId) {
      const { DraftStepsCache } = await import('@/services/testing/ui/preview/draft-steps-cache');
      DraftStepsCache.set(context.chatSessionId, {
        steps,
        startUrl,
        userId: context.userId,
        ...(suggestedName ? { suggestedName } : {}),
      });
    }
    // Sanitize credential-like values before they leave the server (invariant
    // #10) — the card renders these and they may re-enter the prompt.
    const { steps: draftSteps } = sanitizeSteps(steps);
    return {
      success: true,
      data: {
        draftSteps,
        draftMeta: {
          startUrl,
          suggestedName,
          executed: false,
          platform: 'web',
        },
      },
      message:
        `Drafted ${steps.length} step(s)${suggestedName ? ` for "${suggestedName}"` : ''}. ` +
        `They are shown in the chat as editable steps — the user can adjust them, ` +
        `then confirm in the UI to run on the live preview.`,
      displayToUser: true,
    };
  }

  // 4. Validate preview session (run path only — author-only returned above)
  if (!context.previewSessionId) {
    return {
      success: false,
      message: 'Draft step execution requires an active editor preview session. This tool is only available in editor mode.',
      displayToUser: false,
    };
  }

  // (step structure already validated in 5b above)

  // 6. Check no run already in progress
  const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
  if (PreviewRunService.isRunning(context.previewSessionId)) {
    return {
      success: false,
      message: 'A run is already in progress on this preview session. Wait for it to finish or cancel it first.',
      displayToUser: false,
    };
  }

  // 6.5 Pre-flight: log if preview page differs from start_url (informational only)
  if (context.previewSessionId) {
    try {
      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      const page = sessionService.getPage(context.previewSessionId, context.userId);
      if (page) {
        const currentUrl = page.url();
        try {
          const currentPath = new URL(currentUrl).pathname;
          const startPath = new URL(startUrl).pathname;
          if (currentPath !== startPath) {
            logger.info('[QA_TOOL] Draft steps: preview page differs from start_url, will navigate', {
              currentUrl: currentUrl.substring(0, 200),
              startUrl: startUrl.substring(0, 200),
              previewSessionId: context.previewSessionId,
            });
          }
        } catch { /* URL parse — non-blocking */ }
      }
    } catch { /* non-blocking */ }
  }

  // 7. Cache draft steps for cross-turn retrieval
  //    Also cache the AI's suggested name so the "Save as test case" quick
  //    action can use it as the default test case title.
  if (context.chatSessionId) {
    const { DraftStepsCache } = await import('@/services/testing/ui/preview/draft-steps-cache');
    DraftStepsCache.set(context.chatSessionId, {
      steps,
      startUrl,
      userId: context.userId,
      ...(suggestedName ? { suggestedName } : {}),
    });
  }

  // 8. Await the run so the AI agent can read the actual outcome (passed/failed/error)
  //    and respond with a meaningful summary instead of "I started a run, watch the browser".
  //    Frontend still gets realtime progress via WebSocket (preview:run:started/step/completed).
  try {
    const summary = await PreviewRunService.runStepsOnPreview(
      context.previewSessionId,
      steps,
      startUrl,
      context.userId,
      { persistAppliedSteps: false, chatSessionId: context.chatSessionId ?? undefined }, // ephemeral — no DB writes
    );

    const durationSec = (summary.duration / 1000).toFixed(1);
    const statusWord = summary.success
      ? 'completed successfully'
      : summary.cancelled
        ? 'cancelled'
        : summary.timedOut
          ? 'timed out'
          : 'failed';
    const failedHint = summary.firstError
      ? ` First failure: ${summary.firstError.substring(0, 200)}`
      : '';

    // Also surface the steps as editable draft widgets so the user can edit +
    // re-run + save from the chat card after a run (parity with mobile).
    // Sanitized before leaving the server (invariant #10).
    const { steps: ranDraftSteps } = sanitizeSteps(steps);

    return {
      success: summary.success,
      data: {
        previewSessionId: context.previewSessionId,
        ephemeral: true,
        startUrl,
        draftSteps: ranDraftSteps,
        draftMeta: { startUrl, suggestedName, executed: true, platform: 'web' },
        ...summary,
      },
      message: `Run ${statusWord} in ${durationSec}s — ${summary.passedSteps}/${summary.totalSteps} steps passed${summary.failedSteps > 0 ? `, ${summary.failedSteps} failed` : ''}${summary.skippedSteps > 0 ? `, ${summary.skippedSteps} skipped` : ''}.${failedHint}`,
      displayToUser: true,
    };
  } catch (err) {
    // Synchronous throw before the run loop starts (e.g., concurrent run, no session page).
    // The async run loop now captures errors internally and returns them in the summary.
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('[QA_TOOL] Draft steps run failed before starting', {
      error: errorMessage,
      previewSessionId: context.previewSessionId,
      stepCount: steps.length,
    });
    return {
      success: false,
      message: `Failed to start draft run: ${errorMessage}`,
      displayToUser: true,
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
/**
 * Is the model's re-emitted step array the SAME test as the cached draft?
 *
 * Compares only what the model is expected to echo faithfully — order, type and
 * the value/assertion payloads. Deliberately ignores compiled plans, evidence
 * and ids: those are exactly what the model drops and the cache exists to
 * restore. Any divergence means the user edited something, so the model's array
 * is the truth.
 */
export function stepsMatchCachedDraft(fromModel: IntentStep[], cached: IntentStep[]): boolean {
  if (fromModel.length !== cached.length) return false;
  const norm = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return cached.every((c, i) => {
    const m = fromModel[i];
    return !!m
      && m.type === c.type
      && norm(m.value) === norm(c.value)
      && norm(m.assertionText) === norm(c.assertionText);
  });
}

export async function handleCreateTestCase(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);
  const name = args.name as string | undefined;
  const confirm = args.confirm === true;

  // ── Test-case scope: "save" must land on the OPEN test case ──
  //
  // The executor prompt already forbids creating here, and the model still did
  // it: a live editor session on test case 7ee865c6 answered "save" with two
  // qa_create_test_case calls under invented names. Had they gone through, the
  // user would have got a duplicate test case while the row they were looking
  // at stayed at steps=0 — a silent wrong-target write.
  //
  // A prompt rule the model can ignore is not an enforcement point, so the
  // server refuses instead. Refuse rather than silently rewrite the call to an
  // update: the model may genuinely have meant a new test, and rewriting would
  // put words in the user's mouth. `new_separate_test` is the explicit opt-out
  // — the model has to restate that the user asked for a SEPARATE test case,
  // which "save" never does.
  if (
    context.storeKind === 'testcase'
    && context.testCaseId
    && args.new_separate_test !== true
  ) {
    logger.info('[QA_TOOLS] Blocked qa_create_test_case in test-case scope', {
      testCaseId: context.testCaseId,
      chatSessionId: context.chatSessionId,
    });
    return {
      success: false,
      message:
        `You are editing test case ${context.testCaseId}. Creating a test case here would leave that one unchanged and add a duplicate. ` +
        `To save/update what the user is looking at, call qa_update_test_case_steps with test_case_id="${context.testCaseId}" ` +
        `(omit "steps" if the steps came from qa_author_test_iteratively — the server persists its own copy). ` +
        `ONLY if the user explicitly asked for a NEW, separate, additional test case, call qa_create_test_case again with new_separate_test=true.`,
      displayToUser: false,
    };
  }

  // Same fallback as the update path: `qa_author_test_iteratively` keeps its
  // steps server-side and hands the model only a count, so on "save" the model
  // has nothing to pass. Requiring it here forced the same failure — invent
  // steps, or claim a save that never happened. An omitted array means "persist
  // what you authored"; the cache is still only read for THIS user's session.
  const argSteps = args.steps as IntentStep[] | undefined;
  const draftForFallback = context.chatSessionId
    ? (await import('@/services/testing/ui/preview/draft-steps-cache')).DraftStepsCache.get(
      context.chatSessionId,
    )
    : undefined;
  const steps: IntentStep[] | undefined =
    (!argSteps || !Array.isArray(argSteps) || argSteps.length === 0)
      && draftForFallback
      && draftForFallback.userId === context.userId
      && draftForFallback.steps.length > 0
      ? (draftForFallback.steps as IntentStep[])
      : argSteps;

  if (!projectId) {
    return { success: false, message: 'Missing required field: project_id', displayToUser: false };
  }
  if (!name) {
    return { success: false, message: 'Missing required field: name', displayToUser: false };
  }
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return {
      success: false,
      message:
        'Missing or empty required field: steps (array of step objects). If you meant to persist steps you just authored on the live preview, there is no cached draft for this chat session — re-author them first.',
      displayToUser: false,
    };
  }

  if (!confirm) {
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the test case you will create to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
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

  // Validate priority enum BEFORE create() — invalid values (LLM
  // hallucinating "urgent" / "p0" / etc.) would otherwise hit the DB
  // CHECK constraint and abort the whole insert. We silently drop the
  // bad value and log a warn; the test still gets created with the
  // service-level default ('medium' — see IntentTestCaseService.create).
  const validPriorities: ReadonlyArray<'critical' | 'high' | 'medium' | 'low'> =
    ['critical', 'high', 'medium', 'low'] as const;
  let priorityToApply: 'critical' | 'high' | 'medium' | 'low' | undefined;
  if (args.priority) {
    if ((validPriorities as ReadonlyArray<string>).includes(args.priority)) {
      priorityToApply = args.priority as 'critical' | 'high' | 'medium' | 'low';
    } else {
      logger.warn('[QA_TOOL] handleCreateTestCase ignoring invalid priority', {
        received: args.priority,
        expected: validPriorities,
      });
    }
  }

  // Sanitize credential-like values to {{param_*}} BEFORE persisting so a
  // password/token typed into a step doesn't land in steps_json in plaintext,
  // and persist the resulting parameters_schema so a regression replay can
  // resolve them (without it the runner types the literal placeholder). Same
  // fix + shared sanitizer as the mobile agent save path.
  // Prefer the SERVER's copy of the draft over the LLM's — but ONLY when the
  // model re-emitted the same steps. The cache uniquely holds the compiled
  // locator plans (the model's copy drops them), so using it makes the saved
  // test replay on the fast path.
  //
  // The equivalence check is not paranoia: the editor prompt tells the model to
  // reuse the cached steps when the user asks to run, save, OR MODIFY them, so
  // a "save it, but drop the last step" turn re-emits a DELIBERATELY DIFFERENT
  // array — and nothing rewrites the cache on that path. Preferring the cache
  // unconditionally would silently discard the user's edit and then report the
  // cached step count back, so the confirmation would look correct.
  //
  // The credential binding still comes from the cache, never from `args`: the
  // model must not be able to name a `resource_id`.
  const cachedDraft = context.chatSessionId
    ? (await import('@/services/testing/ui/preview/draft-steps-cache')).DraftStepsCache.get(context.chatSessionId)
    : undefined;
  const cachedUsable = !!cachedDraft
    && cachedDraft.userId === context.userId
    && cachedDraft.steps.length > 0
    && stepsMatchCachedDraft(steps, cachedDraft.steps as IntentStep[]);
  const stepsToSave = cachedUsable ? (cachedDraft!.steps as IntentStep[]) : steps;
  if (cachedDraft && !cachedUsable) {
    logger.info('[QA_TOOL] Using the model\'s steps — cached draft absent or diverged', {
      chatSessionId: context.chatSessionId,
      cachedCount: cachedDraft.steps.length,
      argCount: steps.length,
    });
  }

  const { steps: sanitizedSteps, parametersSchema } = sanitizeSteps(stepsToSave);

  // Fail closed: only attach the binding if the steps being saved still
  // reference a bound secret. If the model rewrote them and dropped the
  // placeholders, a required binding would demand a resource nothing uses.
  const stepsReferenceSecret = sanitizedSteps.some(
    (s) => containsBoundSecretPlaceholder(s.value) || containsBoundSecretPlaceholder(s.assertionText),
  );
  const bindingsToSave =
    cachedDraft?.resourceBindings?.length && stepsReferenceSecret
      ? cachedDraft.resourceBindings
      : undefined;
  if (cachedDraft?.resourceBindings?.length && !stepsReferenceSecret) {
    logger.warn('[QA_TOOL] Dropping credential binding — saved steps reference no {{secrets.*}}', {
      chatSessionId: context.chatSessionId,
      stepCount: sanitizedSteps.length,
    });
  }

  try {
    const created = await IntentTestCaseService.create({
      projectId,
      userId: context.userId,
      name,
      description: args.description || undefined,
      // Pair the start URL with whichever step source won: saving the server's
      // steps against the model's URL can hand the test a drifted (or absent)
      // origin, and a `navigate` step with no value has nothing to fall back to.
      startUrl: (cachedUsable ? cachedDraft!.startUrl : args.start_url) || args.start_url || undefined,
      steps: sanitizedSteps,
      parametersSchema,
      ...(bindingsToSave ? { resourceBindings: bindingsToSave } : {}),
      status: args.status || 'draft',
      // Pass priority straight to create() — eliminates the previous
      // create→update round-trip and avoids the brief window where the
      // row existed without priority (sort-by-priority queries could
      // observe stale state). If the LLM omitted priority, create()
      // applies its own 'medium' default; if the LLM passed bad enum,
      // we dropped it above and create() also uses 'medium'.
      ...(priorityToApply ? { priority: priorityToApply } : {}),
    });

    // Apply tags via update if provided. Priority is already set in
    // create() above — no second write needed for that channel.
    if (args.tags) {
      await IntentTestCaseService.update({
        id: created.id,
        userId: context.userId,
        tags: args.tags,
      });
    }

    logger.info('[QA_TOOL] Test case created', {
      testCaseId: created.id,
      userId: context.userId,
      stepCount: sanitizedSteps.length,
      stepsFrom: stepsToSave === steps ? 'tool_args' : 'draft_cache',
      resourceBindings: bindingsToSave?.length ?? 0,
    });

    // Clear draft steps cache — steps have been persisted to DB
    if (context.chatSessionId) {
      try {
        const { DraftStepsCache } = await import('@/services/testing/ui/preview/draft-steps-cache');
        DraftStepsCache.delete(context.chatSessionId);
      } catch { /* non-critical */ }
    }

    return {
      success: true,
      data: {
        testCaseId: created.id,
        name: created.name,
        status: created.status,
        stepCount: sanitizedSteps.length,
      },
      message: `Created test case "${created.name}" with ${sanitizedSteps.length} steps`,
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
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
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
        let planId = args.plan_id as string | undefined;
        if (planId && !isUUID(planId)) {
          const projectId = resolveProjectId(args, context);
          if (!projectId) return { success: false, message: 'project_id required when searching plans by name', displayToUser: false };
          const r = await resolvePlanByName(planId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          planId = r.id;
        }
        if (!planId) {
          return { success: false, message: 'Missing required field: plan_id (UUID or name)', displayToUser: false };
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
        let planId = args.plan_id as string | undefined;
        const itemType = args.item_type as string | undefined;
        let itemId = args.item_id as string | undefined;
        const projectId = resolveProjectId(args, context);

        // Resolve plan_id by name
        if (planId && !isUUID(planId)) {
          if (!projectId) return { success: false, message: 'project_id required when searching plans by name', displayToUser: false };
          const r = await resolvePlanByName(planId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          planId = r.id;
        }

        if (!planId) {
          return { success: false, message: 'Missing required field: plan_id (UUID or name)', displayToUser: false };
        }
        if (!itemType || !['module', 'flow', 'test_case'].includes(itemType)) {
          return { success: false, message: 'Missing or invalid item_type. Must be module, flow, or test_case.', displayToUser: false };
        }

        // Resolve item_id by name based on item_type
        if (itemId && !isUUID(itemId) && projectId) {
          const itemResolvers: Record<string, (name: string, scope: string) => Promise<ResolveResult>> = {
            module: resolveModuleByName,
            test_case: resolveTestCaseByName,
            flow: resolveFlowByNameInProject,
          };
          const resolver = itemResolvers[itemType];
          if (resolver) {
            const r = await resolver(itemId, projectId);
            if ('error' in r) return { success: false, message: r.error, displayToUser: true };
            itemId = r.id;
          }
        }

        if (!itemId) {
          return { success: false, message: 'Missing required field: item_id (UUID or name)', displayToUser: false };
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
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
  }

  try {
    switch (action) {
      case 'create': {
        const projectId = resolveProjectId(args, context);
        const name = args.name as string | undefined;
        const cronExpression = args.cron_expression as string | undefined;
        const runAt = args.run_at as string | undefined;

        if (!projectId) {
          return { success: false, message: 'Missing required field: project_id', displayToUser: false };
        }
        if (!name) {
          return { success: false, message: 'Missing required field: name', displayToUser: false };
        }
        // Timing: exactly one of cron_expression (recurring) or run_at (one-time).
        if (!!cronExpression === !!runAt) {
          return { success: false, message: 'Provide exactly one of cron_expression (recurring) or run_at (one-time)', displayToUser: false };
        }

        // Resolve plan_id/module_id by name if needed
        let resolvedPlanId = args.plan_id as string | undefined;
        let resolvedModuleId = args.module_id as string | undefined;

        if (resolvedPlanId && !isUUID(resolvedPlanId)) {
          const r = await resolvePlanByName(resolvedPlanId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          resolvedPlanId = r.id;
        }
        if (resolvedModuleId && !isUUID(resolvedModuleId)) {
          const r = await resolveModuleByName(resolvedModuleId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          resolvedModuleId = r.id;
        }

        // Validate exactly one of plan_id/module_id
        const hasPlanId = !!resolvedPlanId;
        const hasModuleId = !!resolvedModuleId;
        if (!hasPlanId && !hasModuleId) {
          return { success: false, message: 'Must provide exactly one of plan_id or module_id (name or UUID)', displayToUser: false };
        }
        if (hasPlanId && hasModuleId) {
          return { success: false, message: 'Must provide exactly one of plan_id or module_id, not both', displayToUser: false };
        }

        const schedule = await ScheduleService.create({
          projectId,
          userId: context.userId,
          name,
          cronExpression: cronExpression || undefined,
          runAt: runAt || undefined,
          timezone: args.timezone || undefined,
          planId: resolvedPlanId || undefined,
          moduleId: resolvedModuleId || undefined,
        });

        logger.info('[QA_TOOL] Schedule created', { scheduleId: schedule.id, userId: context.userId });

        const when = schedule.scheduleType === 'one_time'
          ? `once at ${schedule.runAt ? ScheduleService.formatRunAtForHuman(schedule.runAt, schedule.timezone) : 'the scheduled time'}`
          : schedule.cronExpression;

        return {
          success: true,
          data: {
            scheduleId: schedule.id,
            name: schedule.name,
            scheduleType: schedule.scheduleType,
            cronExpression: schedule.cronExpression,
            runAt: schedule.runAt,
            isActive: schedule.isActive,
            nextRunAt: schedule.nextRunAt,
          },
          message: `Created schedule "${schedule.name}" (${when})`,
          displayToUser: true,
        };
      }

      case 'update': {
        let scheduleId = args.schedule_id as string | undefined;
        if (scheduleId && !isUUID(scheduleId)) {
          const projectId = resolveProjectId(args, context);
          if (!projectId) return { success: false, message: 'project_id required when searching schedules by name', displayToUser: false };
          const r = await resolveScheduleByName(scheduleId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          scheduleId = r.id;
        }
        if (!scheduleId) {
          return { success: false, message: 'Missing required field: schedule_id (UUID or name)', displayToUser: false };
        }

        const schedule = await ScheduleService.update({
          id: scheduleId,
          userId: context.userId,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.cron_expression !== undefined ? { cronExpression: args.cron_expression } : {}),
          ...(args.run_at !== undefined ? { runAt: args.run_at } : {}),
          ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
          ...(args.is_active !== undefined ? { isActive: args.is_active } : {}),
        });

        logger.info('[QA_TOOL] Schedule updated', { scheduleId: schedule.id, userId: context.userId });

        return {
          success: true,
          data: {
            scheduleId: schedule.id,
            name: schedule.name,
            scheduleType: schedule.scheduleType,
            cronExpression: schedule.cronExpression,
            runAt: schedule.runAt,
            isActive: schedule.isActive,
            nextRunAt: schedule.nextRunAt,
          },
          message: `Updated schedule "${schedule.name}"`,
          displayToUser: true,
        };
      }

      case 'activate': {
        let scheduleId = args.schedule_id as string | undefined;
        if (scheduleId && !isUUID(scheduleId)) {
          const projectId = resolveProjectId(args, context);
          if (!projectId) return { success: false, message: 'project_id required when searching schedules by name', displayToUser: false };
          const r = await resolveScheduleByName(scheduleId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          scheduleId = r.id;
        }
        if (!scheduleId) {
          return { success: false, message: 'Missing required field: schedule_id (UUID or name)', displayToUser: false };
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
        let scheduleId = args.schedule_id as string | undefined;
        if (scheduleId && !isUUID(scheduleId)) {
          const projectId = resolveProjectId(args, context);
          if (!projectId) return { success: false, message: 'project_id required when searching schedules by name', displayToUser: false };
          const r = await resolveScheduleByName(scheduleId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          scheduleId = r.id;
        }
        if (!scheduleId) {
          return { success: false, message: 'Missing required field: schedule_id (UUID or name)', displayToUser: false };
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
        let scheduleId = args.schedule_id as string | undefined;
        if (scheduleId && !isUUID(scheduleId)) {
          const projectId = resolveProjectId(args, context);
          if (!projectId) return { success: false, message: 'project_id required when searching schedules by name', displayToUser: false };
          const r = await resolveScheduleByName(scheduleId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          scheduleId = r.id;
        }
        if (!scheduleId) {
          return { success: false, message: 'Missing required field: schedule_id (UUID or name)', displayToUser: false };
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
  let testCaseId = args.test_case_id as string | undefined;
  const confirm = args.confirm === true;

  // Resolve test_case_id by name
  if (testCaseId && !isUUID(testCaseId)) {
    const projectId = resolveProjectId(args, context);
    if (projectId) {
      const r = await resolveTestCaseByName(testCaseId, projectId);
      if ('error' in r) return { success: false, message: r.error, displayToUser: true };
      testCaseId = r.id;
    }
  }

  if (!testCaseId) {
    return { success: false, message: 'Missing required field: test_case_id (UUID or name)', displayToUser: false };
  }

  if (!confirm) {
    return confirmationRequired(
      'DESTRUCTIVE operation: permanently deletes test case. Cannot be undone. You MUST first warn the user about permanent deletion, wait for their explicit approval ("yes", "delete it", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
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
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
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
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
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
        if (!platformKey || !['web_ui', 'api', 'mobile'].includes(platformKey)) {
          return { success: false, message: 'Missing or invalid platform_key. Must be web_ui, api, or mobile.', displayToUser: false };
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
        let moduleId = args.module_id as string | undefined;
        if (moduleId && !isUUID(moduleId)) {
          const projectId = resolveProjectId(args, context);
          if (!projectId) return { success: false, message: 'project_id required when searching modules by name', displayToUser: false };
          const r = await resolveModuleByName(moduleId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          moduleId = r.id;
        }
        if (!moduleId) {
          return { success: false, message: 'Missing required field: module_id (UUID or name)', displayToUser: false };
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
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
  }

  try {
    switch (action) {
      case 'create': {
        let moduleId = args.module_id as string | undefined;
        const name = args.name as string | undefined;

        // Resolve module_id by name
        if (moduleId && !isUUID(moduleId)) {
          const projectId = resolveProjectId(args, context);
          if (!projectId) return { success: false, message: 'project_id required when searching modules by name', displayToUser: false };
          const r = await resolveModuleByName(moduleId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          moduleId = r.id;
        }

        if (!moduleId) {
          return { success: false, message: 'Missing required field: module_id (UUID or name)', displayToUser: false };
        }
        if (!name) {
          return { success: false, message: 'Missing required field: name', displayToUser: false };
        }

        const flow = await FlowService.create({
          moduleId,
          userId: context.userId,
          name,
          flowType: args.flow_type || undefined,
          // Flows created via QA tools are web UI by default; platform is derived from module tree.
          platform: undefined,
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
        let flowId = args.flow_id as string | undefined;
        // Flow resolution needs module_id scope
        if (flowId && !isUUID(flowId)) {
          let moduleId = args.module_id as string | undefined;
          if (moduleId && !isUUID(moduleId)) {
            const projectId = resolveProjectId(args, context);
            if (projectId) {
              const mr = await resolveModuleByName(moduleId, projectId);
              if ('id' in mr) moduleId = mr.id;
            }
          }
          if (moduleId) {
            const r = await resolveFlowByName(flowId, moduleId);
            if ('error' in r) return { success: false, message: r.error, displayToUser: true };
            flowId = r.id;
          }
        }
        if (!flowId) {
          return { success: false, message: 'Missing required field: flow_id (UUID or name; provide module_id for name lookup)', displayToUser: false };
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
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the exact changes to the user, wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.',
    );
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

/**
 * qa_screenshot — Capture a screenshot of the live preview page.
 * Returns base64 JPEG for multimodal AI analysis.
 */
export async function handleScreenshot(
  _args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const previewSessionId = context.previewSessionId;
  if (!previewSessionId) {
    return {
      success: false,
      message: 'No active preview session. Open a page in the AI Editor first.',
      displayToUser: true,
    };
  }

  try {
    const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
    const service = getPreviewSessionService();

    const snapshot = await service.getSnapshot(previewSessionId, context.userId, {
      includeScreenshot: true,
      force: true,
    });

    if (!snapshot) {
      return {
        success: false,
        message: 'Preview session not found or not accessible.',
        displayToUser: true,
      };
    }

    if (!snapshot.screenshot) {
      return {
        success: false,
        message: 'Failed to capture screenshot from the preview session.',
        displayToUser: true,
      };
    }

    return {
      success: true,
      data: {
        screenshot: snapshot.screenshot,
        mimeType: 'image/jpeg',
        url: snapshot.url,
      },
      message: `Screenshot captured of ${snapshot.url}`,
      displayToUser: false,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleScreenshot error', {
      error: error instanceof Error ? error.message : String(error),
      previewSessionId,
    });
    return {
      success: false,
      message: `Failed to capture screenshot: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_share_result — Generate a public share link for a regression run
 */
export async function handleShareResult(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  let runId = args.run_id as string | undefined;

  // Resolve run_id: accept UUID or plan name (finds latest run for that plan)
  if (runId && !isUUID(runId)) {
    const projectId = resolveProjectId(args, context);
    const resolved = await resolveRunId(runId, undefined, projectId, context.userId);
    if (resolved.error) return { success: false, message: resolved.error, displayToUser: true };
    runId = resolved.id;
  }

  if (!runId) {
    return { success: false, message: 'Missing required field: run_id (UUID or plan name)', displayToUser: false };
  }

  try {
    // Verify run exists and belongs to user's project
    const projectId = resolveProjectId(args, context);

    let query = supabaseAdmin
      .from('regression_runs')
      .select('id, share_token, project_id, status')
      .eq('id', runId);

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data: run, error: runError } = await query.single();

    if (runError || !run) {
      return {
        success: false,
        message: runError?.code === 'PGRST116' ? `Run not found: ${runId}` : `Database error: ${runError?.message}`,
        displayToUser: false,
      };
    }

    // Reuse existing token or generate new one (idempotent)
    let shareToken = run.share_token;

    if (!shareToken) {
      shareToken = crypto.randomBytes(16).toString('hex');

      const { error: updateError } = await supabaseAdmin
        .from('regression_runs')
        .update({ share_token: shareToken })
        .eq('id', runId)
        .is('share_token', null); // Race-safe: only set if still null

      if (updateError) {
        logger.error('[QA_TOOL] Failed to set share token', { error: updateError, runId });
        return {
          success: false,
          message: 'Failed to generate share link. Please try again.',
          displayToUser: true,
        };
      }

      // Re-fetch in case concurrent request set a different token
      const { data: refreshed } = await supabaseAdmin
        .from('regression_runs')
        .select('share_token')
        .eq('id', runId)
        .single();

      if (refreshed?.share_token) {
        shareToken = refreshed.share_token;
      }
    }

    const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
    const shareUrl = `${frontendUrl}/shared/report/${shareToken}`;

    return {
      success: true,
      data: { shareToken, shareUrl, runId, status: run.status },
      message: `Share link for run ${runId}: ${shareUrl}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleShareResult error', {
      error: error instanceof Error ? error.message : String(error),
      runId,
    });
    return {
      success: false,
      message: `Failed to generate share link: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_last_runs — Get recent regression runs
 */
export async function handleGetLastRuns(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const projectId = resolveProjectId(args, context);

  if (!projectId) {
    return { success: false, message: 'Missing project_id', displayToUser: false };
  }

  let planId = args.plan_id;
  const search = args.search as string | undefined;
  const limit = Math.min(Math.max(args.limit || 5, 1), 20);

  try {
    // If search is provided, resolve plan name → plan IDs first
    let searchPlanIds: string[] | undefined;

    if (search && !planId) {
      const { data: matchingPlans } = await supabaseAdmin
        .from('regression_plans')
        .select('id')
        .eq('project_id', projectId)
        .ilike('name', `%${search}%`);

      if (!matchingPlans || matchingPlans.length === 0) {
        return {
          success: true,
          data: { runs: [], total: 0 },
          message: `No regression plans matching "${search}" found`,
          displayToUser: true,
        };
      }

      if (matchingPlans.length === 1) {
        planId = matchingPlans[0].id;
      } else {
        searchPlanIds = matchingPlans.map(p => p.id);
      }
    }

    let query = supabaseAdmin
      .from('regression_runs')
      .select('id, plan_id, trigger, status, summary, started_at, completed_at')
      .eq('project_id', projectId)
      .order('started_at', { ascending: false })
      .limit(limit);

    if (planId) {
      query = query.eq('plan_id', planId);
    } else if (searchPlanIds) {
      query = query.in('plan_id', searchPlanIds);
    }

    const { data: runs, error } = await query;

    if (error) {
      return { success: false, message: `Database error: ${error.message}`, displayToUser: false };
    }

    if (!runs || runs.length === 0) {
      return {
        success: true,
        data: { runs: [], total: 0 },
        message: planId
          ? 'No regression runs found for this plan'
          : 'No regression runs found for this project',
        displayToUser: true,
      };
    }

    // Enrich with plan names
    const planIds = [...new Set(runs.filter(r => r.plan_id).map(r => r.plan_id))];
    let planNames: Record<string, string> = {};

    if (planIds.length > 0) {
      const { data: plans } = await supabaseAdmin
        .from('regression_plans')
        .select('id, name')
        .in('id', planIds);

      if (plans) {
        planNames = Object.fromEntries(plans.map(p => [p.id, p.name]));
      }
    }

    const formattedRuns = runs.map(r => ({
      id: r.id,
      planName: r.plan_id ? planNames[r.plan_id] || 'Unknown plan' : 'Ad-hoc run',
      trigger: r.trigger,
      status: r.status,
      summary: r.summary,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));

    return {
      success: true,
      data: { runs: formattedRuns, total: formattedRuns.length },
      message: `Found ${formattedRuns.length} recent regression run(s)`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetLastRuns error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Failed to get last runs: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_get_run_status — Check execution status of a regression run
 */
export async function handleGetRunStatus(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  let runId = args.run_id as string | undefined;

  // Resolve run_id: accept UUID or plan name (finds latest run for that plan)
  if (runId && !isUUID(runId)) {
    const projectId = resolveProjectId(args, context);
    const resolved = await resolveRunId(runId, undefined, projectId, context.userId);
    if (resolved.error) return { success: false, message: resolved.error, displayToUser: true };
    runId = resolved.id;
  }

  if (!runId) {
    return { success: false, message: 'Missing required field: run_id (UUID or plan name)', displayToUser: false };
  }

  try {
    // Get run
    const { data: run, error: runError } = await supabaseAdmin
      .from('regression_runs')
      .select('id, status, trigger, plan_id, summary, started_at, completed_at, user_id')
      .eq('id', runId)
      .single();

    if (runError || !run) {
      return {
        success: false,
        message: runError?.code === 'PGRST116' ? `Run not found: ${runId}` : `Database error: ${runError?.message}`,
        displayToUser: false,
      };
    }

    // Security: verify user owns this run
    if (run.user_id !== context.userId) {
      return { success: false, message: 'Access denied', displayToUser: false };
    }

    // Count executions by status
    const { data: executions } = await supabaseAdmin
      .from('test_executions')
      .select('status')
      .eq('run_id', runId);

    const progress = {
      total: executions?.length || 0,
      passed: 0,
      failed: 0,
      running: 0,
      pending: 0,
      cancelled: 0,
      skipped: 0,
    };

    for (const exec of executions || []) {
      const s = exec.status as keyof typeof progress;
      if (s in progress && s !== 'total') {
        progress[s]++;
      }
    }

    // Get plan name
    let planName: string | undefined;
    if (run.plan_id) {
      const { data: plan } = await supabaseAdmin
        .from('regression_plans')
        .select('name')
        .eq('id', run.plan_id)
        .maybeSingle();
      planName = plan?.name;
    }

    // [CHAIN] trace: the agent checked this run's status. Keyed by runId so
    // `rg "<runId>"` reconstructs the full run→status→notify chain across
    // processes/turns. [REGRESSION_RUN] already logs the start with runId.
    logger.info('[CHAIN] status_checked', {
      runId: run.id,
      status: run.status,
      passed: progress.passed,
      failed: progress.failed,
      total: progress.total,
      userId: context.userId,
    });

    return {
      success: true,
      data: {
        runId: run.id,
        status: run.status,
        trigger: run.trigger,
        planName,
        progress,
        summary: run.summary,
        startedAt: run.started_at,
        completedAt: run.completed_at,
      },
      message: run.status === 'running'
        ? `Run is in progress: ${progress.passed + progress.failed}/${progress.total} completed (${progress.passed} passed, ${progress.failed} failed)`
        : `Run ${run.status}: ${progress.passed} passed, ${progress.failed} failed out of ${progress.total}`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleGetRunStatus error', {
      error: error instanceof Error ? error.message : String(error),
      runId,
    });
    return {
      success: false,
      message: `Failed to get run status: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_cancel_run — Cancel a running or pending regression run
 */
export async function handleCancelRun(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  let runId = args.run_id as string | undefined;
  const confirm = args.confirm === true;

  // Resolve run_id: accept UUID or plan name (finds latest run for that plan)
  if (runId && !isUUID(runId)) {
    const projectId = resolveProjectId(args, context);
    const resolved = await resolveRunId(runId, undefined, projectId, context.userId);
    if (resolved.error) return { success: false, message: resolved.error, displayToUser: true };
    runId = resolved.id;
  }

  if (!runId) {
    return { success: false, message: 'Missing required field: run_id (UUID or plan name)', displayToUser: false };
  }

  if (!confirm) {
    return confirmationRequired(
      'WRITE operation requires confirmation. Describe the cancellation to the user, wait for approval, then call with confirm=true.',
    );
  }

  try {
    // Verify run exists and belongs to user
    const { data: run, error: runError } = await supabaseAdmin
      .from('regression_runs')
      .select('id, user_id, status, test_ids')
      .eq('id', runId)
      .single();

    if (runError || !run) {
      return {
        success: false,
        message: runError?.code === 'PGRST116' ? `Run not found: ${runId}` : `Database error: ${runError?.message}`,
        displayToUser: false,
      };
    }

    if (run.user_id !== context.userId) {
      return { success: false, message: 'Access denied', displayToUser: false };
    }

    if (run.status !== 'running' && run.status !== 'pending') {
      return {
        success: false,
        message: `Cannot cancel run with status "${run.status}". Only running or pending runs can be cancelled.`,
        displayToUser: true,
      };
    }

    // Cancel all underlying tests
    const testIds: string[] = run.test_ids || [];
    let cancelledTests = 0;

    for (const testId of testIds) {
      try {
        const result = await ManualTestService.cancelTest(testId, context.userId);
        if (result.success) cancelledTests++;
      } catch {
        // Some tests may already be completed — skip
      }
    }

    // Cancel pending/running test_executions
    await supabaseAdmin
      .from('test_executions')
      .update({
        status: 'cancelled',
        completed_at: new Date().toISOString(),
        error_message: 'Cancelled by user via chat',
      })
      .eq('run_id', runId)
      .in('status', ['pending', 'running']);

    // Mark run as cancelled
    await supabaseAdmin
      .from('regression_runs')
      .update({
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId)
      .in('status', ['running', 'pending']);

    logger.info('[QA_TOOL] Run cancelled via chat', { runId, cancelledTests, totalTestIds: testIds.length });

    return {
      success: true,
      data: { runId, cancelledTests, totalTests: testIds.length },
      message: `Run ${runId} cancelled. ${cancelledTests} test(s) were stopped.`,
      displayToUser: true,
    };
  } catch (error) {
    logger.error('[QA_TOOL] handleCancelRun error', {
      error: error instanceof Error ? error.message : String(error),
      runId,
    });
    return {
      success: false,
      message: `Failed to cancel run: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_manage_automation_action — CRUD for automation actions
 */
export async function handleManageAutomationAction(
  args: Record<string, any>,
  context: SkillContext
): Promise<SkillResult> {
  const action = args.action as string;
  const confirm = args.confirm === true;

  if (!action) {
    return { success: false, message: 'Missing required field: action', displayToUser: false };
  }

  // list does not require confirmation
  if (action !== 'list' && !confirm) {
    return confirmationRequired(
      'WRITE operation requires confirmation. Describe the exact changes to the user, wait for approval, then call with confirm=true.',
    );
  }

  try {
    switch (action) {
      case 'create': {
        if (!args.trigger_event || !args.action_type || !args.config) {
          return {
            success: false,
            message: 'Missing required fields for create: trigger_event, action_type, config',
            displayToUser: false,
          };
        }

        const projectId = resolveProjectId(args, context);

        // Resolve plan_id/schedule_id by name
        let resolvedPlanId = args.plan_id as string | undefined;
        let resolvedScheduleId = args.schedule_id as string | undefined;

        if (resolvedPlanId && !isUUID(resolvedPlanId) && projectId) {
          const r = await resolvePlanByName(resolvedPlanId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          resolvedPlanId = r.id;
        }
        if (resolvedScheduleId && !isUUID(resolvedScheduleId) && projectId) {
          const r = await resolveScheduleByName(resolvedScheduleId, projectId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          resolvedScheduleId = r.id;
        }

        const result = await AutomationActionService.create({
          userId: context.userId,
          projectId,
          scheduleId: resolvedScheduleId,
          planId: resolvedPlanId,
          triggerEvent: args.trigger_event,
          actionType: args.action_type,
          condition: args.condition || 'always',
          config: args.config,
          name: args.name,
        });

        return {
          success: true,
          data: {
            actionId: result.id,
            name: result.name,
            triggerEvent: result.triggerEvent,
            actionType: result.actionType,
            condition: result.condition,
            isActive: result.isActive,
          },
          message: `Created automation: "${result.name || result.actionType}" — fires on ${result.triggerEvent}`,
          displayToUser: true,
        };
      }

      case 'update': {
        let actionId = args.action_id as string | undefined;
        if (actionId && !isUUID(actionId)) {
          const r = await resolveAutomationActionByName(actionId, context.userId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          actionId = r.id;
        }
        if (!actionId) {
          return { success: false, message: 'Missing required field: action_id (UUID or name)', displayToUser: false };
        }

        const result = await AutomationActionService.update({
          id: actionId,
          userId: context.userId,
          triggerEvent: args.trigger_event,
          actionType: args.action_type,
          condition: args.condition,
          config: args.config,
          name: args.name,
          isActive: args.is_active,
        });

        return {
          success: true,
          data: { actionId: result.id, name: result.name, isActive: result.isActive },
          message: `Updated automation "${result.name || result.id}"`,
          displayToUser: true,
        };
      }

      case 'delete': {
        let actionId = args.action_id as string | undefined;
        if (actionId && !isUUID(actionId)) {
          const r = await resolveAutomationActionByName(actionId, context.userId);
          if ('error' in r) return { success: false, message: r.error, displayToUser: true };
          actionId = r.id;
        }
        if (!actionId) {
          return { success: false, message: 'Missing required field: action_id (UUID or name)', displayToUser: false };
        }

        await AutomationActionService.delete(actionId, context.userId);

        return {
          success: true,
          data: { actionId },
          message: `Deleted automation ${actionId}`,
          displayToUser: true,
        };
      }

      case 'list': {
        const projectId = resolveProjectId(args, context);
        const actions = projectId
          ? await AutomationActionService.listByProject(projectId, context.userId)
          : await AutomationActionService.listByUser(context.userId);

        return {
          success: true,
          data: {
            actions: actions.map(a => ({
              id: a.id,
              name: a.name,
              triggerEvent: a.triggerEvent,
              actionType: a.actionType,
              condition: a.condition,
              isActive: a.isActive,
              priority: a.priority,
            })),
            total: actions.length,
          },
          message: actions.length > 0
            ? `Found ${actions.length} automation action(s)`
            : 'No automation actions configured yet',
          displayToUser: true,
        };
      }

      default:
        return { success: false, message: `Unknown action: ${action}`, displayToUser: false };
    }
  } catch (error) {
    logger.error('[QA_TOOL] handleManageAutomationAction error', {
      error: error instanceof Error ? error.message : String(error),
      action,
    });
    return {
      success: false,
      message: `Failed to ${action} automation action: ${error instanceof Error ? error.message : String(error)}`,
      displayToUser: false,
    };
  }
}

/**
 * qa_author_test_iteratively — build a test case by GENERATING-AND-EXECUTING
 * each step on the live preview, grounded in the real DOM at every step.
 *
 * Unlike qa_run_draft_steps (LLM guesses the whole array up front, then runs it
 * blind), this drives the agentic Planner→Executor→Reviewer loop against the
 * live page: snapshot → pick a real element by ref → execute → re-snapshot →
 * next step, until the goal is met. The returned steps have ALREADY passed, so
 * the user's later "save" persists them via qa_create_test_case with NO re-run.
 *
 * Safety / contract:
 * - WRITE op: requires confirm=true (goes through the system confirm-gate, so
 *   the LLM must describe the goal and get the user's "yes" first).
 * - Requires an active editor preview session (editor mode only).
 * - Holds the same run lock as Run-All (recording/apply/Run-All reject while
 *   authoring is in flight). Cancellable via preview run-cancel.
 * - Caches the grounded steps in DraftStepsCache so the "Save as test case"
 *   quick action / qa_create_test_case can persist them.
 */
export async function handleAuthorTestIteratively(
  args: Record<string, any>,
  context: SkillContext,
): Promise<SkillResult> {
  const goalRaw = args.goal;
  const goal = typeof goalRaw === 'string' ? goalRaw.trim() : '';
  const suggestedNameRaw = args.suggested_name;
  const suggestedName = typeof suggestedNameRaw === 'string' && suggestedNameRaw.trim()
    ? suggestedNameRaw.trim().slice(0, 120)
    : undefined;
  const confirm = args.confirm === true;

  // 1. Validate goal.
  if (!goal) {
    return { success: false, message: 'Missing required field: goal (what the test should accomplish, in plain language)', displayToUser: false };
  }

  // 2. Validate preview session.
  if (!context.previewSessionId) {
    return {
      success: false,
      message: 'Iterative authoring requires an active editor preview session. This tool is only available in editor mode.',
      displayToUser: false,
    };
  }

  // 3. Resolve the saved login the user named, if any. Without credentials the
  //     agent cannot complete a login flow live (it would fabricate or fail),
  //     and without the key map there is nothing to freeze — so a login test
  //     authored blind replays empty and 401s.
  //
  //     The model passes a NAME the user spoke; the resource id is resolved
  //     here, scoped to the session's project (server-derived) and this user.
  let credentialBinding: Awaited<ReturnType<typeof resolveNamedCredentialSecret>> | undefined;
  const secretNameRaw = args.credential_secret_name;
  const secretName = typeof secretNameRaw === 'string' ? secretNameRaw.trim() : '';
  if (secretName && !CredentialAuthoringFeature.isEnabled()) {
    // The schema stops advertising the parameter when the flag is off, so this
    // only fires on a stale prompt or a replayed call. Refuse rather than
    // silently authoring without the credential: that would produce exactly the
    // unreproducible login test this feature exists to prevent.
    logger.warn('[QA_TOOL] credential_secret_name ignored — credential authoring is disabled');
    return {
      success: false,
      message: 'Authoring a test against a saved login is not enabled on this deployment. Ask the user for the steps, or draft the login with {{secrets.*}} placeholder values and tell them the test cannot run until credentials are configured.',
      displayToUser: false,
    };
  }
  if (secretName) {
    const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
    const projectId = getPreviewSessionService().getSession(context.previewSessionId)?.projectId;
    if (!projectId) {
      return { success: false, message: 'Preview session is missing project context.', displayToUser: false };
    }

    const { resolveNamedCredentialSecret: resolve, describeCredentialSecretFailure } =
      await import('@/services/testing/ui/preview/named-credential-secret');
    credentialBinding = await resolve({ userId: context.userId, projectId, name: secretName });

    if (!credentialBinding.ok) {
      // Fail closed and tell the agent to ask — never author a login with a
      // credential we could not resolve.
      return {
        success: false,
        message: describeCredentialSecretFailure(credentialBinding, secretName),
        displayToUser: false,
      };
    }
  }

  // 4. Confirm gate (mirrors the other WRITE tools) — deliberately AFTER
  //    credential resolution. That resolution is a read: it creates nothing and
  //    changes no test state. It is not side-effect FREE — `loadDecrypted`
  //    fire-and-forget bumps the resource's `last_used_at`, so a preview turn
  //    that the user never approves still marks the login as used. That is a
  //    cosmetic skew in a telemetry column, and the alternative (a second
  //    resolve pass just to avoid it) buys nothing.
  //
  //    Ordering matters: with the gate first, a call naming a login that does
  //    not exist returned "describe it and get approval" and the model, having
  //    received no verdict on the name, announced the login as usable and asked
  //    the user to approve it — a credential confirmed into existence. Resolving
  //    first means an unknown name fails closed on the FIRST call, with the list
  //    of names that do exist, and the approval question the model then asks
  //    names a login the server has actually resolved.
  if (!confirm) {
    // The resource name is user-supplied text being placed into a model-facing
    // message, so cap it — a secret named with a paragraph of instructions
    // should not get to steer the next turn.
    const credentialNote = credentialBinding?.ok
      ? ` This test will use the saved login "${credentialBinding.resourceName.slice(0, 80)}" — its stored values are injected for the live run and frozen as {{secrets.*}} in the saved steps, so you never type or see them.`
      : '';
    return confirmationRequired(
      'WRITE operation requires confirmation. You MUST first describe the test you will build to the user (the goal + that you will execute steps live on the preview), wait for their explicit approval ("yes", "go ahead", etc.), and then call this tool again with confirm=true. Do NOT set confirm=true without user approval.' +
        credentialNote +
        ' State ONLY what this message confirms — do not tell the user a saved login is usable unless the sentence above says it resolved.',
    );
  }

  // 5. Drive build-by-executing on the live preview.
  const { EditorIterativeAuthorService } = await import('@/services/testing/ui/preview/editor-iterative-author.service');
  const result = await EditorIterativeAuthorService.authorTest({
    previewSessionId: context.previewSessionId,
    userId: context.userId,
    goal,
    ...(credentialBinding?.ok
      ? {
        credentials: credentialBinding.credentials,
        credentialSecret: credentialBinding.credentialSecret,
        credentialValueToKey: credentialBinding.valueToKey,
      }
      : {}),
  });

  if (result.error) {
    return { success: false, message: result.error, displayToUser: true };
  }

  // 6. Convert grounded DiscoveredStep[] → IntentStep[] (carries compiled plans
  //    + masks secrets) and cache for the later save / quick action.
  const { toIntentSteps } = await import('@/agent/core/lite/exploration/types');
  const intentSteps = toIntentSteps(result.steps);

  if (context.chatSessionId && intentSteps.length > 0) {
    const { DraftStepsCache } = await import('@/services/testing/ui/preview/draft-steps-cache');
    DraftStepsCache.set(context.chatSessionId, {
      steps: intentSteps,
      startUrl: result.startUrl,
      userId: context.userId,
      ...(suggestedName ? { suggestedName } : {}),
      // The binding rides server-side with the draft; every save route reads it
      // from here. Present only when a credential was ACTUALLY frozen.
      ...(result.resourceBindings?.length ? { resourceBindings: result.resourceBindings } : {}),
    });
  }

  // 6.5 Per-AI-work credit charge. Iterative authoring drives the
  //     Planner→Executor→Reviewer loop once PER ROUND (each round = several LLM
  //     calls), so the flat 1-credit chat turn under-charges. We charge the
  //     EXTRA AI rounds here; the base 1 is taken by the surrounding chat turn.
  //
  //     Contract (kept self-consistent so we never over/under-charge):
  //       • The chat turn deducts its base 1 credit only when the tool returns
  //         success=true (shouldDeductCredits is derived from tool success).
  //       • So we ALSO gate this extra charge on result.success — on the same
  //         signal — meaning total = roundsExecuted credits on success, and
  //         0 here on failure (the turn likewise charges nothing). No reliance
  //         on cross-file state beyond that shared success signal.
  //     `computeAuthoringExtraCredits` is exported + unit-tested so the math is
  //     pinned (never NaN, never negative, never an unbounded charge).
  const extraCredits = computeAuthoringExtraCredits(result.success, result.roundsExecuted);
  if (extraCredits > 0) {
    try {
      const { CreditCostTrackerService } = await import('@/services/core/credit-cost-tracker.service');
      await CreditCostTrackerService.deductCreditsForTest({
        userId: context.userId,
        testType: 'chat',
        credits: extraCredits,
        costUSD: 0,
        testId: context.previewSessionId,
        description: `Iterative test authoring — ${result.roundsExecuted} AI rounds`,
      });
    } catch (err) {
      logger.warn('[QA_TOOL] Iterative authoring credit deduction failed (non-fatal)', {
        previewSessionId: context.previewSessionId,
        extraCredits,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const durationSec = (result.durationMs / 1000).toFixed(1);
  const statusWord = result.success ? 'completed' : 'stopped';
  return {
    success: result.success,
    data: {
      previewSessionId: context.previewSessionId,
      ephemeral: true,
      startUrl: result.startUrl,
      endUrl: result.endUrl,
      stepCount: intentSteps.length,
      roundsExecuted: result.roundsExecuted,
    },
    message: `Built ${intentSteps.length} grounded step${intentSteps.length === 1 ? '' : 's'} in ${durationSec}s (run ${statusWord} — ${result.reason}). Each step was executed live on the page, so it's already verified. Say "save" to persist this as a test case.`,
    displayToUser: true,
  };
}
