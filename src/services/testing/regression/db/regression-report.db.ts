import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * db/ sublayer for regression run-report assembly.
 * Pure Supabase queries — no business logic, no orchestration.
 * Map-building, enrichment and report shaping stay in
 * RegressionReportAssemblerService.
 */

// ── run lookup ────────────────────────────────────────────────────────────────

/**
 * Get a run with its plan name, scoped to an owner.
 * Returns null when not found or on query error (logged).
 */
export async function getRunWithOwnership(
  runId: string,
  userId: string,
): Promise<any | null> {
  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .select('*, regression_plans(name)')
    .eq('id', runId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error('[REGRESSION_RUN] Failed to get run', { error, runId });
    return null;
  }
  return data;
}

/**
 * Fetch a run by its public share token (no ownership check).
 * Returns null when not found or on query error (logged).
 */
export async function getRunByShareToken(shareToken: string): Promise<any | null> {
  const { data, error } = await supabaseAdmin
    .from('regression_runs')
    .select('*, regression_plans(name)')
    .eq('share_token', shareToken)
    .maybeSingle();

  if (error) {
    logger.error('[REGRESSION_RUN] Failed to get run by share token', { error, shareToken });
    return null;
  }
  return data;
}

// ── batch enrichment reads ──────────────────────────────────────────────────────

/**
 * Batch fetch test case id/name pairs. Empty input → empty array (no query).
 */
export async function getTestCaseNamesByIds(
  testCaseIds: string[],
): Promise<Array<{ id: string; name: string }>> {
  if (!testCaseIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name')
    .in('id', testCaseIds);

  if (error) {
    logger.warn('[REGRESSION_RUN] Failed to fetch test case names', { error, count: testCaseIds.length });
  }
  return data || [];
}

/**
 * Batch fetch test_results rows (artifacts + ai_summary) by test IDs,
 * newest first. Empty input → empty array (no query).
 */
export async function getTestResultsByTestIds(testIds: string[]): Promise<any[]> {
  if (!testIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from('test_results')
    .select('test_id, video_url, trace_url, screenshot, logs, network_logs, errors, ai_summary, quality_checks')
    .in('test_id', testIds)
    .order('created_at', { ascending: false });

  if (error) {
    logger.warn('[REGRESSION_RUN] Failed to fetch test results', { error, count: testIds.length });
  }
  return data || [];
}

/**
 * Batch fetch mobile_test_results rows by test IDs, newest first. Mobile runs
 * persist their artifacts + ai_summary to this table (NOT `test_results`), so
 * the report assembler must read both or mobile executions surface with no
 * artifacts/bugs. Empty input → empty array.
 */
export async function getMobileTestResultsByTestIds(testIds: string[]): Promise<any[]> {
  if (!testIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from('mobile_test_results')
    .select('test_id, video_url, trace_url, screenshot, logs, network_logs, errors, ai_summary, quality_checks, metadata')
    .in('test_id', testIds)
    .order('created_at', { ascending: false });

  if (error) {
    logger.warn('[REGRESSION_RUN] Failed to fetch mobile test results', { error, count: testIds.length });
  }
  return data || [];
}

/**
 * Batch fetch executed_steps from the tests table. Empty input → empty array.
 */
/**
 * Chain view: every `tests` row dispatched under one outer `regression_runs`
 * id (a segmented link_test_case run tags each segment's `tests` row with
 * the SAME outer run id — see `tests.regression_run_id` migration).
 * Ordered by dispatch order so segments render in chain order.
 */
export async function getTestsByRegressionRunId(
  runId: string,
): Promise<Array<{ id: string; status: string; browsers: string[] | null; options: any; created_at: string; completed_at: string | null; started_at: string | null }>> {
  const { data, error } = await supabaseAdmin
    .from('tests')
    .select('id, status, browsers, options, created_at, completed_at, started_at')
    .eq('regression_run_id', runId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.warn('[REGRESSION_RUN] Failed to fetch chain segment tests', { error, runId });
  }
  return data || [];
}

/**
 * Batch fetch each test's `options` blob by test id. Used to surface the
 * run-time Flutter host (`options.hostPlatform`, stamped by the dispatcher —
 * the RESOLVED host, so it covers the inherit-project-default case and never
 * goes stale) on the run report. Empty input → empty array.
 */
export async function getTestOptionsByTestIds(
  testIds: string[],
): Promise<Array<{ id: string; options: any }>> {
  if (!testIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from('tests')
    .select('id, options')
    .in('id', testIds);

  if (error) {
    logger.warn('[REGRESSION_RUN] Failed to fetch test options for host badge', { error });
    return [];
  }
  return data || [];
}

export async function getExecutedStepsByTestIds(
  testIds: string[],
): Promise<Array<{ id: string; executed_steps: any[] | null }>> {
  if (!testIds.length) return [];

  const { data, error } = await supabaseAdmin
    .from('tests')
    .select('id, executed_steps')
    .in('id', testIds);

  if (error) {
    logger.warn('[REGRESSION_RUN] Failed to fetch executed steps', { error, count: testIds.length });
  }
  return data || [];
}

/**
 * Batch fetch negative_meta for negative test cases. Empty input → empty array.
 */
export async function getNegativeMetaByIds(
  testCaseIds: string[],
): Promise<Array<{ id: string; negative_meta: any }>> {
  if (!testCaseIds.length) return [];

  const { data } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, negative_meta')
    .in('id', testCaseIds);

  return data || [];
}

/**
 * Batch fetch setup/teardown/steps counts + priority for phase reconstruction.
 * Empty input → empty array.
 */
export async function getTestCasePhaseInfoByIds(
  testCaseIds: string[],
): Promise<Array<{
  id: string;
  setup_steps: any[] | null;
  teardown_steps: any[] | null;
  steps_json: any[] | null;
  priority: string | null;
}>> {
  if (!testCaseIds.length) return [];

  const { data } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, setup_steps, teardown_steps, steps_json, priority')
    .in('id', testCaseIds);

  return data || [];
}
