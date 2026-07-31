/**
 * Pure classifier for mobile test step results.
 *
 * Separates mandatory failures (which fail the test) from tolerable failures:
 * - Steps authored with `options.continueOnError: true` — user-authored soft steps
 * - Steps with `isAutoInjected: true` — runner-injected infrastructure helpers
 * - Steps whose `stepId` is not in the original intent list — runner-added steps
 *
 * Also detects a TRUNCATED run — the runner returning fewer results than were
 * requested (early abort / timeout) — and forces the verdict to fail, so an
 * incomplete run never shows a false-green short count.
 *
 * Mirrors the verdict logic in `mobile-test-run.job.ts` Phase 4 and the runner's
 * `shouldContinue` rule in qait-mobile-runner `run.routes.ts:553`.
 */

import type { MobileIntentStep, MobileStepResult } from '@/services/mobile/mobile-runner.types';

export interface StepClassificationResult {
  /** True when no mandatory step failed — used to derive `tests.status` */
  testPassed: boolean;
  /** Steps that failed AND are not tolerable */
  mandatoryFailures: MobileStepResult[];
  /** Steps that failed but are tolerable (optional / auto-injected) */
  optionalFailures: MobileStepResult[];
  /**
   * True when the runner's aggregate `status` said "passed" but per-step
   * results contain failures. Indicates a runner-side accounting bug;
   * the worker's verdict overrides in this case.
   */
  aggregateMismatch: boolean;
  /**
   * True when the runner returned FEWER step results than were requested —
   * i.e. some intent step has no result at all (`steps.length` short of the
   * intent count, or short of the runner's own reported `totalSteps`). Happens
   * when the runner aborts early / times out without pushing placeholder
   * failures. The missing steps are unknown, so we cannot prove the test
   * completed — the verdict is forced to fail (`testPassed=false`) regardless
   * of how the returned steps fared.
   */
  incompleteRun: boolean;
  /** Intent step IDs that the runner returned no result for (drives `incompleteRun`). */
  missingStepIds: string[];
  /** Expected step count (max of intent count and runner-reported `totalSteps`). */
  expectedStepCount: number;
  /** Number of step results the runner actually returned. */
  returnedStepCount: number;
  /**
   * Predicate built from the intent list.
   * Reusable during the per-step WS emission loop to badge soft-fails
   * differently from hard fails — keeps the caller from re-deriving it.
   */
  isTolerableFailure: (stepId: string) => boolean;
}

export function classifyStepResults(
  steps: MobileStepResult[],
  intentSteps: MobileIntentStep[],
  runnerStatus: string,
  runnerTotalSteps?: number,
): StepClassificationResult {
  const tolerableFailureStepIds = new Set<string>();
  const knownStepIds = new Set<string>();

  for (const s of intentSteps) {
    knownStepIds.add(s.id);
    if (
      s.options?.continueOnError === true
      || s.isAutoInjected === true
      // Author-disabled step: it was never meant to run, so it can never be
      // the reason a test fails. The runner already reports these with
      // `success: true`, but excusing them here keeps the verdict correct even
      // if a runner predating `skipReason` reports the skip as a failure.
      || s.options?.enabled === false
    ) {
      tolerableFailureStepIds.add(s.id);
    }
  }

  const isTolerableFailure = (stepId: string): boolean => {
    // Steps the runner adds itself (not in our intentSteps) are infrastructure
    // helpers — tolerable regardless of whether they fail.
    if (!knownStepIds.has(stepId)) return true;
    return tolerableFailureStepIds.has(stepId);
  };

  const mandatoryFailures = steps.filter((s) => !s.success && !isTolerableFailure(s.stepId));
  const optionalFailures = steps.filter((s) => !s.success && isTolerableFailure(s.stepId));
  const aggregateMismatch = runnerStatus === 'passed' && steps.some((s) => !s.success);

  // ── Truncated-run detection ───────────────────────────────────────
  // The runner can abort early / time out and return FEWER results than
  // were requested WITHOUT pushing placeholder failures. Inspecting only
  // the returned steps would then mark an incomplete run as passed (a
  // false-green short count, e.g. 3/5). Cross-check coverage two ways:
  // every intent step must have a result, and the count must not fall
  // short of the runner's own reported total.
  const returnedStepIds = new Set(steps.map((s) => s.stepId));
  const missingStepIds = intentSteps.filter((s) => !returnedStepIds.has(s.id)).map((s) => s.id);
  const expectedStepCount = Math.max(intentSteps.length, runnerTotalSteps ?? 0);
  const returnedStepCount = steps.length;
  const incompleteRun = missingStepIds.length > 0 || returnedStepCount < expectedStepCount;

  // An incomplete run cannot be trusted as passed — steps that never ran
  // might have failed. Force the verdict to fail even if no returned step
  // failed.
  const testPassed = mandatoryFailures.length === 0 && !incompleteRun;

  return {
    testPassed,
    mandatoryFailures,
    optionalFailures,
    aggregateMismatch,
    incompleteRun,
    missingStepIds,
    expectedStepCount,
    returnedStepCount,
    isTolerableFailure,
  };
}
