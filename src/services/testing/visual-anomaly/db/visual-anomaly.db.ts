import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * db/ sublayer for `visual_anomaly_findings` — ADR-0012.
 * Pure Supabase queries + row shape only. The recurrence-gating DECISION
 * logic (append/prune affected_run_ids, decide the one-way ratchet to
 * 'surfaced') lives in `visual-anomaly-check.service.ts`, per this repo's
 * architecture rule that `db/` files hold no business logic — this file
 * only reads a row and writes whatever row the service hands it.
 */

export interface VisualAnomalyFindingRow {
  id: string;
  project_id: string;
  test_case_id: string;
  user_id: string;
  pattern_key: string;
  screenshot_role: 'final' | 'failure';
  category: string;
  description: string;
  confidence: number;
  example_screenshot_url: string;
  affected_run_ids: string[];
  recurrence_count: number;
  status: 'below_threshold' | 'surfaced' | 'dismissed' | 'resolved';
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Fetch the existing finding for a (project, fingerprint) pair, if any.
 * Returns null on not-found OR query error (logged) — the service treats
 * both as "no prior observation, start a fresh finding".
 */
export async function getFindingByPatternKey(
  projectId: string,
  patternKey: string,
): Promise<VisualAnomalyFindingRow | null> {
  const { data, error } = await supabaseAdmin
    .from('visual_anomaly_findings')
    .select('*')
    .eq('project_id', projectId)
    .eq('pattern_key', patternKey)
    .maybeSingle();

  if (error) {
    logger.error('[VISUAL_ANOMALY_DB] Failed to fetch finding by pattern key', { error, projectId, patternKey });
    return null;
  }
  return data as VisualAnomalyFindingRow | null;
}

/**
 * Insert a brand-new finding row (first-ever observation of this fingerprint
 * in this project). Idempotent against a concurrent first-observation race
 * via the `(project_id, pattern_key)` unique index — a conflict here means
 * another observation won the race; the caller falls back to `upsertFinding`
 * against the now-existing row.
 */
export async function insertFinding(
  row: Omit<VisualAnomalyFindingRow, 'id'>,
): Promise<{ error: unknown }> {
  const { error } = await supabaseAdmin
    .from('visual_anomaly_findings')
    .insert(row);

  return { error };
}

/**
 * Patch an existing finding row by id.
 */
export async function updateFinding(
  id: string,
  patch: Partial<VisualAnomalyFindingRow>,
): Promise<{ error: unknown }> {
  const { error } = await supabaseAdmin
    .from('visual_anomaly_findings')
    .update(patch)
    .eq('id', id);

  return { error };
}

export interface SweepTestContext {
  testId: string;
  testCaseId: string | null;
  runId: string | null;
  projectId: string | null;
  userId: string | null;
}

/**
 * Resolve the regression run a test belongs to — mirrors
 * `TestCompletionHandlerService.updateRegressionRuns`'s full Query 1 + Query 2
 * + Query 3 (verified against that file directly): `regression_runs.test_id`
 * for the single-test-case dispatch path, `regression_runs.test_ids` (a
 * JSONB array) for bulk plan/module/flow dispatch once that column is
 * written, and — CORRECTED (2026-07-10, code review) — the `test_executions`
 * fallback that handler's own comment calls "most reliable for plan runs":
 * for a multi-level plan/module/flow run, `test_ids` isn't written to
 * `regression_runs` until the ENTIRE run's dispatch-and-wait loop finishes
 * (`test-execution-orchestrator.service.ts`), which can exceed this queue's
 * retry window, while `test_executions.result->>testId` is written at
 * dispatch time — near-immediately. Omitting Query 3 (the original version
 * of this function did, on the mistaken belief Queries 1+2 covered every
 * shape) silently starved the sweep for exactly the multi-level-plan case
 * this whole file was already once rewritten to fix.
 *
 * Deliberately does NOT filter by status the way the completion handler
 * does (`.in('status', ['running','pending'])` exists because IT is
 * choosing which in-flight runs to update; this lookup wants the run
 * regardless of its current status).
 *
 * Queried sequentially, not all in parallel: a given test can only match
 * exactly one dispatch shape, so the direct `test_id` hit (the common
 * single-test-case path) resolves in one query instead of three. The
 * `test_ids`/`test_executions` pair still race in parallel when direct
 * misses, since either can legitimately resolve a bulk-dispatch run
 * depending on write timing.
 */
async function findRegressionRunIdForTest(testId: string): Promise<string | null> {
  // Same guard test-completion-handler.service.ts's identical `.filter('test_ids','cs',...)`
  // pattern already has ("to prevent injection in .or() filter") — dropped when this
  // function was first written to mirror it; testId is always a DB-generated
  // tests.id UUID today, but this keeps the two copies in parity.
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(testId)) {
    logger.error('[VISUAL_ANOMALY_DB] Invalid testId format, skipping regression run lookup', { testId });
    return null;
  }

  const direct = await supabaseAdmin.from('regression_runs').select('id').eq('test_id', testId).limit(1);
  if (direct.error) {
    logger.error('[VISUAL_ANOMALY_DB] Failed to look up regression run by test_id', { error: direct.error, testId });
  } else if (direct.data?.[0]?.id) {
    return direct.data[0].id;
  }

  const [batch, exec] = await Promise.all([
    supabaseAdmin.from('regression_runs').select('id').filter('test_ids', 'cs', `["${testId}"]`).limit(1),
    supabaseAdmin.from('test_executions').select('run_id').eq('result->>testId', testId).limit(1),
  ]);
  if (batch.error) {
    logger.error('[VISUAL_ANOMALY_DB] Failed to look up regression run by test_ids array', { error: batch.error, testId });
  }
  if (exec.error) {
    logger.error('[VISUAL_ANOMALY_DB] Failed to look up regression run via test_executions fallback', { error: exec.error, testId });
  }
  return batch.data?.[0]?.id ?? exec.data?.[0]?.run_id ?? null;
}

/**
 * Resolve the context a sweep job needs from a testResultId — mirrors
 * `ai-analysis.job.ts`'s `getTestResult` web/mobile fallback shape, but
 * selects only the columns this feature needs: `tests.options.metadata.
 * intentTestCaseId` (the saved test case id) and the run id, resolved via
 * `findRegressionRunIdForTest` above.
 *
 * CORRECTED (2026-07-10, caught live): the first version read
 * `tests.regression_run_id` directly. That column's own doc comment
 * (`src/types/index.ts`) says it is "set only for the single-test-case
 * dispatch path... Bulk plan/module/flow runs omit this" — so it was null
 * for the far more common bulk-dispatch case, and the sweep silently never
 * ran. Confirmed live: a module-dispatched run showed `missingRunId: true`
 * while `TEST_COMPLETION`'s own (different) lookup resolved the same run
 * seconds later.
 *
 * Returns all nulls (not an error) for an ad-hoc/chat-lite run with no
 * matching regression run — this feature only makes sense for regression-run
 * executions. Skips the `findRegressionRunIdForTest` lookup entirely for
 * that case (checked via `testCaseId` below) — a test with no saved test
 * case can never be regression-run-linked, so the two-to-three-query lookup
 * would only ever resolve a runId the caller (`visual-anomaly-sweep.job.ts`)
 * is guaranteed to discard on its `!testCaseId` skip check.
 */
export async function getSweepTestContext(testResultId: string): Promise<SweepTestContext | null> {
  const SELECT = 'tests!inner(id, project_id, user_id, options)';

  const web = await supabaseAdmin.from('test_results').select(SELECT).eq('id', testResultId).maybeSingle();
  const row = web.data ?? (await supabaseAdmin.from('mobile_test_results').select(SELECT).eq('id', testResultId).maybeSingle()).data;

  const tests = (row as any)?.tests;
  if (!tests) return null;

  const testCaseId = tests.options?.metadata?.intentTestCaseId ?? null;
  const runId = testCaseId ? await findRegressionRunIdForTest(tests.id) : null;

  return {
    testId: tests.id,
    testCaseId,
    runId,
    projectId: tests.project_id ?? null,
    userId: tests.user_id ?? null,
  };
}

/**
 * Read `tests.executed_steps` for one test — the same JSONB column
 * `regression-report-assembler.service.ts` reads step screenshots from,
 * queried directly here rather than imported cross-domain so this feature's
 * db reads stay self-contained in its own sublayer.
 */
export async function getExecutedStepsForTest(testId: string): Promise<any[]> {
  const { data, error } = await supabaseAdmin
    .from('tests')
    .select('executed_steps')
    .eq('id', testId)
    .maybeSingle();

  if (error) {
    logger.error('[VISUAL_ANOMALY_DB] Failed to fetch executed_steps', { error, testId });
    return [];
  }
  return (data?.executed_steps as any[]) || [];
}

export interface SurfacedFindingWithTestCase extends VisualAnomalyFindingRow {
  intent_test_cases: { name: string } | null;
}

/**
 * Surfaced findings observed in THIS specific run — scoped by
 * `:runId = ANY(affected_run_ids)`, not just any surfaced row for the
 * project, so a run never shows a finding it didn't actually produce.
 */
export async function getSurfacedFindingsForRun(
  projectId: string,
  runId: string,
): Promise<SurfacedFindingWithTestCase[]> {
  const { data, error } = await supabaseAdmin
    .from('visual_anomaly_findings')
    .select('*, intent_test_cases(name)')
    .eq('project_id', projectId)
    .eq('status', 'surfaced')
    .contains('affected_run_ids', [runId]);

  if (error) {
    logger.error('[VISUAL_ANOMALY_DB] Failed to fetch surfaced findings for run', { error, projectId, runId });
    return [];
  }
  return (data as SurfacedFindingWithTestCase[]) || [];
}
