/**
 * Regression Doctor — shared types.
 *
 * A finding describes ONE failing step of ONE test case: what broke, whether
 * the test or the application is at fault, and — only when the test is at
 * fault — a patch narrow enough to apply without review of the whole case.
 *
 * The previous model (one finding per cross-test drift PATTERN, keyed on
 * url × element × errorShape) is gone. It required `ai_summary.driftSignals`,
 * which is null on web and "unknown" on mobile, and it required two failures
 * sharing a pattern before it would say anything at all.
 */

import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

/**
 * What the agent concluded about a failing step.
 *
 * Only `test_fix` ever carries a patch — the other two are diagnoses the UI
 * renders without an Apply button. Keeping "the app is broken" as a first-class
 * verdict (rather than "no patch") is the point: a fix agent that can only ever
 * say "here's a fix" will invent one for a real bug.
 */
export type FindingVerdict = 'test_fix' | 'app_bug' | 'unclear';

/**
 * The three edits the agent may propose. Deliberately narrow — see the plan's
 * scope decision. Anything a user would call "restructure the test" is out:
 * the blast radius of a reorder/delete is the whole scenario, and a wrong one
 * is much harder to notice than a wrong label.
 */
export type StepPatchAction = 'update_element' | 'insert_wait' | 'update_assertion';

export interface StepPatch {
  action: StepPatchAction;
  /** Why this patch addresses the failure. Shown verbatim in the UI. */
  reason: string;

  // ── update_element ────────────────────────────────────────────────────────
  /** New natural-language description of the target element. */
  description?: string;
  /**
   * New binding hints. These OUTRANK `description` at replay — the runner
   * resolves `bindingHints.label || bindingHints.placeholder || description`
   * (qait-mobile-runner/src/runner/intent-step-converter.ts:33) — so a patch
   * that rewrites only the description while a stale label survives is inert.
   * `null` on a field means "clear it", which is how the agent falls back to
   * description-driven resolution.
   */
  bindingHints?: {
    label?: string | null;
    placeholder?: string | null;
    role?: string | null;
  };

  // ── insert_wait ───────────────────────────────────────────────────────────
  /** Pause duration before the failing step, in milliseconds. */
  waitMs?: number;

  // ── update_assertion ──────────────────────────────────────────────────────
  /** Replacement text for an `ai_check` step's assertion. */
  assertionText?: string;
}

/**
 * Everything the agent gets to look at for one failing step. Assembled by
 * `failed-step-collector.ts` from `tests.executed_steps` (runtime truth) and
 * `intent_test_cases.steps_json` (authored intent).
 */
export interface FailedStepEvidence {
  /** `tests.id` of the execution this failure came from. */
  testId: string;
  testCaseId: string;
  testCaseName: string;
  /** `intent_test_cases.platform` — 'web' | 'mobile_android' | 'mobile_flutter' | 'mobile_ios'. */
  platform: string;
  projectId: string;

  /** The authored step that failed, matched by id — never by position. */
  step: IntentStep;
  stepId: string;
  /** 0-based index in `steps_json`. Display only. */
  stepIndex: number;
  /** Up to two preceding steps and the following one, for flow context. */
  precedingSteps: IntentStep[];
  followingStep: IntentStep | null;

  // ── Runtime failure signal ────────────────────────────────────────────────
  /** Runner action name as executed ('click', 'ai_check', …). */
  action?: string;
  /** Structured reason from the runner's classifier. */
  failedReason?: string;
  /** Plain-language explanation — usually the single most useful field. */
  failureExplanation?: string;
  /** Screenshot taken at the moment of failure. */
  failScreenshotUrl?: string;
  /** Screenshot after the last step that DID succeed — "what it looked like before". */
  priorScreenshotUrl?: string;
  /** Foreground app package at failure time (mobile). */
  currentApp?: string;

  /** Bug Inspector's read, when it produced one. Context, never a gate. */
  aiClassification?: string | null;
  aiSummary?: string | null;
}

/** What the agent returns for one piece of evidence. */
export interface StepFixVerdict {
  verdict: FindingVerdict;
  /** One paragraph, plain language, names the product change — not "step 4 failed". */
  diagnosis: string;
  /** 0.00–1.00. */
  confidence: number;
  /** Present only when `verdict === 'test_fix'`. */
  patch: StepPatch | null;
}

/**
 * Minimum confidence for a patch to be persisted at all.
 */
export const MIN_PATCH_CONFIDENCE = 0.6;

/**
 * Assertion rewrites clear a higher bar than the other two actions.
 *
 * `update_assertion` is the one patch that can hide a real bug: it argues the
 * CHECK was wrong rather than the app. The other actions can only make a test
 * look in the right place. This threshold, the "may hide a real bug" warning in
 * the Apply dialog, and the no-dedupe rule are the three guards on it.
 */
export const MIN_ASSERTION_PATCH_CONFIDENCE = 0.75;
