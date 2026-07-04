import { MOBILE_STEP_CREDIT_MULTIPLIER } from '@/services/core/token-calculator.service';
import type { ExecutableTestCase } from '@/types/testing.types';

/**
 * Row shape returned by `RegressionTestQueryService.getUiStepCountRows` that
 * this estimate reads. Loose on purpose — the query returns `any[]` and only
 * these fields matter for step counting.
 */
export interface UiStepCountRow {
  id: string;
  replay_strategy?: string;
  commands?: unknown[];
  graph_ref?: { steps?: unknown[] };
  steps_json?: unknown[];
  setup_steps?: unknown[];
  teardown_steps?: unknown[];
}

/**
 * Pure credit estimate for the UI test cases in a regression run.
 *
 * Web steps cost 1 credit each; MOBILE steps cost MOBILE_STEP_CREDIT_MULTIPLIER×
 * (emulator COGS) and are charged at that rate after the run in
 * mobile-test-run.job. The pre-flight MUST apply the same multiplier or a mobile
 * run passes the gate on a 1× estimate and then gets charged 4× — the user hits
 * "insufficient credits" (or an unexpected balance drop) despite a green
 * pre-flight. Mobile cases are `testType:'ui'` distinguished by `platform`
 * (mobile_*), so the rate is read off the CASE, not the row.
 *
 * Extracted from `RegressionRunService.checkCreditBalance` so the money-path
 * arithmetic is unit-testable without a DB.
 *
 * @param uiCases the run's `testType:'ui'` cases (carry `platform`)
 * @param rows    step-count rows fetched for those cases (keyed by `id`)
 * @returns total UI step credits (web 1×, mobile 4×), incl. a per-case minimum
 */
export function computeUiStepCredits(
  uiCases: Pick<ExecutableTestCase, 'testCaseId' | 'platform'>[],
  rows: UiStepCountRow[],
): number {
  if (uiCases.length === 0) return 0;

  const uiIds = uiCases.map((tc) => tc.testCaseId);
  const isMobileById = new Map(
    uiCases.map((tc) => [tc.testCaseId, !!tc.platform?.startsWith('mobile_')]),
  );
  const creditsPerStepFor = (id: string): number =>
    isMobileById.get(id) ? MOBILE_STEP_CREDIT_MULTIPLIER : 1;

  let uiStepCredits = 0;
  for (const row of rows) {
    let stepCount = 0;
    if (row.replay_strategy === 'commands' && Array.isArray(row.commands)) {
      stepCount = row.commands.length;
    } else if (row.replay_strategy === 'graph_extract' && row.graph_ref?.steps) {
      stepCount = Array.isArray(row.graph_ref.steps) ? row.graph_ref.steps.length : 0;
    } else if (Array.isArray(row.steps_json)) {
      // Step editor test cases: count steps_json (+ 1 for initial goto)
      stepCount = row.steps_json.length + 1;
    }
    // Phase 3: setup_steps / teardown_steps are prepended / appended at dispatch
    // time by stitchPhases(). The user is billed for what runs, so count those
    // too. Empty arrays (default for pre-Phase-3 rows) contribute 0.
    const setupCount = Array.isArray(row.setup_steps) ? row.setup_steps.length : 0;
    const teardownCount = Array.isArray(row.teardown_steps) ? row.teardown_steps.length : 0;
    stepCount += setupCount + teardownCount;
    // Minimum 1 step per test case even if steps can't be counted.
    uiStepCredits += Math.max(stepCount, 1) * creditsPerStepFor(row.id);
  }

  // Test case IDs not found in DB → charge the per-step rate each as minimum
  // (mobile min = the multiplier, web min = 1).
  const foundIds = new Set(rows.map((r) => r.id));
  for (const id of uiIds) {
    if (!foundIds.has(id)) uiStepCredits += creditsPerStepFor(id);
  }

  return uiStepCredits;
}
