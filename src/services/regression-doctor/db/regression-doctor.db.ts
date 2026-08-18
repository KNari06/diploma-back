import { supabaseAdmin } from '@/db/supabase';
import { markNegativesStaleByParent } from '@/services/testing/ui/preview/db/intent-test-case.db';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

/**
 * db/ sublayer for the Regression Doctor — every Supabase query the feature
 * makes. Pure queries + row shaping, no business logic (architecture.md).
 *
 * Read path notes that are easy to get wrong:
 *
 *  • **`test_executions` is the only place that links a run to BOTH the
 *    execution and the authored test case.** `test_case_id` is a real column
 *    there; the executed test's id lives inside the `result` JSONB as
 *    `result->>'testId'`. `tests` itself has NO reference back to
 *    `intent_test_cases` — the previous implementation tried to select
 *    `tests(intent_test_case_id)` and that column has never existed, which is
 *    one more reason it never produced a finding.
 *  • `tests.executed_steps` is written asynchronously (Redis → Postgres in the
 *    job's `finally`), so a caller that reads it right after run completion can
 *    legitimately see an empty column. Retrying is the collector's job, not
 *    this layer's — these functions report what is there, now.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface FailedExecutionRow {
  /** `tests.id` — the execution that ran. */
  testId: string;
  /** `intent_test_cases.id` — the authored case behind it. */
  testCaseId: string | null;
  status: string;
  /**
   * Why it failed, when the failure happened before any step ran (session
   * acquisition, app install, resource compile). Lives here, not on `tests` —
   * that table has no error column.
   */
  errorMessage: string | null;
}

export interface TestRunRow {
  id: string;
  status: string | null;
  executed_steps: unknown;
}

export interface TestCaseRow {
  id: string;
  name: string | null;
  platform: string | null;
  project_id: string | null;
  user_id: string | null;
  is_negative: boolean | null;
  steps_json: IntentStep[] | null;
  updated_at: string;
}

export interface AiSummaryRow {
  testId: string;
  classification: string | null;
  summary: string | null;
}

/**
 * What the agent looked at, stored on the finding so the report can render a
 * complete card without joining back to the (possibly since-edited) test case.
 * Snake_case because it is persisted JSON, read directly by the frontend.
 */
export interface FindingEvidenceSnapshot {
  test_case_name: string;
  step_type: string;
  step_description: string;
  action?: string;
  failed_reason?: string;
  failure_explanation?: string;
  fail_screenshot_url?: string;
  prior_screenshot_url?: string;
}

export interface DoctorFindingInsert {
  run_id: string;
  project_id: string;
  user_id: string;
  test_case_id: string;
  step_id: string;
  step_index: number;
  platform: string;
  verdict: string;
  evidence: FindingEvidenceSnapshot;
  pattern_key: string;
  diagnosis: string;
  confidence: number;
  proposed_patch: unknown | null;
  kb_evidence: unknown[];
  affected_test_ids: string[];
  example_test_result_ids: string[];
  url_pattern: string | null;
  target_element_key: string | null;
  error_shape: string | null;
  status: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Workspace that owns a project, for billing attribution of the analysis.
 *
 * `AIUsageTracker` files spend against a workspace, and the job only carries a
 * project id. Returns null rather than throwing: a missing workspace costs the
 * run its cost row, which must never be a reason to skip the analysis itself.
 */
export async function getWorkspaceIdForProject(projectId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('workspace_id')
    .eq('id', projectId)
    .maybeSingle();

  if (error || !data) return null;
  return (data as { workspace_id: string | null }).workspace_id ?? null;
}

/**
 * Test ids of every failed/timed-out execution in a run.
 *
 * Rows whose `result` carries no `testId` drop out — there is nothing to look
 * up for them.
 */
export async function getFailedTestIdsForRun(runId: string): Promise<FailedExecutionRow[]> {
  const { data, error } = await supabaseAdmin
    .from('test_executions')
    .select('result, status, test_case_id, error_message')
    .eq('run_id', runId);

  if (error) {
    throw new Error(`Failed to load test_executions: ${error.message}`);
  }

  return ((data as Array<{
    result: unknown;
    status: string;
    test_case_id: string | null;
    error_message: string | null;
  }>) || [])
    .filter((e) => e.status === 'failed' || e.status === 'timeout')
    .map((e) => ({
      // Empty when the execution died before a `tests` row existed — a test
      // case with no steps, or a validation error before dispatch. Deliberately
      // NOT filtered out here: dropping those rows in the query left them
      // uncounted anywhere, so a run's failures could not be reconciled with
      // what the report explained. The collector decides they are unanalyzable
      // and records the reason.
      testId: (e.result as { testId?: string } | null)?.testId ?? '',
      testCaseId: e.test_case_id ?? null,
      status: e.status,
      errorMessage: e.error_message ?? null,
    }));
}

/** `tests` rows carrying the per-step execution trace. */
export async function getTestsByIds(testIds: string[]): Promise<TestRunRow[]> {
  if (testIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('tests')
    .select('id, status, executed_steps')
    .in('id', testIds);

  if (error) {
    throw new Error(`Failed to load tests: ${error.message}`);
  }
  return (data as TestRunRow[]) || [];
}

/**
 * Just the `executed_steps` column for one test — used by the collector's
 * retry loop, which polls for the async finalize write to land.
 */
export async function getExecutedSteps(testId: string): Promise<unknown> {
  const { data } = await supabaseAdmin
    .from('tests')
    .select('executed_steps')
    .eq('id', testId)
    .maybeSingle();

  return (data as { executed_steps?: unknown } | null)?.executed_steps ?? null;
}

/** Authored test cases, with the steps the patch will target. */
export async function getTestCasesByIds(testCaseIds: string[]): Promise<TestCaseRow[]> {
  if (testCaseIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, platform, project_id, user_id, is_negative, steps_json, updated_at')
    .in('id', testCaseIds);

  if (error) {
    throw new Error(`Failed to load intent_test_cases: ${error.message}`);
  }
  return (data as TestCaseRow[]) || [];
}

/**
 * Bug Inspector verdicts for these tests, when they exist.
 *
 * Reads BOTH results tables because mobile runs are forked into
 * `mobile_test_results` (see jobs/CLAUDE.md). Best-effort context only — the
 * Doctor no longer gates on any of it, so a query error yields an empty map
 * rather than failing the analysis.
 */
export async function getAiSummaries(testIds: string[]): Promise<Map<string, AiSummaryRow>> {
  const out = new Map<string, AiSummaryRow>();
  if (testIds.length === 0) return out;

  const tables = ['test_results', 'mobile_test_results'] as const;

  for (const table of tables) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select('test_id, ai_summary')
      .in('test_id', testIds);

    if (error || !data) continue;

    for (const row of data as Array<{ test_id: string; ai_summary: unknown }>) {
      const summary = row.ai_summary as
        | { failureClassification?: string | null; summary?: string | null }
        | null;
      if (!summary || out.has(row.test_id)) continue;
      out.set(row.test_id, {
        testId: row.test_id,
        classification: summary.failureClassification ?? null,
        summary: summary.summary ?? null,
      });
    }
  }

  return out;
}

/**
 * Step ids this run already has a finding for.
 *
 * The job is retried by BullMQ when it throws, and a retry re-analyses the run
 * from the top. Without this the steps that succeeded before the failure would
 * be analysed and inserted a second time, so the report would show two cards
 * for one step — and a second LLM call would be paid for each.
 */
export async function getAnalyzedStepIds(runId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from('regression_doctor_findings')
    .select('test_case_id, step_id')
    .eq('run_id', runId);

  if (error) {
    throw new Error(`Failed to load existing findings: ${error.message}`);
  }

  return new Set(
    ((data as Array<{ test_case_id: string | null; step_id: string | null }>) || [])
      .filter((r) => Boolean(r.test_case_id) && Boolean(r.step_id))
      .map((r) => analyzedStepKey(r.test_case_id!, r.step_id!)),
  );
}

/**
 * Identity of "this step of this test case has already been analyzed".
 *
 * Must include the test case: a step id is unique only WITHIN its case. Web
 * cases number their steps `step-1`, `step-2`, … so two tests failing at their
 * respective `step-2` share an id, and keying on the id alone made the second
 * one look already-analyzed — it was skipped, silently, and re-clicking Analyze
 * repeated the same collision forever. `pattern_key` has always composed
 * testCaseId + stepId for exactly this reason.
 */
export function analyzedStepKey(testCaseId: string, stepId: string): string {
  return `${testCaseId} ${stepId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/** Insert one finding. Returns its id. */
export async function insertFinding(row: DoctorFindingInsert): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('regression_doctor_findings')
    .insert(row)
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to persist doctor finding: ${error?.message ?? 'unknown'}`);
  }
  return (data as { id: string }).id;
}
