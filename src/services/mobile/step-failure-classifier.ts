/**
 * Mobile step result → the two `runtimeMeta` fields the run report renders.
 *
 * Both existed for web only. Mobile hardcoded `failedReason: 'unknown'` and
 * could never produce `runtimeStatus: 'healed'`, so a mobile run showed neither
 * a classified failure nor any evidence that self-healing had happened — the
 * two things the report UI is built to display (`StepsTimeline` renders the
 * badge and an expandable before/after diff; both are platform-agnostic).
 *
 * Extracted here rather than inlined in `mobile-test-run.job.ts` because this is
 * interpretation policy, not job orchestration (.claude/rules/architecture.md),
 * and because it is pure — the job's loop is not unit-testable, this is.
 */

import type { FailedReason } from '@/services/testing/ui/preview/preview.types';
import type {
  MobileBindingHints,
  MobileCompiledPlan,
  MobileIntentStep,
  MobileStepResult,
} from './mobile-runner.types';

/**
 * The runner already classifies every failed step from STRUCTURED evidence
 * (crash reason, HTTP status, console exception) in
 * `qait-mobile-runner/src/runner/error-evidence-collector.ts`, and the backend
 * already carries it on `MobileStepResult.errorClassification`. Mapping that is
 * strictly better than re-deriving from the message text, which gets reworded
 * the first time someone improves the copy — the same rule the exploration
 * classifier states at `testing/exploration/classify-failure.ts`.
 *
 * `type` is typed `string`, not a union, so unknown values fall through rather
 * than being assumed absent.
 */
const FAILED_REASON_BY_CLASSIFICATION: Readonly<Record<string, FailedReason>> = {
  element_not_found: 'element_not_found',
  // The element still exists but the screen moved on — the report's actionable
  // meaning is the same: what the step targeted is not there now.
  ui_change: 'element_not_found',
  assertion_failure: 'assertion_failed',
  // No native HTTP interception exists on mobile, so a network_error here came
  // from WebView CDP or a visible error surface — i.e. the backend failed in a
  // way the UI did not otherwise report.
  network_error: 'silent_backend_failure',
  // ANR is the OS declaring the app wedged. That is a hang, not a wrong answer.
  anr: 'timeout',
  performance_degradation: 'timeout',
};

/**
 * Step kinds whose whole job is to assert. The frontend calls it `ai_check`;
 * the runner's action type is `assert_visible` (lint-action-type.ts maps both
 * `assert` and `ai_check` onto it), so both spellings have to be here.
 */
const ASSERTION_STEP_TYPES: ReadonlySet<string> = new Set([
  'ai_check',
  'assert',
  'assert_visible',
  'visual_check',
]);

/** `resolvedVia` values that are themselves a verdict about resolution. */
const FAILED_REASON_BY_RESOLVED_VIA: Readonly<Record<string, FailedReason>> = {
  unresolved: 'element_not_found',
  // The resolver found something but trusted it too little to act — a heal that
  // was attempted and refused, which is exactly what `heal_blocked` means.
  low_confidence: 'heal_blocked',
};

/**
 * Classify a failed mobile step. Returns `undefined` for a step that did not
 * fail, so the caller can spread it without emitting a reason on success.
 *
 * Order is deliberate: structured classification, then the resolver's own
 * verdict, then — only as a last resort — the message text.
 */
export function classifyMobileFailure(
  result: Pick<MobileStepResult, 'error' | 'resolvedVia' | 'errorClassification'>,
  stepType?: string,
): FailedReason | undefined {
  if (!result.error) return undefined;

  // Structured evidence FIRST, even on an assertion step. An ai_check that died
  // because the app crashed, ANR'd or lost the device is not an assertion
  // failure, and saying so sends the reader to audit their assertion while the
  // real cause (a crash) goes unmentioned. Observed live: a `connection_lost`
  // failure on an ai_check was persisted as `assertion_failed` when this check
  // ran ahead of the classification below.
  const classified = result.errorClassification?.type;
  if (classified && Object.prototype.hasOwnProperty.call(FAILED_REASON_BY_CLASSIFICATION, classified)) {
    return FAILED_REASON_BY_CLASSIFICATION[classified];
  }

  // Only when there is NO structured cause at all: a failed assertion step IS
  // an assertion failure. The runner attaches `errorClassification` from
  // crash/network/console evidence, and a confidently-failed ai_check has none
  // of that — so without this an honest "the screen shows a login form, not a
  // shop" verdict was persisted as `unknown`, the least useful label available.
  //
  // Gated on `!classified`, not just on ordering: the map above deliberately
  // covers only the types with a faithful `FailedReason`, so an unmapped one
  // (app_crash, js_exception, system_alert) would otherwise fall through to
  // here and be relabelled as the test's fault. A crash during an assertion is
  // better reported as `unknown` with the explanation intact than as a
  // confident, wrong `assertion_failed`.
  if (!classified && stepType && ASSERTION_STEP_TYPES.has(stepType)) return 'assertion_failed';

  const via = result.resolvedVia;
  if (via && Object.prototype.hasOwnProperty.call(FAILED_REASON_BY_RESOLVED_VIA, via)) {
    return FAILED_REASON_BY_RESOLVED_VIA[via];
  }

  // Last resort. A dispatch timeout is raised as a plain Error by
  // `MobileRunnerClient.request` and carries no structured classification.
  if (/\btimed out\b|\btimeout\b/i.test(result.error)) return 'timeout';

  return 'unknown';
}

export interface MobileHealOutcome {
  healed: boolean;
  healedFrom?: string;
  healedTo?: string;
  healWhatChanged?: string;
}

const NOT_HEALED: MobileHealOutcome = { healed: false };

function hintLabel(hints: MobileBindingHints | undefined): string | undefined {
  const label = hints?.label?.trim() || hints?.nearText?.trim();
  return label || undefined;
}

/**
 * The human-readable label of whatever the runner just resolved.
 *
 * NOT read from `enrichedHints`: verified live on a Flutter relabel, those come
 * back as `{ role: 'FilledButton' }` with no label at all. The new label is
 * carried on the freshly-built compiled plan instead — for the same resolve,
 * `strategies[].descendants[].text` held `"Continue"`.
 *
 * `strategies` is deliberately `Array<Record<string, unknown>>` (the builder
 * emits several shapes: creation_location, contains_descendants, resource_id …),
 * so this walks it defensively and gives up rather than assuming a shape.
 */
function planLabel(plan: MobileCompiledPlan | undefined): string | undefined {
  const fingerprint = plan?.fingerprint?.label?.trim();
  if (fingerprint) return fingerprint;

  for (const strategy of plan?.strategies ?? []) {
    const descendants = (strategy as { descendants?: unknown }).descendants;
    if (!Array.isArray(descendants)) continue;
    for (const descendant of descendants) {
      const text = (descendant as { text?: unknown })?.text;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }

  return undefined;
}

/**
 * Area beyond which the newly-resolved element is treated as an ancestor the
 * resolver fell back to rather than the same control under a new name. Chosen
 * from the observed pair: a login CTA is ~1272x168, the screen it sits in is
 * 1440x3036 — a ~20x jump. 4x leaves generous room for a control that genuinely
 * grew (an icon button becoming a labelled one) while still catching a
 * screen-sized match.
 */
const ANCESTOR_FALLBACK_AREA_RATIO = 4;

/**
 * Did the resolver land on an ancestor instead of the control?
 *
 * Deliberately conservative: it only fires when BOTH plans carry real bounds
 * and the growth is extreme. Missing bounds means we do not know, and an
 * unknown must not suppress a genuine heal.
 */
function isAncestorFallback(
  anchored: MobileCompiledPlan | undefined,
  resolved: MobileCompiledPlan | undefined,
): boolean {
  const before = anchored?.fingerprint?.boundsSize;
  const after = resolved?.fingerprint?.boundsSize;
  if (!before || !after) return false;

  const beforeArea = before.width * before.height;
  const afterArea = after.width * after.height;
  if (beforeArea <= 0 || afterArea <= 0) return false;

  return afterArea / beforeArea >= ANCESTOR_FALLBACK_AREA_RATIO;
}

/**
 * Did this step only pass because the element was re-resolved?
 *
 * The web notion of "healed" (a compiled locator plan missed, then healing
 * rebuilt it) does NOT transfer: on Flutter, `smartResolve` returns early via a
 * text-finder fast path (`resolvedVia: 'flutter_finder_first'`) BEFORE the
 * compiled path is consulted, and that branch returns no `compiledPlan` — so a
 * textually-matchable control never persists a plan to miss later. Gating on a
 * compiled plan would be silent on real heals and would fire on unchanged runs.
 *
 * `enrichedHints` is the signal that actually means "the cheap path did not
 * answer": the runner builds it only when the FULL resolver ran and succeeded
 * above its confidence floor (`mobile-runner.ts`). Requiring the step to have
 * carried prior hints is what stops a step's first-ever resolve — which is
 * legitimately an LLM resolve — from being reported as a heal.
 */
export function deriveMobileHeal(
  step: Pick<MobileIntentStep, 'bindingHints' | 'compiled'> | undefined,
  result: Pick<MobileStepResult, 'success' | 'enrichedHints' | 'compiledPlan'>,
): MobileHealOutcome {
  if (!result.success || !result.enrichedHints) return NOT_HEALED;

  // The "before" is what the step was ANCHORED to: the compiled plan persisted
  // when it was authored (editor Find/apply) or by its last green run. That is
  // the mobile equivalent of web's recorded locator.
  //
  // `bindingHints` is only a fallback — verified live, the editor persists a
  // compiled plan but leaves `bindingHints` null, so keying on hints alone made
  // this silently inert for every step authored through the editor.
  const before = planLabel(step?.compiled) ?? hintLabel(step?.bindingHints);
  if (!before) return NOT_HEALED;

  // The resolver can "succeed" by falling back to an ancestor when the real
  // target is gone — observed live: with the login CTA deleted it matched the
  // whole LoginScreen (1440x3036), tapped it, reported success, and the app
  // never moved. Badging that as a heal is worse than saying nothing: it puts a
  // confident "self-healing recovered this" on an action that did not happen.
  // A relabelled control stays about the same size; an ancestor fallback is
  // dramatically bigger, so that ratio is the available tell.
  if (isAncestorFallback(step?.compiled, result.compiledPlan)) return NOT_HEALED;

  const after = planLabel(result.compiledPlan);
  // Both conditions are deliberately strict, because a WRONG heal badge is worse
  // than a missing one — it invites someone to review a step nothing happened to.
  //
  // Requiring a resolvable new label also bounds a real over-fire: a step whose
  // intent never matches textually (an icon-only control) takes the full
  // resolver on EVERY run, so `enrichedHints` alone would badge it as healed
  // forever. Distinguishing that from a genuine break needs the previous run's
  // resolution path, which is not available here — so we only claim a heal when
  // we can name what the element is called now and it differs from the recording.
  if (!after || after === before) return NOT_HEALED;

  return {
    healed: true,
    healedFrom: before,
    healedTo: after,
    healWhatChanged: `Element label changed from "${before}" to "${after}"`,
  };
}
