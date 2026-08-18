/**
 * Regression Doctor — recurrence key.
 *
 * Pure, deterministic, no DB / no LLM.
 *
 * `regression_doctor_findings.pattern_key` answers "have we seen THIS breakage
 * before?" across runs — the signal behind "this step has now broken three
 * nights running". It is no longer a grouping key: findings are per step, and
 * the old key (url × element × errorShape) was fed by drift signals that are
 * null on web and "unknown" on mobile.
 *
 * SHA-1 for the same reason as before: 40 hex chars, cheap, stable, indexable.
 * We are bucketing, not authenticating.
 */

import { createHash } from 'crypto';

export interface StepPatternInput {
  testCaseId: string;
  stepId: string;
  /** Normalized failure reason — falls back to the action when unclassified. */
  failureKind: string;
}

/**
 * `sha1(testCaseId \0 stepId \0 failureKind)`.
 *
 * NUL separator so the three fields cannot bleed into each other: none of the
 * inputs can contain it, unlike `:` and `_`, which all three routinely do
 * (step ids look like `d_<draft>:step-3`).
 *
 * Keyed on the STEP, not on the proposed fix: the same step failing the same
 * way next week is the recurrence we want to surface, whatever the agent
 * decides to suggest about it this time.
 */
export function computeStepPatternKey(input: StepPatternInput): string {
  const SEP = '\u0000';
  const canonical = [
    input.testCaseId.trim(),
    input.stepId.trim(),
    input.failureKind.trim().toLowerCase(),
  ].join(SEP);
  return createHash('sha1').update(canonical).digest('hex');
}
