/**
 * Intent-step dispatch-time preprocessing — two concerns, one module:
 *
 *   1. `normaliseIntentStep(raw, index, phase?)` — canonicalise the shape
 *      of an IntentStep read out of `intent_test_cases` JSONB (setup_steps,
 *      teardown_steps, steps_json) so every downstream consumer sees the
 *      same fields. Single source of truth: adding a new optional field
 *      to IntentStep requires a change here and nowhere else.
 *
 *   2. `stitchPhases(mainSteps, testCase)` — prepend setup_steps + append
 *      teardown_steps + tag every step with `phase: 'setup'|'main'|'teardown'`.
 *      This is how authoring-time preconditions / teardown finally reach
 *      the runtime (the columns existed for a while but nothing read them).
 *
 * Both functions are shared by both platforms:
 *   - web:    regression-run.service.buildTestRequest → IntentStepConverter
 *   - mobile: regression-run.service.dispatchMobileTest → mobile runner
 *
 * Keeping them in one file means "everything that happens to an IntentStep
 * between DB read and executor dispatch" is co-located. The file name
 * reflects the role, not any one feature — originally called
 * `phase-stitching.service.ts`, renamed because normalisation is now the
 * bigger share of its responsibility.
 *
 * ── Stitch contract ──────────────────────────────────────────────────
 *   stitchPhases(mainSteps, testCase)
 *     → [...setupSteps (phase:'setup'),
 *        ...mainSteps  (phase:'main'),
 *        ...teardownSteps (phase:'teardown')]
 *
 * The returned array is still `IntentStep[]`. Callers convert to the
 * platform-specific command shape afterwards — the `phase` field
 * propagates as an optional field on both PlaywrightCommand and
 * MobileIntentStep.
 *
 * Deliberate no-flag design
 * -------------------------
 * There is no `ENABLE_…` env var. Stitching is triggered purely by the
 * presence of `setup_steps` / `teardown_steps` on the test case. An
 * empty-extras case (which is every pre-Phase-3 test) is a zero-cost
 * passthrough — the helper returns `mainSteps` untouched, with
 * `didStitch: false`. So the lifecycle is user-authoring-driven, not
 * ops-flag-driven: if a user adds a setup step, it runs; otherwise the
 * run is byte-identical to pre-Phase-3.
 *
 * Failure semantics
 * -----------------
 * Setup step failure   → test aborts. Current behaviour: the Playwright
 *                        executor stops the run on any non-continueOnError
 *                        step failure, so main AND teardown are skipped
 *                        too. TRUE xUnit semantics ("always run teardown
 *                        even if setup failed") would require an executor
 *                        change and is tracked as a Phase-3 follow-up —
 *                        see TODO below. Regardless, the final verdict is
 *                        `failed` with the setup step marked as the root
 *                        cause, which is the important user-visible signal.
 * Main step failure    → existing behaviour (abort unless continueOnError).
 * Teardown step failure → We set `continueOnError: true` on every teardown
 *                        step at conversion time (see intent-step-converter.ts).
 *                        That means: executor logs & moves on; the report
 *                        still marks the step status='warning' (see
 *                        assembleReport in regression-run.service.ts), and
 *                        the overall verdict is owned by main — a failing
 *                        teardown on a passing main keeps the test green.
 *
 * // TODO(phase-3-followup): make teardown run-regardless by splitting
 * // the run into two executor invocations (setup+main, then teardown
 * // even on failure) OR adding an `alwaysRun: true` hint the executor
 * // can honour. Needs coordination with the Playwright agent repo.
 *
 * Preconditions (TEXT[] of other case IDs)
 * ----------------------------------------
 * `preconditions` on `intent_test_cases` is an uuid[] of OTHER test case
 * IDs that must pass before this one. That concept is already handled by
 * the plan-level topological sort (`dependsOn`) — **we treat the column
 * as an alias for dependsOn and do NOT inline-execute the referenced
 * cases here.** Inline step injection is `setup_steps` only.
 */

import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { logger } from '@/utils/core/logger';

type Phase = 'setup' | 'main' | 'teardown';

export interface StitchedSteps {
  /** Full list to execute, in order. Each step carries a `phase` marker. */
  steps: IntentStep[];
  /** Number of steps in each phase — useful for logging and progress UIs. */
  counts: { setup: number; main: number; teardown: number };
  /**
   * True if the helper actually prepended / appended anything (i.e. the
   * test case had setup_steps and/or teardown_steps and the feature flag
   * was on). Lets callers log "stitched" only when stitching happened.
   */
  didStitch: boolean;
}

/**
 * Normalise an arbitrary step-shaped object (from DB JSONB, with unknown
 * casing and missing fields) into an IntentStep. **Single source of truth**
 * for how raw step JSON becomes a well-formed IntentStep — shared by:
 *
 *   - `stitchPhases` (this file) for setup/teardown extras
 *   - `RegressionSaveService.saveFromRecording` when writing a new case
 *   - `RegressionRunService.dispatchMobileTest` for the mobile main body
 *
 * Keep this one function the only place that lists which IntentStep fields
 * survive the round-trip through JSONB. Adding a new field means adding
 * ONE line here, not three.
 *
 * @param raw    Unknown shape from JSONB. Missing fields fall back to defaults.
 * @param index  0-based position used to build a stable id fallback.
 * @param phase  Optional lifecycle phase. When present it's written verbatim;
 *               when omitted, the step is left phase-less (legacy shape) —
 *               callers that need an explicit 'main' tag should pass it.
 */
export function normaliseIntentStep(
  raw: any,
  index: number,
  phase?: Phase,
): IntentStep {
  const fallbackIdPrefix = phase ?? 'step';
  return {
    id: raw?.id ?? `${fallbackIdPrefix}_${index + 1}`,
    type: raw?.type ?? 'click',
    description:
      raw?.description
      ?? (phase ? `${phase} step ${index + 1}` : `Step ${index + 1}`),
    ...(raw?.value !== undefined ? { value: raw.value } : {}),
    ...(raw?.assertionText ? { assertionText: raw.assertionText } : {}),
    ...(raw?.bindingHints ? { bindingHints: raw.bindingHints } : {}),
    // Sanitizer's primary signal — must survive normalisation or the save
    // boundary can't see the agent's "this is a credential" flag.
    ...(raw?.isSensitive === true ? { isSensitive: true } : {}),
    ...(raw?.compiled ? { compiled: raw.compiled } : {}),
    ...(raw?.options ? { options: raw.options } : {}),
    ...(raw?.isAutoInjected ? { isAutoInjected: raw.isAutoInjected } : {}),
    ...(raw?.expectedOutcome ? { expectedOutcome: raw.expectedOutcome } : {}),
    ...(raw?.tabIndex !== undefined ? { tabIndex: raw.tabIndex } : {}),
    // Phase marker wins over whatever might have been in the author buffer.
    ...(phase ? { phase } : {}),
  };
}

/**
 * Normalise `open_app`/`close_app` package targets before dispatch.
 *
 * A saved step's `value` can carry a stale display label (e.g. the platform
 * name "android" / "ANDROID") instead of a real package id. The mobile runner
 * would then try to launch/close a non-existent package and fail, instead of
 * acting on the app under test. We rewrite such values to the resolved build's
 * package; when none resolves we blank them (empty string — NOT undefined,
 * otherwise the runner's `value ?? description` falls through to the human
 * description) so the runner falls back to `session.packageName`.
 *
 * A value that already looks like a real package id (contains a dot and is not
 * a bare platform name) is left untouched, so flows that intentionally target
 * a specific package keep working. Mutates and returns the same array.
 *
 * Called once at the single mobile job consumer (`mobile-test-run.job.ts`)
 * before `runSteps`, so every dispatch path (regression / CI / chat / preview)
 * is covered in one place and the normalisation rule lives in exactly one spot.
 */
export function sanitizeMobileAppPackageSteps<T extends { type?: unknown; value?: unknown }>(
  steps: T[],
  resolvedPackage?: string | null,
): T[] {
  const looksLikePackageId = (v: unknown): v is string =>
    typeof v === 'string'
    && v.includes('.')
    && !['android', 'ios', 'flutter'].includes(v.trim().toLowerCase());
  for (const step of steps) {
    const stepType = String((step as { type?: unknown }).type);
    if (stepType !== 'open_app' && stepType !== 'close_app') continue;
    if (looksLikePackageId((step as { value?: unknown }).value)) continue;
    (step as { value?: string }).value = resolvedPackage ?? '';
  }
  return steps;
}

/**
 * Stitch setup + main + teardown into a single ordered IntentStep[].
 *
 * @param mainSteps  The test's own body (IntentStep[] — whatever the
 *                   caller already extracted from commands / graph / steps_json).
 * @param testCase   Raw intent_test_cases row OR a partial with snake_case
 *                   keys (setup_steps, teardown_steps) OR the camelCase
 *                   service shape (setupSteps, teardownSteps). We accept
 *                   both to avoid coupling callers to a specific mapper.
 * @returns          StitchedSteps — always safe to pass to the executor;
 *                   when the flag is off or both extras are empty, the
 *                   result is the input mainSteps untouched (no phase
 *                   markers added, so downstream code continues to see
 *                   pre-Phase-3 behaviour).
 */
export function stitchPhases(
  mainSteps: IntentStep[],
  testCase: any,
): StitchedSteps {
  // Accept either camelCase (TS service shape) or snake_case (raw DB row).
  const rawSetup: any[] = Array.isArray(testCase?.setupSteps)
    ? testCase.setupSteps
    : Array.isArray(testCase?.setup_steps)
      ? testCase.setup_steps
      : [];

  const rawTeardown: any[] = Array.isArray(testCase?.teardownSteps)
    ? testCase.teardownSteps
    : Array.isArray(testCase?.teardown_steps)
      ? testCase.teardown_steps
      : [];

  if (rawSetup.length === 0 && rawTeardown.length === 0) {
    return {
      steps: mainSteps,
      counts: { setup: 0, main: mainSteps.length, teardown: 0 },
      didStitch: false,
    };
  }

  const setupSteps = rawSetup.map((raw, i) => normaliseIntentStep(raw, i, 'setup'));
  const teardownSteps = rawTeardown.map((raw, i) => normaliseIntentStep(raw, i, 'teardown'));
  // Tag main steps too so the executor can treat missing `phase` as
  // "legacy run without stitching" vs explicit 'main'.
  const taggedMain = mainSteps.map<IntentStep>((step) => ({ ...step, phase: 'main' }));

  const stitched: IntentStep[] = [...setupSteps, ...taggedMain, ...teardownSteps];

  logger.info('[PHASE_STITCH] Stitched setup+main+teardown', {
    testCaseId: testCase?.id,
    setup: setupSteps.length,
    main: taggedMain.length,
    teardown: teardownSteps.length,
  });

  return {
    steps: stitched,
    counts: {
      setup: setupSteps.length,
      main: taggedMain.length,
      teardown: teardownSteps.length,
    },
    didStitch: true,
  };
}
