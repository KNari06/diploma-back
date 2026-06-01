/**
 * Pure classifier for mobile test step results.
 *
 * Separates mandatory failures (which fail the test) from tolerable failures:
 * - Steps authored with `options.continueOnError: true` — user-authored soft steps
 * - Steps with `isAutoInjected: true` — runner-injected infrastructure helpers
 * - Steps whose `stepId` is not in the original intent list — runner-added steps
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
): StepClassificationResult {
  const tolerableFailureStepIds = new Set<string>();
  const knownStepIds = new Set<string>();

  for (const s of intentSteps) {
    knownStepIds.add(s.id);
    if (s.options?.continueOnError === true || s.isAutoInjected === true) {
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
  const testPassed = mandatoryFailures.length === 0;
  const aggregateMismatch = runnerStatus === 'passed' && steps.some((s) => !s.success);

  return {
    testPassed,
    mandatoryFailures,
    optionalFailures,
    aggregateMismatch,
    isTolerableFailure,
  };
}
