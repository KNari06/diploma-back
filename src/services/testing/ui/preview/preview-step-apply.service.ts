/**
 * Preview Step Apply Service V2
 * Executes a single step in the preview session
 * Features: ownership enforcement, post-action verification, state-aware retries
 */

import { logger } from '@/utils/core/logger';
import { recordSource, resolvePlaceholders } from '@/utils/interpolation/resolve-placeholders';
import { collectSecretValues, redactWithValues } from '@/utils/interpolation/redact-secrets';
import { logIntentResolveApply } from './intent-resolve-audit';
import { sanitizeUrl } from '@/utils/validation/validation';
import { webSocketService } from '@/websocket/core/websocket.service';
import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import { getEffectiveLabel, invalidateLlmSelectionsForRef, sanitizeIntent } from './element-resolver.service';
import { invalidateTokensForText } from './stable-tokens-llm.service';
import { invalidatePrunerForRef } from './candidate-pruner-llm.service';
import { tokenizeLabel, tokenOverlap, hasAnyOverlap } from './text-similarity.util';
import { EditorTraceService } from './editor-trace.service';
import { IntentStepLintService } from './intent-step-lint.service';
import { LocatorPlanBuilder } from './locator-plan-builder.service';
import { getPreviewSessionService } from './preview-session.service';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import type {
    BindingHints,
    CompiledStepPlan,
    ConfidenceTier,
    IntentStep,
    InteractiveNode,
    LintCandidate,
    ResolutionMeta,
    StepFailureEvidence,
    TargetFingerprint,
    UrlMatcher,
} from './preview.types';

import { STEP_APPLY_CONFIG, STEP_READINESS_CONFIG, COMMAND_EXECUTOR_CONFIG } from '@/config/testing/playwright-tuning';
import { executeCoordinateDrag, parseDragCoordinates } from '@/agent/playwright/core/drag-helpers';
import { normalizeUrlForComparison } from './auto-wait-for.utils';
import { recordedFingerprintHasStrongIdentity, hasStrongIdentityContradiction } from './recorded-identity.util';
import { probeIdentity } from './step-readiness-v2.service';
import { typedValueLooksApplied, clearFieldBeforeType, verifyTypedValueAndRetry } from './type-action.helpers';
import { waitForHoverEffect } from '../wait-phases/hover-effect-settle';
import { smartStepWait } from '../smart-step-wait.service';

const MAX_ATTEMPTS = STEP_APPLY_CONFIG.maxAttempts;

/**
 * Decide whether a freshly-built compiled plan is strong enough to replace
 * the one already stored on the step.
 *
 * Called from the compiled fast-path success branch to opportunistically
 * rebuild weak/legacy plans without regressing strong ones. Returns true
 * only when the new plan demonstrably adds resolution power — more
 * distinct strategies OR a higher-priority primary strategy.
 *
 * Strategy priority order (highest first) mirrors LocatorPlanBuilder:
 *   role → testId → label → placeholder → title → text → css → ref
 *
 * Deliberately conservative: ties keep the old plan so we never rebuild
 * for cosmetic reasons. `locator-plan-builder.service.ts` is pure, so the
 * cost of "try then discard" is a few microseconds.
 */
const STRATEGY_RANK: Record<string, number> = {
  role: 7,
  testId: 6,
  label: 5,
  placeholder: 4,
  title: 3,
  text: 2,
  css: 1,
  ref: 0,
};

function shouldUpgradeCompiledPlan(
  existing: CompiledStepPlan | undefined,
  candidate: CompiledStepPlan,
): boolean {
  // No existing plan → always take the new one.
  if (!existing || !existing.locatorPlan || existing.locatorPlan.length === 0) {
    return candidate.locatorPlan.length > 0;
  }

  // Empty / invalid candidate — never replace.
  if (!candidate.locatorPlan || candidate.locatorPlan.length === 0) return false;

  // Defense-in-depth: never persist a candidate whose recorded page URL
  // differs from the existing one. The caller (V22 fast-path upgrade) is
  // already guarded by a navigation check, but if some future caller forgets
  // to gate this we'd silently corrupt the plan and trip every downstream
  // URL guard with `url_mismatch`.
  const existingHost = (() => {
    try { return existing.context?.pageUrl ? new URL(existing.context.pageUrl).host : ''; } catch { return ''; }
  })();
  const candidateHost = (() => {
    try { return candidate.context?.pageUrl ? new URL(candidate.context.pageUrl).host : ''; } catch { return ''; }
  })();
  if (existingHost && candidateHost && existingHost !== candidateHost) return false;

  const existingStrategies = new Set(existing.locatorPlan.map(e => e.strategy));
  const candidateStrategies = new Set(candidate.locatorPlan.map(e => e.strategy));

  // Candidate carries a strategy type we didn't have before — real upgrade.
  for (const s of candidateStrategies) {
    if (!existingStrategies.has(s)) return true;
  }

  // Same strategy set, but candidate's primary is stronger (e.g. role vs text).
  const existingRank = STRATEGY_RANK[existing.locatorPlan[0]?.strategy ?? ''] ?? -1;
  const candidateRank = STRATEGY_RANK[candidate.locatorPlan[0]?.strategy ?? ''] ?? -1;
  if (candidateRank > existingRank) return true;

  return false;
}

/**
 * Etap 1D.1 — Derive `planQuality` for the apply result from the compiled
 * plan that was just persisted. Returns `undefined` when the plan is fine
 * (validation confirmed at least one locator) so the WS payload stays
 * minimal on the happy path.
 *
 * `unverified` is set by `LocatorPlanBuilder.buildCompiledPlan` when:
 *   - validation phase ran but every entry came back validated=false
 *     (page navigated mid-build, all `count()` returned 0/timeout); OR
 *   - validation was skipped entirely (no `page` available, e.g. plan
 *     rebuilt from a stored artifact in a test harness).
 *
 * The reason string is best-effort — frontend doesn't parse it, only
 * displays. Server logs the same field for metric aggregation.
 */
function derivePlanQuality(
  compiled: CompiledStepPlan | undefined,
): { unverified: boolean; reason?: string } | undefined {
  if (!compiled) return undefined;
  if (!compiled.unverified) return undefined;
  // validatedAt missing => validation phase didn't run (e.g. page absent).
  // validatedAt present + unverified => validation ran but produced no live
  // matches — typically a re-rendering page or a fresh-replay scenario.
  if (!compiled.validatedAt) {
    return { unverified: true, reason: 'validation_skipped' };
  }
  const allDead = compiled.locatorPlan.every((l) => l.matchCount === 0);
  if (allDead) return { unverified: true, reason: 'all_locators_dead' };
  return { unverified: true, reason: 'no_validated_locators' };
}

/**
 * May 2026 — Runtime confirmation of compiled plan stability.
 *
 * `LocatorPlanBuilder.buildCompiledPlan` flags a plan as `unverified=true`
 * when its build-time `count()` probe couldn't confirm any locator on the
 * live page. That probe is fragile by design — a click that navigates,
 * a popover that closes mid-build, a re-rendering Angular page, all
 * legitimately race the validation and produce false positives.
 *
 * When the apply that just finished demonstrates that the element WAS
 * found AND the action produced an observable effect (verifyClickHadEffect
 * positive, or non-click action verified), runtime success is strictly
 * stronger evidence than the build-time probe — and we clear the flag
 * IN PLACE on the plan object. The cleared plan then flows through to
 * `step.compiled` and ultimately the DB via run-loop's batch persist,
 * so the editor's "⚠ unstable" badge (which reads `compiled.unverified`)
 * stops showing on steps that demonstrably work.
 *
 * Mutates the input — the plan was just constructed in the same apply
 * call, no other reader has it yet. Idempotent: noop if already cleared
 * or if there was no plan to confirm.
 *
 * Callers MUST only invoke this on the success-path (after action ran
 * and post-verification passed). Failure paths return early before
 * reaching here, so the flag stays as evidence for next-run diagnostics.
 */
function clearUnverifiedOnRuntimeMatch(
  compiled: CompiledStepPlan | undefined,
): void {
  if (!compiled) return;
  if (compiled.unverified !== true) return;
  compiled.unverified = false;
  compiled.runtimeConfirmedAt = new Date().toISOString();
}

/**
 * V2: Build bindingHints from resolved InteractiveNode.
 * Auto-populates hints for better runtime resolution.
 *
 * V22: Extended to mirror all identifying fields the recorder captures via
 * probe (recording-capture.service.ts buildBindingHints). Without this
 * symmetry, MANUALLY-AUTHORED steps (created in editor without recording)
 * had only 6 hints after their first apply, while RECORDED steps had 15+.
 * That mismatch made manual-step re-resolution and the LLM resolver
 * disambiguation noticeably worse for icon-only buttons, options, and
 * Bootstrap triggers.
 *
 * Now both code paths produce the same hint set after first successful
 * apply — manual steps catch up to recorded steps from the second resolve
 * onwards.
 */
function buildBindingHintsFromNode(node: InteractiveNode): BindingHints {
  const hints: BindingHints = {};

  // Original V2 hints (kept for compatibility with the score-based fallback
  // path in intent-step-lint.service.ts:scoreCandidate).
  if (node.role) hints.role = node.role;
  if (node.labelText) hints.label = node.labelText;
  if (node.placeholder) hints.placeholder = node.placeholder;
  if (node.autocomplete) hints.autocomplete = node.autocomplete;
  if (node.inputType || node.type) hints.type = node.inputType || node.type;

  // Add nearby text from container titles
  if (node.containerTitles && node.containerTitles.length > 0) {
    hints.nearText = node.containerTitles[0];
  }

  // V22: identity attributes — surface every stable signal the snapshot
  // collector extracted (filtered for framework-generated ids).
  if (node.text) hints.text = node.text;
  if (node.tag) hints.tag = node.tag;
  if (node.testIdAttr) hints.testId = node.testIdAttr;
  if (node.id && !node.isDynamicId) hints.elementId = node.id;
  if (node.title) hints.nearText = hints.nearText || node.title;
  if ((node as any).alt) hints.alt = (node as any).alt;
  if (node.name) hints.name = node.name;
  if (node.ariaLabel && !hints.nearText) hints.nearText = node.ariaLabel;

  // V22 secondary locator signals.
  if ((node as any).href) hints.href = (node as any).href;
  if ((node as any).ariaControls) hints.ariaControls = (node as any).ariaControls;
  if (node.nearestLandmark) hints.nearestLandmark = node.nearestLandmark;
  if (node.containerTitles && node.containerTitles.length > 1) {
    hints.containerTitles = node.containerTitles.slice(0, 2);
  }

  // V22 Pkg1 — child icon testid lift + select option semantic key.
  if ((node as any).childTestId) hints.childTestId = (node as any).childTestId;
  if ((node as any).dataValue) hints.dataValue = (node as any).dataValue;

  // V22 Pkg2 — Bootstrap / aria-haspopup / activedescendant / row-key.
  if ((node as any).bsToggle) hints.bsToggle = (node as any).bsToggle;
  if ((node as any).bsTarget) hints.bsTarget = (node as any).bsTarget;
  if ((node as any).ariaHasPopup) hints.ariaHasPopup = (node as any).ariaHasPopup;
  if ((node as any).ariaActiveDescendant) hints.ariaActiveDescendant = (node as any).ariaActiveDescendant;
  if ((node as any).dataRowKey) hints.dataRowKey = (node as any).dataRowKey;

  // V22 Pkg4 — semantic icon label (svg <title>/data-lucide/FA class).
  if ((node as any).iconLabel) (hints as any).iconLabel = (node as any).iconLabel;

  // V22 Pkg5 — row text + sibling pos + disabled + arrow direction.
  if ((node as any).nearestRowText) (hints as any).nearestRowText = (node as any).nearestRowText;
  if (typeof (node as any).siblingIndex === 'number') (hints as any).siblingIndex = (node as any).siblingIndex;
  if ((node as any).disabled !== undefined) (hints as any).disabled = (node as any).disabled;
  if ((node as any).arrowDir) (hints as any).arrowDir = (node as any).arrowDir;

  // Etap 1B.2 — Angular routerLink + formControlName. Surface to LLM
  // resolver so the prompt can use these as "this exact form input"
  // identity hints when text/role drift across renders.
  if ((node as any).routerLink) (hints as any).routerLink = (node as any).routerLink;
  if ((node as any).formControlName) (hints as any).formControlName = (node as any).formControlName;

  // V22: ARIA state at resolve-time. Records whether the resolved live
  // element was expanded/pressed/checked/invalid/current/etc. so the next
  // resolve treats those state hints as expectations (e.g. "click submit
  // when invalid" stays meaningful between applies).
  const ariaState: NonNullable<BindingHints['ariaState']> = {};
  if (node.ariaExpanded !== undefined) ariaState.expanded = node.ariaExpanded;
  if (node.ariaPressed !== undefined) ariaState.pressed = node.ariaPressed;
  if (node.checked !== undefined) ariaState.checked = node.checked;
  if (node.invalid !== undefined) ariaState.invalid = node.invalid;
  if ((node as any).ariaCurrent) ariaState.current = (node as any).ariaCurrent;
  if (typeof (node as any).ariaValueNow === 'number') ariaState.valueNow = (node as any).ariaValueNow;
  if ((node as any).ariaValueText) ariaState.valueText = (node as any).ariaValueText;
  if (Object.keys(ariaState).length > 0) hints.ariaState = ariaState;

  return hints;
}

/**
 * Build a synthetic `recordedFingerprint` from a live LLM-resolved node.
 *
 * MOTIVATION
 * ──────────
 * Manually-added steps (created via "+ Add new step" in the editor instead
 * of via Recording) start life with **only a description**. They have no
 * `recordedFingerprint` because no recorder probe ran for them. After the
 * first successful apply the LLM picks a candidate and we know — at that
 * moment — exactly which DOM element the user's description meant. Without
 * this synthesis, that knowledge is lost: only `evidence.lastSuccessRef`
 * (a transient DOM counter, ≤60 min TTL) and `bindingHints` (semantic
 * label/role only) survive into the next run. Identity fast-path and the
 * fake-success guard both gate on `recordedFingerprint`, so manual steps
 * permanently miss those layers — every replay is description-driven LLM
 * roulette.
 *
 * This helper closes the gap by snapshotting the structural identity of
 * the resolved node and writing it into `step.recordedFingerprint` after
 * the first successful apply. From the second run onward, manual steps
 * benefit from the same identity-based shortcuts and guards as recorded
 * steps.
 *
 * Field shape mirrors `RecordingCaptureService.buildRecordedFingerprint`
 * so resolver and comparator code can read either origin transparently —
 * the synthetic and recorded variants share `TargetFingerprint`.
 *
 * Caller must only invoke this AFTER verifying the click had real effect
 * (url / dialog / aria / dom signal). Calling on a fake-success would
 * permanently anchor the step on the wrong element.
 */
function buildSyntheticFingerprintFromNode(node: InteractiveNode): TargetFingerprint {
  const fp: TargetFingerprint = {};
  if (node.tag) fp.tag = node.tag;
  if (node.role) fp.role = node.role;
  if (node.labelText) fp.labelText = node.labelText;
  if (node.ariaLabel) fp.ariaLabel = node.ariaLabel;
  if (node.testIdAttr) fp.testIdAttr = node.testIdAttr;
  if (node.placeholder) fp.placeholder = node.placeholder;
  if (node.boundingBox) fp.boundingBox = node.boundingBox;
  if (node.title) fp.title = node.title;
  if ((node as any).alt) fp.alt = (node as any).alt;
  if (node.text) fp.text = node.text;
  // V26: First text fragment as a single DOM unit (Angular Material card
  // pattern fix). Symmetric with collector + recorder. Without this line
  // synthetic fingerprints carried no fragment, so card-shaped targets
  // resolved through LLM never gained a stable text-locator on their
  // next compiled-plan rebuild.
  if ((node as any).firstTextFragment) fp.firstTextFragment = (node as any).firstTextFragment;
  // node.id is the live DOM id; only persist when it isn't a framework-
  // generated counter (mat-radio-3, mui-12, :r0:, etc.) so identity match
  // doesn't lock onto an unstable token. The probe path applies the same
  // filter via isDynamicId.
  if (node.id && !node.isDynamicId) fp.elementId = node.id;
  if (node.name) fp.name = node.name;
  if (node.inputType || node.type) fp.type = node.inputType || node.type;
  if ((node as any).cssClass) fp.cssClass = (node as any).cssClass;
  if ((node as any).href) fp.href = (node as any).href;
  if ((node as any).ariaControls) fp.ariaControls = (node as any).ariaControls;
  if ((node as any).vueScopeId) fp.vueScopeId = (node as any).vueScopeId;
  if (node.containerTitles && node.containerTitles.length > 0) {
    fp.containerTitles = node.containerTitles.slice(0, 3);
  }
  if (node.nearestLandmark) fp.nearestLandmark = node.nearestLandmark;
  if ((node as any).childTestId) fp.childTestId = (node as any).childTestId;
  if ((node as any).dataValue) fp.dataValue = (node as any).dataValue;
  if ((node as any).iconLabel) fp.iconLabel = (node as any).iconLabel;
  if ((node as any).svgIcon) fp.svgIcon = (node as any).svgIcon;
  if ((node as any).customElementTag) fp.customElementTag = (node as any).customElementTag;
  if ((node as any).bsToggle) fp.bsToggle = (node as any).bsToggle;
  if ((node as any).bsTarget) fp.bsTarget = (node as any).bsTarget;
  if ((node as any).ariaHasPopup) fp.ariaHasPopup = (node as any).ariaHasPopup;
  if ((node as any).ariaActiveDescendant) fp.ariaActiveDescendant = (node as any).ariaActiveDescendant;
  if ((node as any).dataRowKey) fp.dataRowKey = (node as any).dataRowKey;
  if ((node as any).nearestRowText) fp.nearestRowText = (node as any).nearestRowText;
  if (typeof (node as any).siblingIndex === 'number') fp.siblingIndex = (node as any).siblingIndex;
  if ((node as any).disabled !== undefined) fp.disabled = (node as any).disabled;
  if ((node as any).arrowDir) fp.arrowDir = (node as any).arrowDir;
  if ((node as any).ancestorSummary) fp.ancestorSummary = (node as any).ancestorSummary;
  const ariaState: NonNullable<TargetFingerprint['ariaState']> = {};
  if (node.ariaExpanded !== undefined) ariaState.expanded = node.ariaExpanded;
  if (node.ariaPressed !== undefined) ariaState.pressed = node.ariaPressed;
  if (node.checked !== undefined) ariaState.checked = node.checked;
  if (node.invalid !== undefined) ariaState.invalid = node.invalid;
  if ((node as any).ariaCurrent) ariaState.current = (node as any).ariaCurrent;
  if (typeof (node as any).ariaValueNow === 'number') ariaState.valueNow = (node as any).ariaValueNow;
  if ((node as any).ariaValueText) ariaState.valueText = (node as any).ariaValueText;
  if (Object.keys(ariaState).length > 0) fp.ariaState = ariaState;
  return fp;
}

// Apply-time intent→element audit lives in ./intent-resolve-audit.ts so the
// lint service can write through the same sink without circular imports.

const ACTION_TIMEOUT = STEP_APPLY_CONFIG.actionTimeoutMs;
const POST_ACTION_SETTLE_TIMEOUT = STEP_APPLY_CONFIG.postActionSettleTimeoutMs;

// V2: Action types that support state verification
const STATE_VERIFIABLE_ACTIONS = new Set(['check', 'uncheck', 'toggle', 'open', 'close', 'type', 'click', 'upload']);

// V11: Actions that don't target elements — skip modal check
const NON_TARGETING_ACTIONS = new Set(['navigate', 'wait', 'timeout', 'scroll', 'wait_for', 'ai_check', 'wait_for_email', 'dialog', 'download']);

// Actions that mutate DOM and require a fresh snapshot for the next step's lint.
// After these, we invalidate the cached snapshot so hover→click sequences get fresh nodes.
const DOM_MUTATING_ACTIONS = new Set(['hover', 'click', 'open', 'close', 'toggle', 'dblclick', 'contextmenu', 'drag_and_drop']);

/**
 * V15.3: Actions whose Playwright call uses `noWaitAfter: true` to skip the 15-30s
 * internal stability wait. Because the action returns the instant the event dispatches
 * (before any triggered animation settles), we add a tiny 1s safety buffer so event
 * handlers get to run before we invalidate the snapshot cache and hand off to lookahead.
 * Anything not in this set keeps the old (full) post-action behaviour.
 */
const POST_ACTION_BUFFER_ACTIONS = new Set(['click', 'dblclick', 'contextmenu', 'press', 'type', 'toggle', 'check', 'uncheck', 'open', 'close']);

/**
 * Cap (ms) for the live identity probe used by the compiled fast-path
 * recorded-identity guard. The element was just resolved, so the probe is fast;
 * on timeout `probeIdentity` returns null → guard fails open (never blocks a hit).
 */
const RECORDED_IDENTITY_PROBE_CAP_MS = 1000;

/**
 * V11: Detect if a modal/popup/overlay is currently blocking the page.
 * Uses cached domNodes from session (no extra snapshot collection).
 * Returns modal info if detected, null otherwise.
 */
function detectModalBlockingFromSession(
  previewSessionId: string,
  userId: string,
): { modalRef: string; modalText?: string; boundingBox?: { x: number; y: number; width: number; height: number } } | null {
  const sessionService = getPreviewSessionService();
  const session = sessionService.getSession(previewSessionId);
  if (!session) return null;

  const domNodes = session.pageState?.domNodes;
  if (!domNodes || domNodes.length === 0) return null;

  // Check if any node is flagged as inside active modal (set by snapshot collector)
  const hasModalElements = domNodes.some(n => n.isInsideActiveModal === true);
  if (!hasModalElements) return null;

  // Find the modal container node itself (dialog/alertdialog/or highest z-index positioned element)
  const modalNode = domNodes.find(n =>
    n.isVisible &&
    (n.role === 'dialog' || n.role === 'alertdialog' || n.tag === 'dialog')
  );

  // Build modal text from elements inside it
  const modalElements = domNodes.filter(n => n.isInsideActiveModal === true);
  const modalText = modalElements
    .map(n => n.text || n.ariaLabel || n.labelText || '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 200);

  return {
    modalRef: modalNode?.ref || modalElements[0]?.ref || 'unknown',
    modalText: modalText || undefined,
    boundingBox: modalNode?.boundingBox || undefined,
  };
}

/**
 * V13: Ground-truth verification of modal blocking via browser hit-testing.
 *
 * The snapshot collector's modal detector is a heuristic (position/z-index/coverage).
 * It produces false positives on onboarding cards, floating chats, toasts, and other
 * fixed-position UI that is visually separated from the target element.
 *
 * This function asks the browser directly: "is my target actually covered by the
 * suspected modal?" using three independent geometric signals, any one of which
 * is sufficient to clear the block:
 *
 *   1. CONTAINMENT — target is a descendant of the modal node (target IS inside it).
 *   2. HIT-TEST    — pixel at target's visible center resolves to target/ancestor/descendant.
 *   3. DISJOINT    — bounding boxes of target and modal do not intersect at all.
 *
 * All three checks run inside a single page.evaluate() so there is no hardcoded
 * allowlist, no element-type assumptions, no size thresholds. It works for
 * dropdowns, popovers, onboarding tooltips, chat widgets, cookie banners, and
 * any future UI pattern — because the browser itself is the source of truth.
 *
 * Returns:
 *   - `blocked: false, reason: ...` when the target is reachable (proceed with action)
 *   - `blocked: true, occludingText: ...` when the target is genuinely covered (surface error)
 */
async function verifyModalActuallyBlocks(
  page: Page,
  candidateRefs: string[],
  modalRef: string,
): Promise<{ blocked: boolean; reason: string; occludingText?: string }> {
  if (candidateRefs.length === 0) {
    return { blocked: true, reason: 'no_candidates' };
  }

  try {
    const result = await page.evaluate(
      ({ refs, modalRef: mRef }) => {
        // Browser context — pull DOM globals through `globalThis` to avoid
        // server tsconfig noise (no `lib: ["dom"]` in the Node build).
        const g = globalThis as unknown as {
          document: {
            querySelector: (sel: string) => unknown;
            elementFromPoint: (x: number, y: number) => unknown;
          };
          innerWidth: number;
          innerHeight: number;
          getComputedStyle: (el: unknown) => { display: string; visibility: string };
          ShadowRoot: new () => unknown;
        };
        type El = {
          contains: (other: unknown) => boolean;
          getBoundingClientRect: () => { left: number; top: number; right: number; bottom: number; width: number; height: number };
          getRootNode: () => unknown;
          textContent: string | null;
          tagName: string;
        };
        const docQuery = (sel: string): El | null => (g.document.querySelector(sel) as El | null);

        const modal = docQuery(`[data-agent-ref="${mRef}"]`);
        if (!modal) return { blocked: false, reason: 'modal_gone' as const };

        const modalRect = modal.getBoundingClientRect();

        // Scratchpad lives on globalThis so it survives across candidate iterations.
        const scratch = g as unknown as { __lastOccluder?: string };

        // Track whether ANY candidate was actually evaluated end-to-end.
        // If every candidate bailed early (not in main frame, off-screen, detached)
        // we must NOT report "all occluded" — defer to Playwright's actionability.
        let anyCandidateEvaluated = false;

        // Check every candidate — if ANY one is reachable, the block is false-positive.
        for (const ref of refs) {
          const target = docQuery(`[data-agent-ref="${ref}"]`);
          // Ref not in main frame (likely iframe/shadow-DOM lint candidate) —
          // can't hit-test from here. Skip and let Playwright resolve it.
          if (!target) continue;

          // Signal 1: CONTAINMENT — target lives inside the modal.
          // (Covers self-inclusion: modal.contains(modal) === true in DOM.)
          if (target === modal || modal.contains(target)) {
            return { blocked: false, reason: 'target_inside_modal' as const, matchedRef: ref };
          }

          // Target must be visible and laid out for geometric checks.
          const tRect = target.getBoundingClientRect();
          if (tRect.width === 0 || tRect.height === 0) continue;

          const style = g.getComputedStyle(target);
          if (style.display === 'none' || style.visibility === 'hidden') continue;

          // Signal 2: DISJOINT — bounding boxes do not intersect.
          // If the modal lives in a completely different region of the viewport,
          // it cannot possibly be blocking this target.
          const disjoint =
            tRect.right  <= modalRect.left  ||
            tRect.left   >= modalRect.right ||
            tRect.bottom <= modalRect.top   ||
            tRect.top    >= modalRect.bottom;
          if (disjoint) {
            return { blocked: false, reason: 'disjoint_regions' as const, matchedRef: ref };
          }

          // Signal 3: HIT-TEST — ask the browser what is actually at the target's pixels.
          // Sample the center plus four inset points to survive partial occlusions
          // (e.g. a tooltip tail covering the dead-center of a button).
          const cx = tRect.left + tRect.width / 2;
          const cy = tRect.top + tRect.height / 2;
          const vw = g.innerWidth;
          const vh = g.innerHeight;

          const inset = 2;
          const samplePoints: Array<[number, number]> = (
            [
              [cx, cy],
              [tRect.left + inset,  tRect.top + inset],
              [tRect.right - inset, tRect.top + inset],
              [tRect.left + inset,  tRect.bottom - inset],
              [tRect.right - inset, tRect.bottom - inset],
            ] as Array<[number, number]>
          ).filter(([x, y]) => x >= 0 && x <= vw && y >= 0 && y <= vh);

          // Target is laid out but all sample points fall outside the viewport —
          // it just needs scrolling. Let Playwright auto-scroll and retry; do NOT
          // report a block based on a target we never actually hit-tested.
          if (samplePoints.length === 0) {
            return { blocked: false, reason: 'needs_scroll' as const, matchedRef: ref };
          }

          // Past this point the candidate is fully evaluated.
          anyCandidateEvaluated = true;

          let reachableSamples = 0;
          let firstOccluder: El | null = null;
          for (const [x, y] of samplePoints) {
            const hit = g.document.elementFromPoint(x, y) as El | null;
            if (!hit) continue;
            // Target itself, or related by the DOM tree — reachable.
            if (hit === target || target.contains(hit) || hit.contains(target)) {
              reachableSamples++;
              continue;
            }
            // Shadow DOM host of the target also counts as reachable.
            const root = target.getRootNode() as { host?: El } | null;
            if (root && root instanceof (g.ShadowRoot as unknown as { new (): unknown }) && root.host === hit) {
              reachableSamples++;
              continue;
            }
            if (!firstOccluder) firstOccluder = hit;
          }

          // At least one sample reaching the target is enough — user can click it.
          if (reachableSamples > 0) {
            return { blocked: false, reason: 'hit_test_reachable' as const, matchedRef: ref };
          }

          // This candidate is geometrically blocked. Record the occluder but
          // keep scanning other candidates — lint may have ranked an unreachable
          // candidate first while a reachable sibling exists.
          if (firstOccluder) {
            const occluderText = (firstOccluder.textContent || '').trim().slice(0, 80);
            const occluderTag = firstOccluder.tagName.toLowerCase();
            scratch.__lastOccluder = occluderText || occluderTag;
          }
        }

        // If no candidate was actually hit-tested (all refs missing from main frame,
        // all zero-sized, all display:none), we have zero evidence of blocking —
        // defer to Playwright's own actionability checks.
        if (!anyCandidateEvaluated) {
          delete scratch.__lastOccluder;
          return { blocked: false, reason: 'no_evaluable_candidates' as const };
        }

        // Every evaluated candidate failed the hit-test and none was disjoint/contained.
        const occluder = scratch.__lastOccluder;
        delete scratch.__lastOccluder;
        return { blocked: true, reason: 'all_candidates_occluded' as const, occludingText: occluder };
      },
      { refs: candidateRefs, modalRef },
    );

    return result as { blocked: boolean; reason: string; occludingText?: string };
  } catch (err) {
    // Browser eval failed (page navigating, frame detached, etc.) —
    // fail open: let the action attempt proceed. Playwright has its own
    // actionability checks and will surface a real error if it cannot click.
    logger.debug('[PREVIEW_APPLY] verifyModalActuallyBlocks eval failed, failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { blocked: false, reason: 'eval_failed_fail_open' };
  }
}

/**
 * V16: Promo-banner / floating-overlay detection (no ARIA signature required).
 *
 * `verifyModalActuallyBlocks` is the ground-truth hit-test but today it only
 * runs when `detectModalBlockingFromSession` produces a modal — and that helper
 * needs the snapshot collector to have flagged something as `isInsideActiveModal`.
 * Fixed-position promo banners ("пробный урок - 50%" + "Подробнее" at the
 * bottom of the viewport) never receive that flag, so the modal gate never
 * opens and Playwright ends up retrying a covered target for 40s before the
 * user sees any feedback.
 *
 * This helper closes that gap. Given resolved candidates (what the user is
 * trying to click), find a plausible overlay node from the cached domNodes:
 * anything visible with `isTopMostAtCenter === true` that is NOT an ancestor
 * of, descendant of, or identical to the candidate. Then let
 * `verifyModalActuallyBlocks` do its three-signal hit-test against the best
 * such overlay to confirm the block geometrically.
 *
 * Returns an overlay record compatible with `modalBlocking` when a block is
 * confirmed by the browser; null otherwise.
 */
async function detectOverlayBlockingCandidate(
  page: Page,
  previewSessionId: string,
  candidateRefs: string[],
): Promise<{ modalRef: string; modalText?: string; boundingBox?: { x: number; y: number; width: number; height: number }; occludingText?: string } | null> {
  if (candidateRefs.length === 0) return null;

  const sessionService = getPreviewSessionService();
  const session = sessionService.getSession(previewSessionId);
  const domNodes = session?.pageState?.domNodes;
  if (!domNodes || domNodes.length === 0) return null;

  const candidateSet = new Set(candidateRefs);
  const candidateAncestors = new Set<string>();
  for (const ref of candidateRefs) {
    const node = domNodes.find(n => n.ref === ref);
    for (const anc of node?.parentRefChain || []) candidateAncestors.add(anc);
  }

  // Pick overlay candidates: visible, topmost at center, not the target itself
  // and not related by DOM hierarchy. Sort by area (largest first) — a big
  // bottom banner that covers multiple targets is a better culprit than a
  // 24px close button.
  const overlayCandidates = domNodes
    .filter(n =>
      n.isVisible === true &&
      n.isTopMostAtCenter === true &&
      n.ref && !candidateSet.has(n.ref) && !candidateAncestors.has(n.ref) &&
      !!n.boundingBox && n.boundingBox.width > 0 && n.boundingBox.height > 0,
    )
    .sort((a, b) => {
      const aArea = (a.boundingBox!.width * a.boundingBox!.height);
      const bArea = (b.boundingBox!.width * b.boundingBox!.height);
      return bArea - aArea;
    })
    .slice(0, 5); // cap — hit-test each one

  if (overlayCandidates.length === 0) return null;

  for (const overlay of overlayCandidates) {
    if (!overlay.ref) continue;
    const verdict = await verifyModalActuallyBlocks(page, candidateRefs, overlay.ref);
    if (!verdict.blocked) continue;

    // Build a human-readable label for the overlay. Prefer the richest nearby
    // text — a bare "Закрыть" is less informative than "пробный урок - 50% /
    // Подробнее". Pull text from the overlay itself plus its immediate
    // neighbours that share `isTopMostAtCenter`.
    const neighbours = domNodes
      .filter(n =>
        n.ref !== overlay.ref &&
        n.isTopMostAtCenter === true &&
        n.isVisible === true &&
        !candidateSet.has(n.ref || '') &&
        (n.text || n.ariaLabel || n.labelText),
      )
      .slice(0, 4);
    const label = [overlay.text, ...neighbours.map(n => n.text || n.ariaLabel || n.labelText)]
      .filter(Boolean)
      .join(' / ')
      .slice(0, 120);

    return {
      modalRef: overlay.ref,
      modalText: label || verdict.occludingText || undefined,
      boundingBox: overlay.boundingBox,
      occludingText: verdict.occludingText,
    };
  }

  return null;
}

/**
 * Generate a random integer in range [min, max] (inclusive).
 */
function randomIntInclusive(min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Classify navigation errors into user-friendly messages.
 * Replaces raw Playwright TimeoutError with actionable descriptions.
 */
function classifyNavigationError(error: Error, url: string): string {
  const msg = error.message.toLowerCase();
  if (msg.includes('net::err_name_not_resolved'))
    return `Domain not found — check the URL: ${url}`;
  if (msg.includes('net::err_connection_refused'))
    return `Connection refused — the site may be down: ${url}`;
  if (msg.includes('net::err_connection_timed_out'))
    return `Connection timed out — the server is not responding: ${url}`;
  if (msg.includes('net::err_cert') || msg.includes('net::err_ssl'))
    return `SSL certificate error for: ${url}`;
  if (msg.includes('net::err_internet_disconnected') || msg.includes('net::err_network'))
    return `Network error — check your internet connection`;
  if (msg.includes('net::err_aborted'))
    return `Navigation was aborted: ${url}`;
  if (msg.includes('timeout'))
    return `Site did not finish loading within timeout. The website may be slow or unresponsive: ${url}`;
  return error.message;
}

/**
 * Best-effort: sleep for ms using Playwright timers.
 * (We use this for "human-like" micro-pauses only.)
 */
async function sleepMs(page: Page, ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return;
  await page.waitForTimeout(ms);
}

/**
 * With probability `chance` (0..1), wait a random duration within [minMs, maxMs].
 */
async function maybeRandomPause(
  page: Page,
  chance: number,
  minMs: number,
  maxMs: number
): Promise<void> {
  if (!Number.isFinite(chance) || chance <= 0) return;
  if (Math.random() > Math.min(1, chance)) return;
  const ms = randomIntInclusive(minMs, maxMs);
  await sleepMs(page, ms);
}

/**
 * Convert a wait_for glob pattern to regex string.
 * Robust parser:
 * - *  => [^/]* (single segment wildcard)
 * - ** => .*    (cross-segment wildcard)
 * - ?  => .     (single-char wildcard)
 * - \* \? \\ and any escaped char are treated as literals
 */
export function globToRegexPatternForWaitFor(glob: string): string {
  const escapeRegexChar = (char: string): string => {
    return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  };

  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const next = i + 1 < glob.length ? glob[i + 1] : '';

    // Escaped char: treat next char as literal (including *, ?, \).
    if (ch === '\\') {
      if (next) {
        pattern += escapeRegexChar(next);
        i++;
      } else {
        // Trailing backslash should be matched literally.
        pattern += '\\\\';
      }
      continue;
    }

    if (ch === '*' && next === '*') {
      pattern += '.*';
      i++;
      continue;
    }
    if (ch === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (ch === '?') {
      pattern += '.';
      continue;
    }

    pattern += escapeRegexChar(ch);
  }

  return pattern;
}

/**
 * Normalize value for "type" action without trimming user input.
 */
export function normalizeTypeActionValue(rawValue: string | undefined): string {
  return rawValue ?? '';
}

/**
 * V13: Wait for the page's mutation rate to drop to a baseline — i.e. the
 * action-driven burst of DOM changes has ended, even if background widgets
 * (live tickers, chat feeds, animation loops, analytics pixels) keep the
 * DOM from ever being absolutely quiet.
 *
 * Rather than requiring absolute silence for N ms (the previous approach,
 * which never returned true on sites with live widgets), this measures the
 * *rate* of mutations inside rolling 200 ms windows and returns true once
 * the current window's count is ≤ max(2, baseline * 1.5).
 *
 * How baseline is established:
 *   • First 400 ms = "observation burst" — we record whatever the action
 *     triggered (likely the highest mutation rate of the whole wait).
 *   • From 400 ms onward, we track the LOWEST 200 ms window seen so far
 *     as the baseline — that is the site's steady-state mutation rate.
 *   • The moment a fresh 200 ms window returns to ≤1.5× baseline (or ≤2
 *     mutations regardless of baseline, for genuinely quiet sites), we
 *     declare settled.
 *
 * This adapts per-page automatically: a static page settles on zero
 * mutations; a site with a 10-Hz ticker settles once the ticker's own
 * cadence resumes after the action's burst. No hardcoded thresholds tied
 * to element types, paths, or site identities.
 *
 * Returns true on settle, false on timeout. Never throws.
 */
async function waitForPageSettled(
  page: Page,
  timeoutMs: number,
  _quietMs: number = 500, // kept for API compat; unused in rate-based impl
): Promise<boolean> {
  void _quietMs;
  try {
    await page.waitForFunction(
      () => {
        type SettleState = {
          observer: { disconnect: () => void };
          mutationsInCurrentWindow: number;
          currentWindowStart: number;
          baseline: number | null;
          startedAt: number;
        };
        const g = globalThis as unknown as {
          __qaitSettleState?: SettleState;
          document: { body: unknown };
          MutationObserver: new (cb: (records: unknown[]) => void) => {
            observe: (target: unknown, opts: unknown) => void;
            disconnect: () => void;
          };
          performance: { now: () => number };
        };

        const WINDOW_MS = 200;
        const OBSERVATION_BURST_MS = 400; // let the action's burst pass first
        const ABSOLUTE_QUIET = 2; // ≤ this per window → settled regardless of baseline
        const BASELINE_MULT = 1.5;

        const now = g.performance.now();

        if (!g.__qaitSettleState) {
          const state: SettleState = {
            observer: null as unknown as SettleState['observer'],
            mutationsInCurrentWindow: 0,
            currentWindowStart: now,
            baseline: null,
            startedAt: now,
          };
          const obs = new g.MutationObserver((records) => {
            state.mutationsInCurrentWindow += records.length;
          });
          obs.observe(g.document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          state.observer = obs;
          g.__qaitSettleState = state;
          return false;
        }

        const state = g.__qaitSettleState;
        const elapsedWindow = now - state.currentWindowStart;
        if (elapsedWindow < WINDOW_MS) return false;

        // Window closed — evaluate.
        const windowCount = state.mutationsInCurrentWindow;
        const elapsedTotal = now - state.startedAt;

        // Reset for next window BEFORE checking exit conditions so we never
        // double-count and always start the next window from zero.
        state.mutationsInCurrentWindow = 0;
        state.currentWindowStart = now;

        // Absolute-quiet fast path: static or nearly-static page.
        if (windowCount <= ABSOLUTE_QUIET) {
          try { state.observer.disconnect(); } catch { /* noop */ }
          delete g.__qaitSettleState;
          return true;
        }

        // Still in the observation burst — don't sample baseline yet.
        if (elapsedTotal < OBSERVATION_BURST_MS) return false;

        // Establish / refine baseline as the lowest post-burst window.
        if (state.baseline === null || windowCount < state.baseline) {
          state.baseline = windowCount;
        }

        // Settled when this window is no worse than 1.5× the observed baseline.
        const threshold = Math.max(ABSOLUTE_QUIET, Math.ceil(state.baseline * BASELINE_MULT));
        if (windowCount <= threshold) {
          try { state.observer.disconnect(); } catch { /* noop */ }
          delete g.__qaitSettleState;
          return true;
        }

        return false;
      },
      undefined,
      { timeout: timeoutMs, polling: 100 },
    );
    return true;
  } catch {
    // Clean up leftover observer on timeout.
    await page.evaluate(() => {
      const g = globalThis as unknown as { __qaitSettleState?: { observer: { disconnect: () => void } } };
      if (g.__qaitSettleState?.observer) {
        try { g.__qaitSettleState.observer.disconnect(); } catch { /* noop */ }
        delete g.__qaitSettleState;
      }
    }).catch(() => { /* noop */ });
    return false;
  }
}

/**
 * V5: Execute wait_for using SPA-safe approach (page.waitForFunction)
 * Works for both full navigations AND SPA client-side routing (React Router, Next.js, etc.)
 *
 * Matcher precedence:
 * 1. changedFrom: wait until URL != changedFrom value (used by auto-insert)
 * 2. regex: match URL against regex pattern
 * 3. glob: match URL against glob pattern (converted to regex)
 * 4. substring: URL contains substring
 * 5. domain: URL domain equals value (strict host match)
 *
 * @param page Playwright Page
 * @param matcher UrlMatcher configuration
 * @param timeoutMs Timeout in milliseconds
 * @param isAutoInjected V13: when true, fall back to page-settle signal on changedFrom timeout
 *                             (recorded URL change may not reproduce at replay — e.g. i18n switchers)
 */
async function executeWaitFor(
  page: Page,
  matcher: UrlMatcher | undefined,
  timeoutMs: number,
  isAutoInjected: boolean = false,
): Promise<{ success: boolean; error?: string; degraded?: 'page_settled' }> {
  try {
    if (!matcher) {
      // No matcher specified - simple wait for duration (like 'wait' action)
      logger.debug('[WAIT_FOR] No URL matcher specified, waiting for duration', { timeoutMs });
      await page.waitForTimeout(timeoutMs);
      return { success: true };
    }

    // Recover from misconfigured / legacy steps where the recorder created a
    // wait_for with `urlMatcher` but no predicate (no changedFrom / regex /
    // glob / substring / domain). Without this, line 993 below would return
    // success in microseconds and the next step would race the actual SPA
    // redirect — which is exactly the 1ms wait_for + 41s click hang we saw on
    // hub.atk.pro and juz40-edu.kz logs (April 2026). Promote the empty
    // matcher to a `changedFrom: <current URL>` so the slow path actually
    // waits for the URL to change.
    //
    // Budget treatment: a legacy/empty matcher carries NO user intent about
    // URL change (the user just dropped a "Wait for URL" placeholder between
    // clicks for safety). Treat it as auto-injected for budget purposes —
    // 2s URL wait + 3s settle fallback (up to 5s total) instead of the
    // manual budget (≈timeoutMs - 1.5s URL wait + 1.5s settle, capping near
    // the full timeout). This caps the worst-case impact to 2s on legacy
    // tests where the URL genuinely never changes, while still giving a
    // fair shot at catching an actual SPA redirect.
    const hasPredicate = !!(
      matcher.changedFrom
      || matcher.regex
      || matcher.glob
      || matcher.substring
      || matcher.domain
    );
    let recoveredFromEmptyMatcher = false;
    if (!hasPredicate) {
      const currentUrl = page.url();
      logger.warn('[WAIT_FOR] urlMatcher has no predicate — recovering with changedFrom=currentUrl', {
        currentUrl,
        timeoutMs,
        isAutoInjected,
      });
      matcher = { ...matcher, changedFrom: currentUrl };
      recoveredFromEmptyMatcher = true;
    }

    const negate = matcher.negate ?? false;
    const caseSensitive = matcher.caseSensitive ?? false;

    // Build predicate based on matcher type
    // Priority: changedFrom > regex > glob > substring > domain

    if (matcher.changedFrom) {
      // Wait until URL changes from the specified value
      const prevUrl = matcher.changedFrom;

      // V13: Split the total budget between two signals — URL change (primary)
      // and page-settle (fallback). This is NOT hardcoded-per-flag; it is a
      // universal answer to the question: "the recorded action changed the
      // URL but replay isn't changing it — what should we do?"
      //
      // Why this works for both manual and auto-injected:
      //   • Auto-injected steps exist to stabilize replay after ambiguous
      //     actions. When the recorded URL change doesn't reproduce (i18n
      //     toggle, feature flag, A/B bucket, cached state, legacy record
      //     before this code existed), we must not block the whole run.
      //   • Manual steps expressing URL intent get the full primary budget;
      //     the fallback only engages in the final slice. If the page is
      //     genuinely hung, settle fails and the timeout surfaces correctly.
      //     If the page is quiet but URL didn't change, that's almost always
      //     a recorder/app mismatch — degraded success is the right call.
      //
      // Budget split:
      //   auto-injected: 2s URL wait, up to 3s settle fallback (fast-degrade)
      //   manual:        (timeoutMs - 1.5s) URL wait, 1.5s settle fallback (min 500ms URL)
      // Why manual gets a smaller fallback: a user-written wait_for for URL change
      // is a contract; hiding a broken auth/redirect/nav behind "page settled" is
      // far worse than surfacing it. We still keep a tiny safety net for tests
      // recorded before this code existed (historical steps without isAutoInjected).
      // `recoveredFromEmptyMatcher` shares the auto-injected budget profile:
      // both are "we synthesised this matcher because the user/recorder
      // didn't tell us what to wait for" — fast-degrade is the right
      // policy. Without this, a manual "Wait for URL" placeholder on a
      // page where URL genuinely never changes would burn (timeoutMs - 1.5s)
      // before degrading; bumping to the auto-injected profile caps that
      // to 2s URL wait, then up to 3s page-settle fallback.
      const fastDegrade = isAutoInjected || recoveredFromEmptyMatcher;
      const SETTLE_MAX_MS = fastDegrade ? 3000 : 1500;
      const urlWaitBudget = fastDegrade
        ? Math.min(2000, timeoutMs)
        : Math.max(500, timeoutMs - SETTLE_MAX_MS);

      try {
        await page.waitForFunction(
          (prev: string) => String((globalThis as unknown as { location?: { href?: string } }).location?.href ?? '') !== prev,
          prevUrl,
          { timeout: urlWaitBudget }
        );
        logger.debug('[WAIT_FOR_URL] URL changed from previous value', {
          prevUrl,
          newUrl: page.url(),
        });
        return { success: true };
      } catch (urlWaitErr) {
        // V13: Cross-origin navigation short-circuit.
        // When a click leads to another origin, Playwright tears down the
        // old execution context and waitForFunction throws with a non-timeout
        // error ("Execution context was destroyed", "frame was detached", etc.).
        // That destruction IS the URL change we were waiting for — re-read
        // page.url() and compare; if it moved, we succeed immediately instead
        // of degrading into the settle fallback.
        const errMsg = urlWaitErr instanceof Error ? urlWaitErr.message : String(urlWaitErr);
        const isContextLost =
          /execution context was destroyed/i.test(errMsg) ||
          /frame was detached/i.test(errMsg) ||
          /target closed/i.test(errMsg) ||
          /navigation/i.test(errMsg);
        if (isContextLost) {
          // Give the new context a beat to expose its URL, then check.
          await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => { /* noop */ });
          const postCrashUrl = page.url();
          if (postCrashUrl && postCrashUrl !== prevUrl) {
            logger.info('[WAIT_FOR_URL] URL change detected via context-lost short-circuit', {
              prevUrl,
              newUrl: postCrashUrl,
              reason: errMsg.slice(0, 120),
            });
            return { success: true };
          }
        }

        // Primary signal (URL change) timed out — try the fallback (page settle).
        const remaining = Math.max(500, timeoutMs - urlWaitBudget);
        const settleBudget = Math.min(remaining, SETTLE_MAX_MS);

        const enterFn = isAutoInjected ? logger.info : logger.warn;
        enterFn('[WAIT_FOR_URL] URL change not observed, attempting page-settle fallback', {
          prevUrl,
          currentUrl: page.url(),
          isAutoInjected,
          urlWaitBudget,
          settleBudget,
        });

        const settled = await waitForPageSettled(page, settleBudget, 500);
        if (settled) {
          // Best-effort short networkidle on top of DOM settle.
          await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => { /* noop */ });
          // Manual wait_for degraded → loud error log. A user-written URL-change
          // contract silently succeeded via the fallback, which likely masks a
          // broken redirect/auth/nav. Auto-injected → info (expected path).
          // Recovered-from-empty matcher → info too: there was no contract
          // because the matcher had no predicate; we synthesised one so the
          // step doesn't return success in 1ms, but degrading to page-settle
          // is the expected outcome on stable pages.
          const isSoftFallback = isAutoInjected || recoveredFromEmptyMatcher;
          const exitFn = isSoftFallback ? logger.info : logger.error;
          exitFn('[WAIT_FOR_URL] wait_for resolved via page-settle fallback (URL unchanged but page quiet)', {
            prevUrl,
            currentUrl: page.url(),
            isAutoInjected,
            recoveredFromEmptyMatcher,
            hint: isSoftFallback
              ? undefined
              : 'Manual wait_for expected URL change but page settled without navigating. This may mask a broken redirect or auth flow — verify the action under test.',
          });
          return { success: true, degraded: 'page_settled' };
        }

        // Page never settled — genuine hang. Surface the original timeout.
        logger.warn('[WAIT_FOR_URL] Neither URL change nor page settle observed', {
          prevUrl,
          currentUrl: page.url(),
          isAutoInjected,
        });
        throw urlWaitErr;
      }
    }

    if (matcher.regex) {
      const pattern = matcher.regex;
      const flags = caseSensitive ? '' : 'i';
      await page.waitForFunction(
        ({ pattern, flags, negate }: { pattern: string; flags: string; negate: boolean }) => {
          const re = new RegExp(pattern, flags);
          const href = String((globalThis as any).location?.href ?? '');
          const matches = re.test(href);
          return negate ? !matches : matches;
        },
        { pattern, flags, negate: negate },
        { timeout: timeoutMs }
      );
      return { success: true };
    }

    if (matcher.glob) {
      const pattern = globToRegexPatternForWaitFor(matcher.glob);
      const flags = caseSensitive ? '' : 'i';
      await page.waitForFunction(
        ({ pattern, flags, negate }: { pattern: string; flags: string; negate: boolean }) => {
          const re = new RegExp(pattern, flags);
          const href = String((globalThis as any).location?.href ?? '');
          const matches = re.test(href);
          return negate ? !matches : matches;
        },
        { pattern, flags, negate: negate },
        { timeout: timeoutMs }
      );
      return { success: true };
    }

    if (matcher.substring) {
      const sub = matcher.substring;
      await page.waitForFunction(
        ({ sub, caseSensitive, negate }: { sub: string; caseSensitive: boolean; negate: boolean }) => {
          const hrefRaw = String((globalThis as any).location?.href ?? '');
          const url = caseSensitive ? hrefRaw : hrefRaw.toLowerCase();
          const search = caseSensitive ? sub : sub.toLowerCase();
          const matches = url.includes(search);
          return negate ? !matches : matches;
        },
        { sub, caseSensitive, negate: negate },
        { timeout: timeoutMs }
      );
      return { success: true };
    }

    if (matcher.domain) {
      const domain = matcher.domain;
      await page.waitForFunction(
        ({ domain, caseSensitive, negate }: { domain: string; caseSensitive: boolean; negate: boolean }) => {
          const hostRaw = String((globalThis as any).location?.hostname ?? '');
          const host = caseSensitive ? hostRaw : hostRaw.toLowerCase();
          const target = caseSensitive ? domain : domain.toLowerCase();
          const matches = host === target;
          return negate ? !matches : matches;
        },
        { domain, caseSensitive, negate: negate },
        { timeout: timeoutMs }
      );
      return { success: true };
    }

    // No specific matcher - return success
    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('[WAIT_FOR_URL] Timeout or error waiting for URL', {
      matcher,
      timeoutMs,
      error: msg,
    });
    return { success: false, error: `wait_for timed out or failed: ${msg}` };
  }
}

/**
 * Result of step application (V2: enhanced)
 */
interface ApplyResult {
  success: boolean;
  error?: string;
  appliedStep?: IntentStep;
  urlChanged?: boolean;
  url?: string;
  highlight?: Array<{
    ref?: string;
    boundingBox?: { x: number; y: number; width: number; height: number };
    type: 'success' | 'warning' | 'error';
  }>;
  attempts?: number;
  /** V2: Whether action was verified post-execution */
  verified?: boolean;
  /**
   * Click-effect verification signal that proved the click did something.
   * Surfaced so callers (preview_run trace, regression replay) can audit
   * whether `verified: true` is backed by a strong signal (url/dialog/aria/
   * detach/dom/newtab) or a weak one (focus). Without this, "passed" is
   * indistinguishable from "fake-passed" — focus-only successes look the
   * same as real navigations in run summaries.
   */
  clickEffectSignal?: 'url' | 'dialog' | 'aria' | 'focus' | 'detach' | 'dom' | 'newtab' | 'download' | 'none';
  /**
   * Identity of the element the resolver actually clicked. Without this we
   * can't tell whether "passed" landed on the recorded target or on a
   * neighbour with similar bounding box. A passed step with chosenRef
   * pointing at a different element than the recorded fingerprint is the
   * canonical fake-success signature.
   */
  chosenRef?: string;
  chosenLabel?: string;
  chosenBoundingBox?: { x: number; y: number; width: number; height: number };
  /**
   * Did the chosen element match the recorded fingerprint? A best-effort
   * heuristic comparing `id` (strong), `bbox` overlap (medium) and `tag`
   * (weak). 'mismatch' on a passed step is a strong fake-success signal
   * — replay clicked something, but not what was recorded.
   */
  fingerprintMatch?: 'id' | 'bbox' | 'tag' | 'no_recorded' | 'mismatch';
  /**
   * Which resolver path produced the candidate. Lets preview_run trace
   * distinguish between an identity fast-path hit (recorded id matched live
   * DOM) and an LLM/vision pick (semantic match), which is the difference
   * between "right element" and "model picked something nearby".
   */
  resolverPath?: import('./preview.types').LintResult['resolverPath'];
  /** V2: State change detected */
  stateChange?: {
    before?: Partial<InteractiveNode>;
    after?: Partial<InteractiveNode>;
  };
  /** V11: Modal/popup is blocking the target element */
  modalBlocking?: {
    modalRef: string;
    modalText?: string;
    boundingBox?: { x: number; y: number; width: number; height: number };
  };
  /** Compiled locator plan was tried but failed (stale plan, DOM changed) */
  compiledFailed?: boolean;
  /** V15: wait_for resolved via fast-path (URL already changed) and settled DOM before returning */
  fastPathSettled?: boolean;
  /**
   * Diagnostic only — wait_for decision branch, recorded so trace audits can
   * tell which path the step took and why it returned that fast.
   * - `fast_path`: changedFrom !== current → success without waiting
   * - `runtime_changed`: matcher had no changedFrom or current === changedFrom →
   *   slow path entered, returned via executeWaitFor URL change
   * - `runtime_settle`: slow path degraded to page-settle (auto-injected)
   * - `slow_path`: slow path executed normally
   */
  waitForBranch?: 'fast_path' | 'runtime_changed' | 'runtime_settle' | 'slow_path' | 'no_matcher';
  /** Diagnostic only — `matcher.changedFrom` value at apply time (recorded). */
  waitForChangedFrom?: string;
  /** Diagnostic only — `page.url()` value at the moment the wait_for branch was decided. */
  waitForUrlBefore?: string;
  /**
   * V23: Compact decision trace for postmortem comparison of two runs of the
   * same step. Lets you diff `run1.jsonl` vs `run2.jsonl` and immediately
   * see WHY identical steps produced different results — was compiled stale,
   * did identity fast-path miss, did LLM cache hit, was an overlay blocking,
   * etc. Surfaced into preview_run JSONL `step_result.decisionTrace`.
   *
   * All fields are optional — only populated for the path the step actually
   * took. Use `jq '.payload.decisionTrace' run.jsonl` for inspection.
   */
  decisionTrace?: StepDecisionTrace;
  /**
   * Etap 1D.1 — Plan quality signal for the frontend. Set when a compiled
   * plan was written but its build-time validation could not confirm any
   * locator (`compiled.unverified === true`). Forwarded to the WS apply
   * result payload so the editor can show an "unstable selectors" badge.
   *
   * Absent when the apply path didn't write a plan (soft-pass / non-
   * targeting / compiled-fast-path that didn't upgrade), and on hard
   * failures (success=false carries `error` instead).
   */
  planQuality?: {
    unverified: boolean;
    reason?: string;
  };
}

/**
 * V23: Per-step decision trace. One JSON blob per applied step that captures
 * the path through the resolver pipeline, the chosen element, the recorded
 * fingerprint, overlay block check, and timings. Designed for diff analysis
 * of two runs of the same step. Keep field set narrow on purpose — this
 * payload travels through preview_run JSONL on every step.
 */
interface StepDecisionTrace {
  /** Which resolver path produced the candidate that was actually clicked. */
  resolverPath?: import('./preview.types').LintResult['resolverPath'];
  /** Compiled fast-path diagnostic. */
  compiled?: {
    available: boolean;
    urlStale?: boolean;
    compiledPageUrl?: string;
    currentPageUrl?: string;
    locatorCount?: number;
    succeededStrategy?: string;
    succeededWithFingerprintMatch?: number;
    fellThroughTo?: 'lint' | 'click_no_effect' | 'click_failed' | 'postcondition' | 'skipped' | 'recorded_identity_mismatch' | null;
  };
  /** Identity fast-path diagnostic (id/testId/name match against live DOM). */
  identity?: {
    recordedId?: string;
    recordedTestId?: string;
    recordedName?: string;
    matched: boolean;
    matchType?: 'id' | 'testid' | 'name';
    liveIdsCount?: number;
    liveIdsSample?: string[];
  };
  /** Evidence shortcut (cached lastSuccessRef hit). */
  evidence?: {
    cachedRef?: string;
    cachedAtIso?: string;
    foundInLiveDom: boolean;
    bypassReason?: string;
  };
  /** LLM resolver decision (when path = 'llm' or 'vision'). */
  llm?: {
    cacheHit: boolean;
    latencyMs?: number;
    candidatesCount?: number;
    selectedRef?: string;
    confidence?: number;
    degraded?: boolean;
    degradedReason?: string;
  };
  /** Element actually clicked. Compare against `recorded` to spot drift. */
  chosen?: {
    ref?: string;
    tag?: string;
    role?: string;
    label?: string;
    text?: string;
    id?: string;
    testIdAttr?: string;
    bbox?: { x: number; y: number; width: number; height: number };
  };
  /** What the recorder captured (or compiled targetFingerprint). */
  recorded?: {
    tag?: string;
    role?: string;
    label?: string;
    text?: string;
    id?: string;
    testIdAttr?: string;
    bbox?: { x: number; y: number; width: number; height: number };
  };
  /** Same-element check after the click. */
  fingerprintMatch?: 'id' | 'testid' | 'bbox' | 'tag' | 'no_recorded' | 'mismatch';
  /** Pre-click overlay hit-test result. */
  overlayBlock?: {
    blocked: boolean;
    overlayRef?: string;
    overlayText?: string;
    diagnosisConfidence?: number;
    waitForSelector?: string;
    overlayDisappearedAfterWait?: boolean;
  };
  /** Click-effect verifier output. */
  clickEffectSignal?: 'url' | 'dialog' | 'aria' | 'focus' | 'detach' | 'dom' | 'newtab' | 'download' | 'none';
  /** Was this a soft-pass for manual-add no-effect (V23). */
  softPassedOnNoEffect?: boolean;
  /** Latency breakdown — helps spot which phase ate the budget. */
  timing?: {
    compiledMs?: number;
    lintMs?: number;
    llmMs?: number;
    actionMs?: number;
    verifyMs?: number;
    totalMs?: number;
  };
}

/**
 * Get locator context - either page or iframe
 * Handles iframe configuration if specified in step options
 */
function getLocatorContext(page: Page, step: IntentStep): Page | FrameLocator {
  if (step.options?.iframe?.selector) {
    logger.debug('[PREVIEW_APPLY] Using iframe context', {
      iframeSelector: step.options.iframe.selector,
    });
    return page.frameLocator(step.options.iframe.selector);
  }
  return page;
}

/**
 * V24 — Conditional parasitic-overlay dismisser.
 *
 * Closes overlays/popups that appeared as a side-effect of a REJECTED click
 * (i.e. our wrong-element guard fired, but the click already happened and
 * opened something paразitic). Critically, refuses to dismiss when:
 *   1. Overlay was already present BEFORE the click (legitimate user-recorded
 *      popup — closing it would break the test's intended flow).
 *   2. Caller didn't pass a pre-click snapshot (no way to tell legit from
 *      paразitic — fail-safe to "leave it alone").
 *
 * Strategy: Esc covers Material/Bootstrap/Headless UI menus; backdrop click
 * covers CDK overlays where Esc isn't bound. Both are no-ops when nothing's
 * open.
 */
async function dismissParasiticOverlay(
  page: Page,
  preState: ClickPreState | null,
  ctx: { previewSessionId: string; stepId: string; reason: string },
): Promise<{ dismissed: boolean; reason: string }> {
  if (!preState) return { dismissed: false, reason: 'no-pre-state' };
  // Compare overlay sig now vs before. If unchanged or shrunk, no parasitic
  // overlay was opened by our click. If the pre-sig was non-empty AND matches
  // current, the overlay was already there — refuse to dismiss.
  let currentOverlaySig = '';
  try {
    currentOverlaySig = await page.evaluate(() => {
      // @ts-expect-error - browser context
      const doc = document;
      const overlaySels = [
        '.cdk-overlay-pane',
        '.cdk-overlay-backdrop.cdk-overlay-backdrop-showing',
        '.modal.show',
        '.modal-backdrop.show',
        '[role="menu"]:not([hidden])',
        '[aria-modal="true"]',
      ];
      const parts: string[] = [];
      for (const sel of overlaySels) {
        const els = doc.querySelectorAll(sel);
        if (els.length > 0) parts.push(`${sel}=${els.length}`);
      }
      return parts.join('|');
    });
  } catch {
    return { dismissed: false, reason: 'sig-eval-failed' };
  }
  // No overlay now → nothing to dismiss.
  if (!currentOverlaySig) return { dismissed: false, reason: 'no-overlay-present' };
  // Overlay existed before and is identical now → it was the user's, leave it.
  if (preState.overlayPreSig && preState.overlayPreSig === currentOverlaySig) {
    return { dismissed: false, reason: 'overlay-pre-existed-leave-alone' };
  }
  // Else: overlay is new (or grew) → likely parasitic from our click.
  try {
    await page.keyboard.press('Escape', { delay: 0 }).catch(() => {});
    await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const doc = (globalThis as any).document;
      const sels = [
        '.cdk-overlay-backdrop.cdk-overlay-backdrop-showing',
        '.cdk-overlay-backdrop',
        '.modal-backdrop.show',
        '.modal-backdrop',
      ];
      for (const sel of sels) {
        const el = doc.querySelector(sel);
        if (el) { el.click?.(); break; }
      }
    }).catch(() => {});
    await page.waitForTimeout(250).catch(() => {});
    logger.info('[PREVIEW_APPLY] Cleared parasitic overlay', {
      previewSessionId: ctx.previewSessionId,
      stepId: ctx.stepId,
      reason: ctx.reason,
      preSig: preState.overlayPreSig.slice(0, 80),
      postSig: currentOverlaySig.slice(0, 80),
    });
    return { dismissed: true, reason: 'parasitic-dismissed' };
  } catch {
    return { dismissed: false, reason: 'dismiss-threw' };
  }
}

/**
 * Click effect verification — detects whether a click actually changed page state.
 * Used in editor preview to catch "click in void" cases (clicking through a modal
 * backdrop, clicking a disabled-but-not-marked element, etc.) where Playwright's
 * action succeeds but nothing observable happens.
 *
 * Strategy: snapshot a few cheap signals before the click, compare after. Any
 * one positive signal means the click had an effect.
 */
type ClickPreState = {
  url: string;
  dialogCount: number;
  // Snapshot of body's *visible* top-level children — text-content hash that is
  // stable against 3rd-party widget churn (chat/analytics scripts that mutate
  // body silently). We compare structure, not raw count, so injected
  // <script>/<iframe> nodes don't trigger false-positive 'dom' signals.
  bodyVisibleChildSig: string;
  activeElementSig: string | null;
  targetAriaPressed: string | null;
  targetAriaExpanded: string | null;
  targetAriaChecked: string | null;
  /**
   * Radix UI / shadcn / Vaul `data-state` on the click target BEFORE the
   * click fires. Critical for Radix-stack precision: many primitives
   * (Dialog, Popover, DropdownMenu, Collapsible) flip data-state without
   * mirroring to aria-expanded — without this we'd report `signal: 'focus'`
   * (weak) on a real success, and the fake-success guard would FAIL the
   * step. With it: dataState 'closed'→'open' becomes a `signal: 'aria'`
   * (strong) and the click is recognised.
   */
  targetDataState: string | null;
  targetDisabled: boolean;
  pageCount: number; // browser-context tab count for new-tab detection
  // V28: resolved absolute href of the click target when it's an anchor
  // (`<a href>` / closest `<a>` ancestor — covers icon-in-link). Lets the
  // post-click verifier decide whether a `target="_blank"` newtab landed on
  // the link's OWN destination (strong, real navigation) vs an unrelated tab
  // an ad/tracker popped (weak, fake-success symptom). null for non-anchors.
  targetHref: string | null;
  // V24: overlay/popup signature captured BEFORE click. Used by parasitic-overlay
  // dismiss helper to distinguish a popup that was already there (legitimate,
  // recorded by user) from one our wrong click just opened. Format: count of
  // each overlay class present + first text excerpt for stability.
  overlayPreSig: string;
  // V23: download event tracker. Set to a one-shot promise that resolves true
  // if Playwright fires `'download'` event between captureClickPreState and
  // verifyClickHadEffect. Click on a "Download PDF" button doesn't change URL
  // or DOM — without this signal the fake-success guard would mark a real
  // download as fail. Listener is registered with { once: true } so it
  // doesn't leak across steps.
  downloadDetected: () => boolean;
  // Cleanup function to remove the listener when verifier finishes.
  cleanupDownloadListener: () => void;
};

type ClickEffectSignal = 'url' | 'dialog' | 'aria' | 'focus' | 'detach' | 'dom' | 'newtab' | 'none' | 'download';

/**
 * Resolve the JS-execution context for click verification. When the step
 * targets an iframe, target/focus/body live inside the frame — not main page.
 * URL / dialogs / new-tab signals stay on the parent page. Returns null
 * frame if step doesn't target an iframe (signals all go through `page`).
 */
async function resolveTargetFrame(page: Page, step: IntentStep): Promise<Frame | null> {
  const iframeSelector = step.options?.iframe?.selector;
  if (!iframeSelector) return null;
  try {
    const handle = await page.locator(iframeSelector).first().elementHandle({ timeout: 500 });
    if (!handle) return null;
    const frame = await handle.contentFrame();
    return frame || null;
  } catch {
    return null;
  }
}

async function captureClickPreState(
  page: Page,
  ref: string | undefined,
  targetFrame: Frame | null,
): Promise<ClickPreState> {
  let pageCount = 1;
  try { pageCount = page.context().pages().length; } catch { /* best-effort */ }
  // V23: install one-shot 'download' listener BEFORE click so a "Download
  // PDF" button (no URL change, no DOM change) is still recognised as
  // legitimate. Without this, click on download triggers a download but the
  // verifier sees signal='none' and the fake-success guard fails the step.
  let downloaded = false;
  const downloadHandler = () => { downloaded = true; };
  let cleanupDownloadListener = (): void => { /* no-op fallback */ };
  try {
    page.on('download', downloadHandler);
    let cleaned = false;
    cleanupDownloadListener = () => {
      if (cleaned) return;
      cleaned = true;
      try { page.off('download', downloadHandler); } catch { /* non-fatal */ }
    };
    // Self-cleanup after 30s in case verifier path never runs (e.g. action
    // threw before verify, caller forgot to call cleanup). Listener leak
    // would otherwise accumulate across long sessions. Idempotent — verifier's
    // explicit cleanup wins; this fires only if verifier didn't.
    const safetyTimer = setTimeout(() => cleanupDownloadListener(), 30_000);
    (safetyTimer as any)?.unref?.();
  } catch { /* best-effort — page may be navigating */ }

  const fallback: ClickPreState = {
    url: page.url(),
    dialogCount: 0,
    bodyVisibleChildSig: '',
    activeElementSig: null,
    targetAriaPressed: null,
    targetAriaExpanded: null,
    targetAriaChecked: null,
    targetDataState: null,
    targetDisabled: false,
    pageCount,
    targetHref: null,
    overlayPreSig: '',
    downloadDetected: () => downloaded,
    cleanupDownloadListener,
  };
  try {
    const safeRef = ref ? ref.replace(/[^a-zA-Z0-9_-]/g, '') : '';
    // Page-level signals (URL, dialogs at top level) — always main frame.
    let pageSig: { url: string; dialogCount: number; bodyVisibleChildSig: string; overlayPreSig: string };
    try {
      pageSig = await page.evaluate(() => {
        // @ts-expect-error - browser context
        const doc = document;
        const dialogs = doc.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]');
        // V24: overlay-presence snapshot. Catches cdk-overlay-pane (Angular Material),
        // .modal.show (Bootstrap), and generic backdrops. Stored as a class+count
        // signature so post-click comparison can distinguish "overlay was already here"
        // (don't dismiss — recorded user intent) from "overlay just appeared because
        // of a wrong click" (safe to dismiss before retry).
        const overlaySels = [
          '.cdk-overlay-pane',
          '.cdk-overlay-backdrop.cdk-overlay-backdrop-showing',
          '.modal.show',
          '.modal-backdrop.show',
          '[role="menu"]:not([hidden])',
          '[aria-modal="true"]',
        ];
        const overlayParts: string[] = [];
        for (const sel of overlaySels) {
          const els = doc.querySelectorAll(sel);
          if (els.length > 0) overlayParts.push(`${sel}=${els.length}`);
        }
        const bodyChildren = doc.body ? Array.from(doc.body.children) as any[] : [];
        const visParts: string[] = [];
        for (const child of bodyChildren) {
          const tag = child.tagName ? child.tagName.toLowerCase() : '';
          if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'link') continue;
          const rect = child.getBoundingClientRect ? child.getBoundingClientRect() : null;
          if (rect && (rect.width === 0 && rect.height === 0)) continue;
          const cls = (child.getAttribute('class') || '').trim().split(/\s+/)[0] || '';
          const role = child.getAttribute('role') || '';
          visParts.push(`${tag}.${cls.slice(0, 20)}#${role.slice(0, 10)}`);
        }
        return {
          // @ts-expect-error - browser context
          url: window.location.href,
          dialogCount: dialogs.length,
          bodyVisibleChildSig: visParts.join('|'),
          overlayPreSig: overlayParts.join('|'),
        };
      });
    } catch {
      pageSig = { url: page.url(), dialogCount: 0, bodyVisibleChildSig: '', overlayPreSig: '' };
    }
    // Element/focus signals — target frame if iframe step, else main page.
    const evalCtx = (targetFrame ?? page) as Page | Frame;
    const elemSig = await evalCtx.evaluate(({ refSel }) => {
      // @ts-expect-error - browser context
      const doc = document;
      const ae = doc.activeElement as any;
      const aeSig = ae ? `${ae.tagName}#${ae.id || ''}.${(ae.getAttribute('class') || '').slice(0, 30)}` : null;
      let targetEl: any = null;
      if (refSel) targetEl = doc.querySelector(`[data-agent-ref="${refSel}"]`);
      // V28: resolve the anchor destination. The click target may be an icon
      // or <span> INSIDE the link, so walk up to the closest <a href>. `.href`
      // (not getAttribute) returns the browser-resolved absolute URL, so a
      // relative href compares cleanly against the new tab's absolute URL.
      let targetHref: string | null = null;
      if (targetEl) {
        const anchor = targetEl.closest ? targetEl.closest('a[href]') : null;
        if (anchor && anchor.href) targetHref = String(anchor.href);
      }
      return {
        activeElementSig: aeSig,
        targetAriaPressed: targetEl ? targetEl.getAttribute('aria-pressed') : null,
        targetAriaExpanded: targetEl ? targetEl.getAttribute('aria-expanded') : null,
        targetAriaChecked: targetEl ? targetEl.getAttribute('aria-checked') : null,
        // Radix/shadcn data-state — see ClickPreState.targetDataState.
        // Captured here as raw string-or-null so the post-click verifier
        // can compare with strict equality (===) like sibling aria-* fields.
        targetDataState: targetEl ? targetEl.getAttribute('data-state') : null,
        targetDisabled: targetEl
          ? (targetEl.hasAttribute('disabled') || targetEl.getAttribute('aria-disabled') === 'true')
          : false,
        targetHref,
      };
    }, { refSel: safeRef });
    return { ...pageSig, ...elemSig, pageCount, downloadDetected: () => downloaded, cleanupDownloadListener };
  } catch {
    return fallback;
  }
}

/**
 * V28: does a tab URL point at the same destination as a clicked anchor's href?
 * Compares origin+path first, then bare origin (covers tracking query params
 * the link adds, or a redirect that lands on the same site). Only http/https
 * count — `about:blank` (brand-new popup not yet navigated) and other schemes
 * return false, so an ad's blank popup doesn't masquerade as the link's
 * destination. Pure + exported so it's unit-testable without a browser.
 */
export function hrefMatchesUrl(targetHref: string, tabUrl: string): boolean {
  const norm = (u: string): { origin: string; originPath: string } | null => {
    try {
      const p = new URL(u);
      if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
      const host = p.host.toLowerCase();
      const path = p.pathname.replace(/\/$/, '') || '/';
      return { origin: `${p.protocol}//${host}`, originPath: `${p.protocol}//${host}${path}` };
    } catch { return null; }
  };
  const want = norm(targetHref);
  const got = norm(tabUrl);
  if (!want || !got) return false;
  return got.originPath === want.originPath || got.origin === want.origin;
}

/**
 * V28: does a NEWLY-OPENED tab point at the same destination as the clicked
 * anchor's href? Synchronous read of `page.context().pages()` — no await,
 * best-effort. Newest tab is last, so it's checked first.
 *
 * CRITICAL: the opener page (`page` itself) is excluded. hrefMatchesUrl allows
 * an origin-only match, and the opener almost always shares the href's origin —
 * so without this exclusion an ad/tracker popup to a foreign site would still
 * "match" the opener and be wrongly promoted to the strong 'url' signal. Only
 * the tab the click actually spawned counts as the link's destination.
 */
function newTabMatchesHref(page: Page, targetHref: string): boolean {
  try {
    const pages = page.context().pages();
    for (const pg of [...pages].reverse()) {
      if (pg === page) continue; // opener, not the click's new destination
      if (hrefMatchesUrl(targetHref, pg.url())) return true;
    }
  } catch { /* best-effort */ }
  return false;
}

async function verifyClickHadEffect(
  page: Page,
  pre: ClickPreState,
  ref: string | undefined,
  targetFrame: Frame | null,
): Promise<{ effected: boolean; signal: ClickEffectSignal }> {
  // Cheap immediate check (0ms wait) catches synchronous handlers; if nothing
  // changed yet we wait once and re-check for animated/SPA-router effects.
  // Two checkpoints (0ms + 800ms) instead of three keeps the worst-case slow
  // path bounded at ~800ms while keeping the fast path effectively free.
  const safeRef = ref ? ref.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  const checkpoints = [0, 800];
  for (let ci = 0; ci < checkpoints.length; ci++) {
    const delay = checkpoints[ci];
    const isLastCheckpoint = ci === checkpoints.length - 1;
    if (delay > 0) await page.waitForTimeout(delay).catch(() => {});

    // V23: download detection — checked first because download events fire
    // synchronously after click for direct file links (`<a download>`,
    // server `Content-Disposition: attachment`). Cleanup deferred to caller
    // so the listener still catches downloads that fire during the 800ms
    // settle window. Cheaper than evaluate — just reads a boolean flag.
    try {
      if (pre.downloadDetected && pre.downloadDetected()) {
        pre.cleanupDownloadListener?.();
        return { effected: true, signal: 'download' };
      }
    } catch { /* best-effort */ }

    // Browser-context check: new tab opened? Cheap, runs against the
    // BrowserContext (no page.evaluate round-trip needed) so it survives
    // the case where evaluate would throw because the active page is
    // mid-navigating.
    try {
      const nowPageCount = page.context().pages().length;
      if (nowPageCount > pre.pageCount) {
        // V28: a new tab opened. Decide STRONG vs WEAK by comparing the new
        // tab's destination against the clicked anchor's own href. A link with
        // target="_blank" landing on ITS OWN destination is a real navigation
        // (strong → 'url'), not a fake-success. Only when the new tab is
        // unrelated (ad/tracker popup, or the click target wasn't even an
        // anchor) do we keep the weak 'newtab' signal so the fake-success
        // guard still rejects it. This stops the editor from discarding the
        // compiled plan on legitimate "opens in new tab" links — the bug that
        // made the orange "Needs apply" dot stick on passing steps.
        if (pre.targetHref && newTabMatchesHref(page, pre.targetHref)) {
          pre.cleanupDownloadListener?.();
          return { effected: true, signal: 'url' };
        }
        // No href match yet. The popup may still be on about:blank mid-open —
        // on an early checkpoint, keep waiting so its URL can resolve and match
        // (and so a download that opens via a transient tab can still fire and
        // be caught by the download listener, which we therefore DON'T clean up
        // here). Only at the FINAL checkpoint do we commit to the weak 'newtab'
        // signal (unrelated popup, or non-anchor click → fake-success guard).
        if (isLastCheckpoint) {
          pre.cleanupDownloadListener?.();
          return { effected: true, signal: 'newtab' };
        }
      }
    } catch { /* best-effort */ }

    // Page-level signals — always main page (URL, top-level dialog, top-level body
    // structure). Even when the click happened inside an iframe, parent-page
    // navigation / dialogs are still the most informative top-line signal.
    let pageResult: { signal: ClickEffectSignal };
    try {
      pageResult = await page.evaluate((prev) => {
        // @ts-expect-error - browser context
        const doc = document;
        // @ts-expect-error - browser context
        if (window.location.href !== prev.url) return { signal: 'url' as const };
        const dialogCount = doc.querySelectorAll(
          '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]'
        ).length;
        if (dialogCount > prev.dialogCount) return { signal: 'dialog' as const };
        const bodyChildren = doc.body ? Array.from(doc.body.children) as any[] : [];
        const visParts: string[] = [];
        for (const child of bodyChildren) {
          const tag = child.tagName ? child.tagName.toLowerCase() : '';
          if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'link') continue;
          const rect = child.getBoundingClientRect ? child.getBoundingClientRect() : null;
          if (rect && (rect.width === 0 && rect.height === 0)) continue;
          const cls = (child.getAttribute('class') || '').trim().split(/\s+/)[0] || '';
          const role = child.getAttribute('role') || '';
          visParts.push(`${tag}.${cls.slice(0, 20)}#${role.slice(0, 10)}`);
        }
        const sig = visParts.join('|');
        if (sig !== prev.bodyVisibleChildSig) return { signal: 'dom' as const };
        return { signal: 'none' as const };
      }, pre);
    } catch {
      // page.evaluate threw. Could mean ANY of:
      //   • The page is mid-navigation (execution context destroyed because
      //     the document is being unloaded — this is the case the original
      //     code assumed).
      //   • SPA / React re-rendered hard enough to briefly drop the eval
      //     context even though the URL didn't change (Radix popover unmount,
      //     listbox close, modal close — all observed in production).
      //   • Frame detached, page closed, browser process throttled, etc.
      //
      // Old behaviour blindly returned `signal: 'url'`, which is a STRONG
      // signal that bypasses the fake-success guard. That meant any wrong
      // click that destroyed enough DOM to throw an evaluate would be marked
      // as "navigation success" with no URL change — the canonical
      // fake-success on popup-close. Probe the actual URL via Playwright's
      // own `page.url()` (no in-page eval needed) and only claim 'url' when
      // we can prove navigation happened. Otherwise drop to a 'detach' /
      // 'dom' signal so the post-click guard can actually do its job.
      try {
        const liveUrl = page.url();
        if (liveUrl && liveUrl !== pre.url) {
          pre.cleanupDownloadListener?.();
          return { effected: true, signal: 'url' };
        }
      } catch { /* page closed — fall through */ }
      // V28: the evaluate often throws on `target="_blank"` clicks because the
      // popup-open briefly busies the opener's JS context — and that race fired
      // BEFORE the top-of-loop tab-count check could see the new tab. Re-check
      // here so a legit "opens in new tab" link isn't mislabelled 'detach'
      // (weak → stale orange dot). Same decision: href match → strong 'url',
      // else weak 'newtab'.
      try {
        if (page.context().pages().length > pre.pageCount) {
          if (pre.targetHref && newTabMatchesHref(page, pre.targetHref)) {
            pre.cleanupDownloadListener?.();
            return { effected: true, signal: 'url' };
          }
          // Tab present but no href match yet. On an early checkpoint the popup
          // may still be on about:blank — fall through to the loop's next pass
          // so its URL can resolve. Only commit to weak 'newtab' at the last
          // checkpoint. (Skip the 'detach' return below in either case.)
          if (isLastCheckpoint) {
            pre.cleanupDownloadListener?.();
            return { effected: true, signal: 'newtab' };
          }
          continue;
        }
      } catch { /* best-effort */ }
      pre.cleanupDownloadListener?.();
      // Eval threw and URL is unchanged. Treat as a DOM-shake signal — it
      // IS an effect (something destroyed our eval context) but it isn't
      // a navigation. 'detach' is in the WEAK set, so the fake-success
      // guard can still reject this if fingerprint doesn't match.
      return { effected: true, signal: 'detach' };
    }
    if (pageResult.signal !== 'none') {
      pre.cleanupDownloadListener?.();
      return { effected: true, signal: pageResult.signal };
    }

    // Element-level signals — inside the targeted iframe (if any), else main page.
    // If the iframe was destroyed by the click (cross-origin nav, unmount), the
    // evaluate throws — treat as detached.
    const evalCtx = (targetFrame ?? page) as Page | Frame;
    let elemResult: { signal: ClickEffectSignal };
    try {
      elemResult = await evalCtx.evaluate(({ refSel, prev }) => {
        // @ts-expect-error - browser context
        const doc = document;
        if (refSel) {
          const targetEl = doc.querySelector(`[data-agent-ref="${refSel}"]`);
          if (!targetEl) return { signal: 'detach' as const };
          if (targetEl.getAttribute('aria-pressed') !== prev.targetAriaPressed) return { signal: 'aria' as const };
          if (targetEl.getAttribute('aria-expanded') !== prev.targetAriaExpanded) return { signal: 'aria' as const };
          if (targetEl.getAttribute('aria-checked') !== prev.targetAriaChecked) return { signal: 'aria' as const };
          // Radix/shadcn/Vaul data-state diff — strong signal of widget
          // state change. Reuses 'aria' enum tag deliberately (rather than
          // adding 'state' to ClickEffectSignal): downstream consumers
          // already classify 'aria' as a STRONG signal that bypasses the
          // fake-success guard's weak-signal branch.
          if (targetEl.getAttribute('data-state') !== prev.targetDataState) return { signal: 'aria' as const };
          const nowDisabled = targetEl.hasAttribute('disabled') || targetEl.getAttribute('aria-disabled') === 'true';
          if (nowDisabled !== prev.targetDisabled) return { signal: 'aria' as const };
        }
        const ae = doc.activeElement as any;
        const aeSig = ae ? `${ae.tagName}#${ae.id || ''}.${(ae.getAttribute('class') || '').slice(0, 30)}` : null;
        if (aeSig !== prev.activeElementSig) return { signal: 'focus' as const };
        return { signal: 'none' as const };
      }, { refSel: safeRef, prev: pre });
    } catch {
      // V28: same target="_blank" race as the page-eval catch above — the
      // popup-open can busy/destroy the element eval context AFTER the
      // top-of-loop tab check already passed. Re-check for a new tab before
      // settling on 'detach' so a legit "opens in new tab" link gets the
      // strong 'url' signal (href match) or weak 'newtab', not 'detach'.
      try {
        if (page.context().pages().length > pre.pageCount) {
          if (pre.targetHref && newTabMatchesHref(page, pre.targetHref)) {
            pre.cleanupDownloadListener?.();
            return { effected: true, signal: 'url' };
          }
          if (isLastCheckpoint) {
            pre.cleanupDownloadListener?.();
            return { effected: true, signal: 'newtab' };
          }
          continue; // early checkpoint — let the popup URL resolve next pass
        }
      } catch { /* best-effort */ }
      // Frame detached / navigating — count as effect.
      return { effected: true, signal: 'detach' };
    }
    if (elemResult.signal !== 'none') {
      pre.cleanupDownloadListener?.();
      return { effected: true, signal: elemResult.signal };
    }
  }
  // V23: final download check — event may have fired during the 800ms wait
  // even though no other signal triggered. Cleanup listener regardless.
  let downloadFinal = false;
  try { if (pre.downloadDetected && pre.downloadDetected()) downloadFinal = true; } catch { /* best-effort */ }
  pre.cleanupDownloadListener?.();
  if (downloadFinal) return { effected: true, signal: 'download' };
  return { effected: false, signal: 'none' };
}

/**
 * Test-only: run the real pre-state → click → verify pipeline against a live
 * Playwright page, so integration tests exercise the actual V28 newtab logic
 * (targetHref capture + checkpoint-aware newtab branch + newTabMatchesHref)
 * end-to-end instead of re-implementing it. Not used by production code.
 */
export async function __test__captureClickAndVerify(
  page: Page,
  ref: string,
  doClick: () => Promise<void>,
): Promise<{ effected: boolean; signal: ClickEffectSignal }> {
  const pre = await captureClickPreState(page, ref, null);
  await doClick();
  return verifyClickHadEffect(page, pre, ref, null);
}

/**
 * Compare what the resolver clicked against the recorded fingerprint to
 * detect "passed but on the wrong element" cases. Returns the strongest
 * piece of identity that matched — `id` (definitely the right element),
 * `bbox` (same screen region, may be a neighbour), `tag` (only generic
 * shape match), `no_recorded` (no fingerprint to compare against), or
 * `mismatch` (different element entirely — fake-success).
 */
function compareToRecordedFingerprint(
  chosen: { tag?: string; id?: string | null; boundingBox?: { x: number; y: number; width: number; height: number } | null } | null,
  recorded?: { tag?: string; elementId?: string; boundingBox?: { x: number; y: number; width: number; height: number } } | null,
): 'id' | 'bbox' | 'tag' | 'no_recorded' | 'mismatch' {
  if (!recorded) return 'no_recorded';
  if (!chosen) return 'mismatch';
  // Strongest signal: stable id match. The probe filters generated ids
  // upstream so what reaches `recorded.elementId` is human-named.
  if (recorded.elementId && chosen.id === recorded.elementId) return 'id';
  // Medium signal: bbox overlap (same screen region). Used when neither
  // element has an id — accepts a small position drift (responsive layouts
  // shift things by a few pixels). Threshold 25% Intersection-over-Union.
  if (recorded.boundingBox && chosen.boundingBox) {
    const r = recorded.boundingBox;
    const c = chosen.boundingBox;
    const ix = Math.max(0, Math.min(r.x + r.width, c.x + c.width) - Math.max(r.x, c.x));
    const iy = Math.max(0, Math.min(r.y + r.height, c.y + c.height) - Math.max(r.y, c.y));
    const inter = ix * iy;
    const union = r.width * r.height + c.width * c.height - inter;
    const iou = union > 0 ? inter / union : 0;
    if (iou >= 0.25) return 'bbox';
  }
  // Weak signal: same tag. <button> recorded → <button> clicked is at
  // least the right shape, even if the wrong instance.
  if (recorded.tag && chosen.tag && recorded.tag.toLowerCase() === chosen.tag.toLowerCase()) {
    return 'tag';
  }
  return 'mismatch';
}

/**
 * V2: Verify that an action had the expected effect
 * Respects iframe context if configured in step options
 */
async function verifyActionEffect(
  page: Page,
  step: IntentStep,
  ref: string
): Promise<boolean> {
  const selector = `[data-agent-ref="${ref}"]`;

  try {
    // Use the same context (page or iframe) as action execution
    const context = getLocatorContext(page, step);
    const locator = context.locator(selector);

    switch (step.type) {
      case 'check': {
        const checked = await locator.isChecked();
        return checked === true;
      }

      case 'uncheck': {
        const checked = await locator.isChecked();
        return checked === false;
      }

      case 'toggle': {
        // V10 Fix #9: Verify actual state change instead of just checking visibility.
        // Check multiple ARIA attributes that represent toggle state:
        // aria-pressed (toggle buttons), aria-checked (switch roles), aria-expanded (collapsibles)
        const pressed = await locator.getAttribute('aria-pressed').catch(() => null);
        if (pressed !== null) {
          // aria-pressed exists — a valid state means the toggle registered
          return pressed === 'true' || pressed === 'mixed';
        }

        const checked = await locator.getAttribute('aria-checked').catch(() => null);
        if (checked !== null) {
          return checked === 'true' || checked === 'mixed';
        }

        // Fallback: check native checked property (custom toggle wrapping a hidden checkbox)
        const nativeChecked = await locator.evaluate(
          (el: any) => el.querySelector('input[type="checkbox"]')?.checked ?? null
        ).catch(() => null);
        if (nativeChecked !== null) {
          return nativeChecked === true;
        }

        // Last resort: element is at least visible (preserves old behaviour for unknown toggles)
        return locator.isVisible();
      }

      case 'open': {
        // V10 Fix #9: Check multiple signals for "open" state, not just aria-expanded
        const expanded = await locator.getAttribute('aria-expanded').catch(() => null);
        if (expanded !== null) return expanded === 'true';

        // Some components use aria-hidden on the content panel; check sibling/child patterns
        const hasVisiblePanel = await locator.evaluate((el: any) => {
          const id = el.getAttribute('aria-controls');
          if (id) {
            const panel = el.ownerDocument.getElementById(id);
            return panel ? panel.getAttribute('aria-hidden') !== 'true' && panel.offsetHeight > 0 : null;
          }
          return null;
        }).catch(() => null);
        if (hasVisiblePanel !== null) return hasVisiblePanel;

        // Fallback: assume success if element is visible (cannot determine state)
        return locator.isVisible();
      }

      case 'close': {
        // V10 Fix #9: Mirror of 'open' — verify the target is actually collapsed
        const expanded = await locator.getAttribute('aria-expanded').catch(() => null);
        if (expanded !== null) return expanded !== 'true';

        const panelHidden = await locator.evaluate((el: any) => {
          const id = el.getAttribute('aria-controls');
          if (id) {
            const panel = el.ownerDocument.getElementById(id);
            return panel ? (panel.getAttribute('aria-hidden') === 'true' || panel.offsetHeight === 0) : null;
          }
          return null;
        }).catch(() => null);
        if (panelHidden !== null) return panelHidden;

        return locator.isVisible();
      }

      case 'type': {
        // Cap inputValue() — Playwright's default is 30s, which hangs when the
        // input auto-detaches on submit (e.g. OTP / one-time-code fields unmount
        // the moment the final digit completes the pattern). 1.5s is plenty for
        // an attached input; longer is a sign the element is gone.
        const SHORT = 1500;
        let actualValue: string | null = null;
        try {
          actualValue = await locator.inputValue({ timeout: SHORT });
        } catch {
          // Read timed out — could be detach (OTP auto-submit) or just a slow
          // page. Disambiguate by asking the DOM whether the element is still
          // attached. If count()===0, it's truly gone; if >=1, the 1.5s wasn't
          // enough and we must not report success falsely.
          let present = true;
          try {
            const count = await locator.count();
            present = count > 0;
          } catch {
            // count() itself failed — page navigating or frame destroyed.
            // Treat as detached: the only way to reach here after a successful
            // type action is a navigation triggered by that action.
            present = false;
          }
          if (!present) {
            // Auto-submitting inputs (OTP, one-time-code, single-digit PIN)
            // disappear the moment the expected value length is entered. The
            // upstream `type` action already returned success (otherwise we'd
            // have thrown before the verify step), so treat the post-type
            // detach as confirmed submit.
            return (step.value || '').length > 0;
          }
          // Element still attached but unreadable within 1.5s — fall through
          // to the normal comparison with empty actualValue so a slow but
          // functional input is not falsely passed.
          actualValue = '';
        }
        if (step.value === '') return true;
        if (!actualValue || actualValue.length === 0) return false;
        const expected = (step.value || '').trim();
        const actual = actualValue.trim();
        return actual === expected || actual.includes(expected) || expected.includes(actual);
      }

      case 'click': {
        // Click verification is inherently ambiguous — clicks can navigate,
        // open modals, toggle state, or have no visible side effect.
        // V13: False-positive clicks are caught upstream by:
        //   • Compiled plan URL-stale check (wrong page → skip compiled)
        //   • Evidence shortcut URL-mismatch check (wrong page → skip cache)
        //   • Compiled postcondition check (navigation expected → URL must change)
        // verifyActionEffect for click remains permissive to avoid
        // false-negatives on legitimate non-navigating clicks.
        return true;
      }

      case 'upload': {
        // Verify the file input has files set
        const files = await locator.evaluate((el: any) => el.files?.length ?? 0);
        return files > 0;
      }

      default:
        return true; // Non-verifiable actions assumed successful
    }
  } catch {
    return false;
  }
}

/**
 * Build selector from step options and candidate
 * Prioritizes manual CSS selector override if provided
 */
function buildSelector(step: IntentStep, candidate: LintCandidate): string | undefined {
  // Manual CSS selector override takes priority
  if (step.options?.cssSelector) {
    return step.options.cssSelector;
  }
  // Fall back to candidate ref
  return candidate.ref ? `[data-agent-ref="${candidate.ref}"]` : undefined;
}

// ensureStability() was removed — its logic (visible/attached waitFor +
// disableStabilityChecks short-circuit) is now the pre-phase of
// smartStepWait, which dispatches per-action to actionable/visible/
// editable/attached phases and runs their fastChecks first.

// waitForHoverEffect was duplicated here and in command-executor.ts — now a
// single shared implementation lives in wait-phases/hover-effect-settle.ts.
// Imported below as `waitForHoverEffect` to preserve existing call sites
// without touching their bodies.

/**
 * Dispatch a synthetic file drop event onto a target element.
 * Used as a last-resort fallback for drag-and-drop-only upload zones
 * that have no hidden <input type="file"> and don't trigger a fileChooser on click.
 *
 * Reads the file from disk, passes it as base64 into the browser context,
 * and dispatches dragenter → dragover → drop events with a DataTransfer payload.
 */
async function dispatchFileDrop(
  page: Page,
  locator: Locator,
  localFilePath: string,
  filename: string,
  contentType?: string,
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  // Read file from disk and encode as base64
  const fileBuffer = await fs.readFile(localFilePath);
  const base64Data = fileBuffer.toString('base64');
  const resolvedFilename = filename || path.basename(localFilePath);
  const resolvedContentType = contentType || 'application/octet-stream';

  // Dispatch synthetic drag-and-drop events in the browser context
  await locator.evaluate(
    (el: any, { base64, fname, ctype }) => {
      const g = globalThis as any;
      // Decode base64 back to binary
      const binaryStr = g.atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const file = new g.File([bytes], fname, { type: ctype });

      // Build DataTransfer with the file
      const dt = new g.DataTransfer();
      dt.items.add(file);

      const shared = { bubbles: true, cancelable: true, dataTransfer: dt };

      // Full drag sequence: dragenter → dragover → drop
      el.dispatchEvent(new g.DragEvent('dragenter', shared));
      el.dispatchEvent(new g.DragEvent('dragover', shared));
      el.dispatchEvent(new g.DragEvent('drop', shared));
    },
    { base64: base64Data, fname: resolvedFilename, ctype: resolvedContentType },
  );
}

/**
 * Upload via fileChooser interception, with drag-drop fallback.
 *
 * Strategy:
 * 1. Try fileChooser interception (short 3s timeout) — works with programmatic input.click()
 * 2. If fileChooser times out (e.g., drag-only dropzone), fall back to synthetic drop event
 *
 * This prevents wasting the full action timeout on drag-only zones that will never
 * emit a filechooser event.
 */
async function uploadViaFileChooserOrDrop(
  page: Page,
  locator: Locator,
  localFilePath: string,
  filename: string,
  contentType?: string,
  timeout = 10_000,
): Promise<void> {
  const FILECHOOSER_QUICK_TIMEOUT = 3_000;

  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: FILECHOOSER_QUICK_TIMEOUT }),
      locator.click({ timeout: FILECHOOSER_QUICK_TIMEOUT }),
    ]);
    await fileChooser.setFiles(localFilePath);
  } catch {
    // FileChooser didn't fire — likely a drag-and-drop-only upload zone.
    // Fall back to synthetic drop event.
    logger.info('[PREVIEW_APPLY] FileChooser not triggered, falling back to synthetic drop', {
      filename,
    });
    await dispatchFileDrop(page, locator, localFilePath, filename, contentType);
  }
}

/**
 * V10 Fix #7: Detect how long a dropdown animation takes to complete.
 * Polls for new visible ARIA containers (listbox/menu) or role=option elements.
 * Returns elapsed time + a safety margin so we know how long to wait in each phase.
 *
 * Strategy: measure how long it takes for any dropdown-like container to appear
 * after the trigger click, then add a proportional buffer for animation easing.
 */
async function measureDropdownOpenLatency(
  page: Page,
  maxWaitMs = 5000,
  pollIntervalMs = 100,
): Promise<number> {
  const start = Date.now();
  const dropdownSelector = [
    '[role="listbox"]:visible',
    '[role="menu"]:visible',
    '[role="option"]:visible',
    '[role="menuitem"]:visible',
    // Common non-ARIA patterns
    'ul.dropdown-menu:visible',
    '.MuiMenu-list:visible',
    '[class*="dropdown"][class*="open"]:visible',
  ].join(', ');

  try {
    await page.waitForSelector(dropdownSelector, {
      state: 'visible',
      timeout: maxWaitMs,
    });
  } catch {
    // Nothing appeared within max wait — return the full max so callers still try
    return maxWaitMs;
  }

  const elapsed = Date.now() - start;
  // Add 30% buffer for animation easing (at least 200ms, at most 3s extra)
  const buffer = Math.min(3000, Math.max(200, Math.round(elapsed * 0.3)));
  return elapsed + buffer;
}

/**
 * Custom dropdown select: click trigger → find visible option → click option.
 *
 * V10 Fix #7: Uses adaptive timeout based on measured dropdown animation latency
 * instead of hardcoded 2s, so slow-animating dropdowns (Material UI, Ant Design)
 * are handled automatically.
 *
 * Strategy chain (most precise → broadest):
 * 1. Scoped: find ARIA listbox/menu container, search option inside it
 *    — Prevents clicking same-text elements elsewhere on the page
 * 2. Page-level getByRole('option'/'menuitem') — ARIA-compliant; auto-filters hidden
 *    — Handles portaled menus (React Portal, MUI Popper) rendered outside DOM tree
 * 3. Page-level getByText + :visible — universal fallback for non-ARIA dropdowns
 */
async function selectFromCustomDropdown(
  page: Page,
  triggerLocator: Locator,
  value: string,
  timeout: number
): Promise<void> {
  // Detect combobox pattern: if trigger is an input or has role="combobox",
  // type the value first to filter options, then search.
  const isCombobox = await triggerLocator.evaluate((el: any) => {
    const tag = el.tagName?.toLowerCase();
    const role = el.getAttribute?.('role');
    return tag === 'input' || role === 'combobox' || role === 'searchbox'
      || !!el.querySelector('input') || el.getAttribute?.('aria-autocomplete') != null;
  }).catch(() => false);

  if (isCombobox) {
    // For combobox: focus input and type value to filter options
    const inputLocator = await triggerLocator.evaluate((el: any) => {
      return el.tagName?.toLowerCase() === 'input' ? null : 'has-child-input';
    }).catch(() => null);
    const inputTarget = inputLocator === 'has-child-input'
      ? triggerLocator.locator('input').first()
      : triggerLocator;
    await inputTarget.click({ timeout });
    await inputTarget.fill(value, { timeout });
    // Wait for filtered options to appear
    await page.waitForTimeout(500);
  } else {
    // Click the trigger to open the dropdown
    await triggerLocator.click({ timeout });
  }

  // V10 Fix #7: Measure actual dropdown animation latency instead of hardcoding
  // This adapts to slow animations (Material UI transitions, CSS keyframes, etc.)
  const animationLatency = await measureDropdownOpenLatency(page);
  // Per-phase timeout: use animation latency as floor, step timeout as ceiling
  const phaseTimeout = Math.min(timeout, Math.max(animationLatency, 1500));

  logger.debug('[CUSTOM_DROPDOWN] Animation latency measured', {
    animationLatency,
    phaseTimeout,
    value: value.substring(0, 50),
    isCombobox,
  });

  // Phase 1: Try scoped search inside a visible ARIA container (listbox/menu)
  // This is the safest approach — avoids clicking same-text elements elsewhere
  const containers = [
    page.locator('[role="listbox"]:visible'),
    page.locator('[role="menu"]:visible'),
  ];

  for (const container of containers) {
    try {
      const ctr = container.first();
      const isVisible = await ctr.isVisible().catch(() => false);
      if (!isVisible) continue;

      // Search for option inside this container
      const scopedOpt = ctr.getByText(value, { exact: true }).first();
      await scopedOpt.waitFor({ state: 'visible', timeout: phaseTimeout });
      await scopedOpt.click({ timeout: phaseTimeout });
      return;
    } catch {
      // Option not found — check if container is virtualized (scrollable with many items)
      // If so, scroll through to reveal off-viewport items
      try {
        const ctr = container.first();
        const isScrollable = await ctr.evaluate((el: any) => el.scrollHeight > el.clientHeight + 50).catch(() => false);
        if (isScrollable) {
          // Scroll in chunks (300px at a time), search after each scroll
          let lastScrollTop = -1;
          for (let scrollAttempt = 0; scrollAttempt < 10; scrollAttempt++) {
            const currentScrollTop = await ctr.evaluate((el: any) => {
              el.scrollTop += 300;
              return el.scrollTop;
            });
            // Stop if we've hit the bottom (scrollTop didn't change)
            if (currentScrollTop === lastScrollTop) break;
            lastScrollTop = currentScrollTop;
            await page.waitForTimeout(150); // Let virtualized items render
            const found = ctr.getByText(value, { exact: true }).first();
            const isVis = await found.isVisible().catch(() => false);
            if (isVis) {
              await found.click({ timeout: phaseTimeout });
              return;
            }
          }
        }
      } catch {
        // Scroll attempt failed — continue to next phase
      }
    }
  }

  // Phase 2: Page-level ARIA role search (handles portals where container is outside DOM tree)
  const roleStrategies = [
    page.getByRole('option', { name: value, exact: true }),
    page.getByRole('menuitem', { name: value, exact: true }),
    page.getByRole('option', { name: value, exact: false }),
    page.getByRole('menuitem', { name: value, exact: false }),
  ];

  for (const strategy of roleStrategies) {
    try {
      const opt = strategy.first();
      await opt.waitFor({ state: 'visible', timeout: phaseTimeout });
      await opt.click({ timeout: phaseTimeout });
      return;
    } catch {
      // Try next
    }
  }

  // Phase 3: Universal text fallback (non-ARIA dropdowns)
  // Scoped to recently-appeared overlay containers first, then page-level as last resort
  const overlayContainers = [
    page.locator('[class*="dropdown"]:visible, [class*="Dropdown"]:visible').first(),
    page.locator('[class*="popup"]:visible, [class*="Popup"]:visible, [class*="popover"]:visible, [class*="Popover"]:visible').first(),
    page.locator('[class*="select"]:visible, [class*="Select"]:visible').last(),
  ];

  for (const container of overlayContainers) {
    try {
      const isVisible = await container.isVisible().catch(() => false);
      if (!isVisible) continue;
      const scopedOpt = container.getByText(value, { exact: true }).first();
      await scopedOpt.waitFor({ state: 'visible', timeout: phaseTimeout });
      await scopedOpt.click({ timeout: phaseTimeout });
      return;
    } catch {
      // Try next container
    }
  }

  // Last resort: page-level text search (getByText matches hidden elements too, so we filter with :visible)
  const textStrategies = [
    page.getByText(value, { exact: true }).and(page.locator(':visible')),
    page.getByText(value, { exact: false }).and(page.locator(':visible')),
  ];

  for (const strategy of textStrategies) {
    try {
      const opt = strategy.first();
      await opt.waitFor({ state: 'visible', timeout: phaseTimeout });
      await opt.click({ timeout: phaseTimeout });
      return;
    } catch {
      // Try next
    }
  }

  throw new Error(`Could not find option "${value}" in dropdown`);
}

/**
 * Execute an action on the page
 * V7: Optionally accepts a pre-resolved locator (from compiled plan)
 */
async function executeAction(
  page: Page,
  step: IntentStep,
  candidate: LintCandidate,
  preResolvedLocator?: Locator,
  options?: { expectsNavigation?: boolean; secretValues?: readonly string[] }
): Promise<{ success: boolean; error?: string; urlChanged: boolean }> {
  const urlBefore = page.url();
  // Post-interpolation step bodies (the `type` value) can contain resolved
  // `secrets.*` plaintext — redact through these before any log line (#10).
  const secretValues = options?.secretValues ?? [];

  try {
    // Build selector (unless we have a pre-resolved locator from compiled plan)
    const selector = preResolvedLocator ? '' : buildSelector(step, candidate);

    if (!selector && !preResolvedLocator && !['navigate', 'wait', 'timeout', 'scroll', 'press'].includes(step.type)) {
      return { success: false, error: 'No valid selector for element', urlChanged: false };
    }

    // Get context (page or iframe)
    const context = getLocatorContext(page, step);
    const timeout = step.options?.timeout || ACTION_TIMEOUT;

    // V7: Use pre-resolved locator if provided, otherwise build from selector
    const locator = preResolvedLocator || (selector ? (context as Page | FrameLocator).locator(selector) : undefined);

    // Scroll element into viewport before action (fullPage snapshots can resolve off-screen elements)
    // Skip for non-targeting actions that don't need a visible element
    if (locator && !['navigate', 'wait', 'timeout', 'wait_for', 'scroll'].includes(step.type)) {
      await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
    }

    // V16: Pre-action readiness delegated to smartStepWait('pre').
    //
    // Replaces ensureStability() with the unified per-action plan: click gets
    // actionable+modal-clear+iframe-ready, type gets editable, upload gets
    // attached, etc. Fast-path skips run first, so ready elements pay ~50ms.
    // The legacy disableStabilityChecks flag still short-circuits the call.
    if (
      locator &&
      step.type !== 'navigate' &&
      step.type !== 'wait' &&
      !step.options?.disableStabilityChecks
    ) {
      await smartStepWait({
        page,
        step,
        locator,
        phase: 'pre',
        timeoutBudget: timeout,
      });
    }

    switch (step.type) {
      case 'type': {
        if (!locator) throw new Error('No selector for type action');
        // Preserve exact user-entered text (including leading/trailing spaces and newlines).
        const value = normalizeTypeActionValue(step.value);
        const humanLike = step.options?.humanLike === true;

        // ═══════════════ V9: Special input detection ═══════════════
        // Range sliders, color pickers, date/time inputs, and custom ARIA sliders
        // need nativeInputValueSetter — fill()/pressSequentially() fail on these.
        {
          const { detectSpecialInput, setNativeInputValue, setAriaSliderValue, validateInputValue } =
            await import('@/agent/playwright/core/native-input-helpers');

          // Fast-path: check binding hints from recording layer (no DOM query needed)
          const hintType = step.bindingHints?.type?.toLowerCase() || '';
          const specialHintTypes = ['range', 'color', 'date', 'time', 'datetime-local', 'month', 'week'];
          const isSpecialByHint = specialHintTypes.includes(hintType);

          // Slow-path: runtime DOM detection (only if hint didn't match)
          const specialInput = isSpecialByHint
            ? { isSpecialInput: true as const, strategy: 'nativeValueSetter' as const, inputType: hintType }
            : await detectSpecialInput(locator).catch((): { isSpecialInput: false; strategy: 'default'; inputType?: undefined } =>
                ({ isSpecialInput: false, strategy: 'default', inputType: undefined }));

          if (specialInput.isSpecialInput) {
            const detectedType = specialInput.inputType || hintType;
            const validation = validateInputValue(detectedType, value);
            if (validation.warning) {
              logger.warn('[EXECUTE_ACTION] Input value format warning', { warning: validation.warning, value, inputType: detectedType });
            }

            if (specialInput.strategy === 'ariaSlider') {
              await setAriaSliderValue(page, locator, value);
            } else {
              await setNativeInputValue(locator, value);
            }

            if (step.options?.pressEnter) {
              await locator.press('Enter', { timeout });
            }
            break;
          }
        }
        // ═══════════════ END V9 ═══════════════

        // V13: Paste mode — write to clipboard then dispatch paste via keyboard shortcut.
        // Web apps that listen for 'paste' events (OTP fields, code editors) won't trigger with fill().
        if (step.options?.isPaste) {
          await locator.click({ timeout }); // Focus the element
          // Write to system clipboard via CDP
          const pasteContext = page.context();
          await pasteContext.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
          // @ts-expect-error - navigator exists in browser context
          await page.evaluate((text) => navigator.clipboard.writeText(text), value).catch(async () => {
            // Fallback: use deprecated execCommand for older pages
            await page.evaluate((text) => {
              // @ts-expect-error - document exists in browser context
              const ta = document.createElement('textarea');
              ta.value = text;
              // @ts-expect-error - document exists in browser context
              document.body.appendChild(ta);
              ta.select();
              // @ts-expect-error - document exists in browser context
              document.execCommand('copy');
              ta.remove();
            }, value);
          });
          // Dispatch Ctrl+V / Cmd+V to trigger paste event listeners
          const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
          await page.keyboard.press(`${modifier}+v`);
          if (step.options?.pressEnter) {
            await locator.press('Enter', { timeout });
          }
          break;
        }

        // Human-like typing: gradual per-character input (instead of instant fill).
        // - If replaceContent is false: append by typing
        // - Else: clear first (fast), then type gradually
        if (humanLike) {
          // Focus the input first (real user behavior)
          await locator.click({ timeout });

          // If we want to "replace", clear existing content before typing.
          // We clear quickly, then type gradually for the human-like effect.
          const isReplace = step.options?.replaceContent !== false;
          if (isReplace) {
            await clearFieldBeforeType(locator, timeout, { secretValues });
          }

          // Delay between keystrokes:
          // - If explicitly set, respect it
          // - Else choose a realistic random delay in [50..150] ms
          const delay = Number.isFinite(step.options?.keyPressDelay)
            ? Math.max(0, step.options!.keyPressDelay!)
            : randomIntInclusive(50, 150);

          await locator.pressSequentially(value, { timeout, delay });

          // Verify the value landed (Finding 2): humanLike types char-by-char
          // with a 50–150ms delay — slower typing makes mask races WORSE, so
          // this path needs the masked-drop verify most. Replace-mode only
          // (append-mode field holds prior content, so it can't match `value`).
          if (isReplace) {
            await verifyTypedValueAndRetry(page, locator, value, timeout, { secretValues });
          }

          // Sometimes pause after typing (e.g., user thinking / UI debounce)
          await maybeRandomPause(page, 0.35, 80, 220);
        } else if (step.options?.replaceContent === false) {
          // Legacy behavior: append typing (uses keyPressDelay if provided)
          await locator.click({ timeout });
          await locator.pressSequentially(value, { timeout, delay: step.options?.keyPressDelay });
        } else {
          // When the user explicitly sets keyPressDelay we always use
          // pressSequentially so the per-keystroke delay is honored — even for
          // long text where we'd normally take the fast `fill()` path.
          const userKeyPressDelay = Number.isFinite(step.options?.keyPressDelay)
            ? Math.max(0, step.options!.keyPressDelay!)
            : null;

          if (value.length <= 50 || userKeyPressDelay != null) {
            // Short text (credentials, emails, OTP) OR user-requested gradual typing:
            // use pressSequentially for full keyboard event chain.
            await clearFieldBeforeType(locator, timeout, { secretValues }); // Clear existing content (verified — see helper)
            await locator.click({ timeout });
            await locator.pressSequentially(value, { timeout, delay: userKeyPressDelay ?? 20 });
            // Read back the value and, on a SAFE masked-drop mismatch, repair
            // once with fill(). Gated so it can't wipe an OTP/maxlength/multi-box
            // entry; logs are secret-redacted. See verifyTypedValueAndRetry.
            await verifyTypedValueAndRetry(page, locator, value, timeout, { secretValues });
          } else {
            // Long text (comments, descriptions): fast fill with post-blur fallback
            await locator.fill(value, { timeout });

            // Post-fill verification: check value survived after triggering blur.
            // Some frameworks (WPForms, React controlled inputs) clear fill() values
            // because they only track state via keyboard events, not programmatic value sets.
            try {
              // Trigger blur by pressing Tab (moves focus to next field)
              await locator.press('Tab', { timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(100); // Let framework process blur
              // Re-focus to check value
              await locator.focus({ timeout: 2000 }).catch(() => {});
              const postBlurValue = await locator.inputValue().catch(() => '');
              // Share the tolerant comparator with the short-text path (Finding
              // 9) — strict `!==` false-positives on an auto-formatting long
              // field and spuriously clears + retypes.
              if (value && !typedValueLooksApplied(value, postBlurValue)) {
                logger.info('[EXECUTE_ACTION] fill() value lost after blur — retrying with pressSequentially', {
                  expected: redactWithValues(value, secretValues).slice(0, 50),
                  actual: redactWithValues(postBlurValue, secretValues).slice(0, 50),
                });
                // Clear and retry with pressSequentially (generates full keyboard event chain)
                await locator.fill('', { timeout }).catch(() => {});
                await locator.click({ timeout });
                await locator.pressSequentially(value, { timeout, delay: 30 });
              }
            } catch {
              // Non-critical — best effort fallback
            }
          }
        }
        if (step.options?.pressEnter) {
          await locator.press('Enter', { timeout });
        }
        break;
      }

      case 'click': {
        if (!locator) throw new Error('No selector for click action');
        const humanLike = step.options?.humanLike === true;


        // V13: Build Playwright modifiers array from step options
        const clickModifiers: ('Shift' | 'Control' | 'Alt' | 'Meta')[] = [];
        if (step.options?.modifiers) {
          if (step.options.modifiers.shift) clickModifiers.push('Shift');
          if (step.options.modifiers.ctrl) clickModifiers.push('Control');
          if (step.options.modifiers.meta) clickModifiers.push('Meta');
          if (step.options.modifiers.alt) clickModifiers.push('Alt');
        }
        const clickOpts: Parameters<Locator['click']>[0] = {
          timeout,
          // V15.3: Skip Playwright's post-action stability wait. Without this,
          // clicking an element that triggers an animation (e.g. Angular stories
          // modal opening) blocks .click() for up to 15-30s waiting for the
          // button's boundingBox to stop moving. We don't need that wait here:
          // the inter-step lookahead already guarantees the NEXT step's target
          // is ready before the next action fires. Shedding this wait trims
          // 15s off every click on animated elements.
          noWaitAfter: true,
          ...(clickModifiers.length > 0 && { modifiers: clickModifiers }),
        };

        // V13: Track pages before click for new-tab detection
        const pagesBefore = page.context().pages().length;

        // New-tab promotion: anchors with explicit `target` (`_blank` / named)
        // OR cross-origin anchors AND modifier-driven new-tab clicks
        // (Cmd/Ctrl/Shift) open via `context.newPage() + goto(href)` instead
        // of `locator.click()`. The BrowserContext-level `on('page')` hook
        // (preview-session.attachPopupHandler) adopts the page into
        // `session.pages` and emits `preview:tab:opened` — no extra plumbing
        // needed here, we just skip the click and break out of the case.
        try {
          const { tryOpenAnchorAsNewTab, shouldOpenAsNewTab, openHrefInNewTab, probeAnchorAtLocator } = await import('./new-tab-opener');
          const wantsNewTabByModifier = clickModifiers.includes('Meta')
            || clickModifiers.includes('Control')
            || clickModifiers.includes('Shift');
          if (wantsNewTabByModifier) {
            const probe = await probeAnchorAtLocator(locator);
            if (probe?.href) {
              // When Cmd/Ctrl/Shift is held on a same-origin anchor without
              // `target`, `shouldOpenAsNewTab` returns null (those wouldn't
              // qualify on their own). The modifier itself is the trigger
              // here — tag the reason explicitly so logs don't conflate it
              // with `_blank` attribute-driven promotion.
              const decision = shouldOpenAsNewTab(probe, page.url())
                ?? { reason: 'modifier_driven' as const, href: probe.href };
              const tabOpen = await openHrefInNewTab(page.context(), decision.href, decision.reason);
              if (tabOpen) break;
            }
          } else {
            const tabOpen = await tryOpenAnchorAsNewTab(locator, page.context(), page.url());
            if (tabOpen) break;
          }
        } catch (probeErr) {
          // Fail open — never block a normal click on probe glitches.
          logger.debug('[EXECUTE_ACTION] New-tab probe failed, proceeding with normal click', {
            error: probeErr instanceof Error ? probeErr.message : String(probeErr),
          });
        }

        if (humanLike) {
          // Human-like click: hover -> small pause -> click
          await locator.hover({ timeout });
          await sleepMs(page, randomIntInclusive(40, 160));

          // Sometimes click at a random point inside the element (reduces "robotic" center-click pattern)
          const usePosition = Math.random() < 0.3;
          if (usePosition) {
            const box = await locator.boundingBox().catch(() => null);
            if (box && box.width > 6 && box.height > 6) {
              // Position is relative to the element's top-left in Playwright
              const x = randomIntInclusive(3, Math.floor(box.width) - 3);
              const y = randomIntInclusive(3, Math.floor(box.height) - 3);
              await locator.click({ ...clickOpts, position: { x, y } });
              break;
            }
          }
        }

        // V13: If next step expects navigation (wait_for changedFrom), wrap click with
        // waitForNavigation to reliably capture the navigation event.
        //
        // V23: `waitForNavigation({waitUntil:'load'})` only fires for FULL page
        // loads — SPA pushState/replaceState never triggers `load` so the race
        // would resolve via timeout, leaving `page.url()` lagging. Add a
        // parallel `waitForURL` with predicate "url changed from urlBefore" so
        // SPAs (Angular Router, React Router, Vue Router with router-link) are
        // covered too. Either path resolves the race; whichever fires first
        // wins. Both swallow errors so click never fails because of nav waits.
        if (options?.expectsNavigation) {
          const urlBeforeClick = page.url();
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: COMMAND_EXECUTOR_CONFIG.clickNavigationTimeoutMs }).catch(() => {}),
            page.waitForURL(
              (u: URL) => u.toString() !== urlBeforeClick,
              { timeout: COMMAND_EXECUTOR_CONFIG.clickNavigationTimeoutMs },
            ).catch(() => {}),
            locator.click(clickOpts),
          ]);
        } else {
          await locator.click(clickOpts);
        }

        // V13: Detect new tab opened by click (target="_blank", window.open)
        // Wait for new page to load so subsequent steps can target it
        if (page.context().pages().length > pagesBefore) {
          const newPage = page.context().pages().at(-1);
          if (newPage) {
            logger.info('[EXECUTE_ACTION] New tab detected after click, waiting for load', {
              pagesAfter: page.context().pages().length,
            });
            await newPage.waitForLoadState('domcontentloaded', { timeout: COMMAND_EXECUTOR_CONFIG.newPageFallbackTimeoutMs }).catch(() => {});
          }
        }
        break;
      }

      case 'select': {
        if (!locator) throw new Error('No selector for select action');
        const selectValue = step.value || '';

        // Detect native <select> vs custom dropdown
        const isNativeSelect = await locator.evaluate(
          (el) => el.tagName.toLowerCase() === 'select'
        ).catch(() => false);

        if (isNativeSelect) {
          // Native <select>: use Playwright's selectOption
          await locator.selectOption(selectValue, { timeout });
        } else {
          await selectFromCustomDropdown(page, locator, selectValue, timeout);
        }
        break;
      }

      case 'hover': {
        if (!locator) throw new Error('No selector for hover action');
        try {
          await locator.hover({ timeout });
        } catch {
          // Retry with force:true if blocked by an overlay (another tooltip, sticky header, etc.)
          await locator.hover({ timeout, force: true });
        }
        // Adaptive post-hover settle — waits for hover-triggered DOM changes to stabilize
        // (tooltips, submenus, popovers) instead of a fixed delay
        await waitForHoverEffect(page);
        break;
      }

      case 'press': {
        const key = step.value || 'Enter';
        if (locator) {
          // V15.3: Same rationale as click — skip Playwright's stability wait.
          // The 1s safety buffer in the caller gives handlers time to process.
          await locator.press(key, { timeout, noWaitAfter: true });
        } else {
          // Page-level press fallback (Escape, Tab, F5, shortcuts, etc.)
          await page.keyboard.press(key);
        }
        break;
      }

      case 'scroll': {
        if (locator) {
          await locator.scrollIntoViewIfNeeded({ timeout });
        } else {
          // V14: Parse both deltaY and optional deltaX from step.value
          // Format: "deltaY" or "deltaY,deltaX"
          const valueParts = (step.value || '').split(',');
          const rawDeltaY = parseFloat(valueParts[0] || '');
          const rawDeltaX = valueParts.length > 1 ? parseFloat(valueParts[1] || '') : 0;
          const deltaY = Number.isFinite(rawDeltaY) ? rawDeltaY : 300;
          const deltaX = Number.isFinite(rawDeltaX) ? rawDeltaX : 0;

          // Container scroll: if scrollContainer selector recorded, scroll that element instead of window
          const containerSel = step.options?.scrollContainer;
          if (containerSel) {
            await page.evaluate(({ sel, dx, dy }: { sel: string; dx: number; dy: number }) => {
              const container = (globalThis as any).document.querySelector(sel);
              if (container) {
                container.scrollBy(dx, dy);
              } else {
                // Fallback to window scroll if container not found
                (globalThis as any).scrollBy(dx, dy);
              }
            }, { sel: containerSel, dx: deltaX, dy: deltaY });
          } else {
            await page.evaluate(({ dx, dy }: { dx: number; dy: number }) => {
              (globalThis as any).scrollBy(dx, dy);
            }, { dx: deltaX, dy: deltaY });
          }
        }
        // Post-scroll settle — give lazy-loaded content time to appear
        await sleepMs(page, STEP_READINESS_CONFIG.domStableThresholdMs.assertion);
        break;
      }

      case 'wait': {
        const waitTimeout = step.options?.timeout || 1000;
        await page.waitForTimeout(waitTimeout);
        break;
      }

      case 'timeout': {
        // Explicit sleep/pause: ms lives in step.value (number of ms to wait)
        const ms = Number(step.value) || step.options?.timeout || 1000;
        await page.waitForTimeout(ms);
        break;
      }

      case 'navigate': {
        if (!step.value) throw new Error('No URL for navigate action');
        const safeUrl = sanitizeUrl(step.value);
        // Explicit navigate step is user-intent — suppress the external-nav
        // trap for this transition so cross-origin URLs (e.g. OAuth start,
        // intentional deeplink) are not reverted.
        try {
          const { markIntentionalGotoByPage } = await import('./external-nav-trap');
          markIntentionalGotoByPage(page);
        } catch { /* non-fatal */ }
        try {
          await page.goto(safeUrl, { waitUntil: 'load', timeout: STEP_APPLY_CONFIG.navigateTimeoutMs });
        } catch (navError) {
          // Classify navigation error into user-friendly message
          throw new Error(classifyNavigationError(
            navError instanceof Error ? navError : new Error(String(navError)),
            safeUrl,
          ));
        }
        break;
      }

      case 'assert': {
        if (!locator) throw new Error('No selector for assert action');
        // Step 1: verify element is visible
        await locator.waitFor({ state: 'visible', timeout });
        // Step 2: if value is provided, verify element contains the expected text
        if (step.value && step.value.trim().length > 0) {
          const elementText = await locator.textContent({ timeout });
          const actualText = (elementText || '').trim();
          const expectedText = step.value.trim();
          if (!actualText.toLowerCase().includes(expectedText.toLowerCase())) {
            throw new Error(
              `Element does not contain expected text.\n` +
              `Expected: "${expectedText}"\n` +
              `Actual: "${actualText.substring(0, 200)}"`
            );
          }
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V2: New state-aware action types
      // ═══════════════════════════════════════════════════════════════════════
      case 'check': {
        if (!locator) throw new Error('No selector for check action');
        await locator.check({ timeout });
        break;
      }

      case 'uncheck': {
        if (!locator) throw new Error('No selector for uncheck action');
        await locator.uncheck({ timeout });
        break;
      }

      case 'toggle': {
        if (!locator) throw new Error('No selector for toggle action');
        // Toggle: click the element (works for checkboxes, switches, toggles)
        await locator.click({ timeout });
        break;
      }

      case 'open': {
        if (!locator) throw new Error('No selector for open action');
        // Open: click to expand (dropdown, accordion, menu)
        // First check if already open
        const isExpanded = await locator.getAttribute('aria-expanded');
        if (isExpanded !== 'true') {
          await locator.click({ timeout });
        }
        break;
      }

      case 'close': {
        if (!locator) throw new Error('No selector for close action');
        // Close: click to collapse (dropdown, accordion, menu)
        const isExpanded = await locator.getAttribute('aria-expanded');
        if (isExpanded === 'true') {
          await locator.click({ timeout });
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V10: New interaction types
      // ═══════════════════════════════════════════════════════════════════════
      case 'dblclick': {
        if (!locator) throw new Error('No selector for dblclick action');
        await locator.dblclick({ timeout });
        break;
      }

      case 'contextmenu': {
        if (!locator) throw new Error('No selector for contextmenu action');
        await locator.click({ button: 'right', timeout });
        break;
      }

      case 'drag_and_drop': {
        if (!locator) throw new Error('No selector for drag_and_drop source');
        const dragCoords = parseDragCoordinates(step.value);

        if (dragCoords) {
          await executeCoordinateDrag(page, dragCoords);
        } else if (step.options?.dropTarget) {
          // Element-based drag: drag source locator to a target selector
          const targetLocator = (getLocatorContext(page, step) as Page | FrameLocator)
            .locator(step.options.dropTarget);
          await locator.dragTo(targetLocator, { timeout });
        } else {
          throw new Error('drag_and_drop requires coordinate data (value) or a dropTarget option');
        }
        break;
      }

      // V16: Swipe gesture — for carousels (Swiper, Slick, Embla), mobile-like interactions
      case 'swipe': {
        if (!locator) throw new Error('No selector for swipe action');
        const { executeSwipe } = await import('@/agent/playwright/core/native-input-helpers');
        const swipeDir = (step.value?.toLowerCase() || 'left') as 'left' | 'right' | 'up' | 'down';
        if (!['left', 'right', 'up', 'down'].includes(swipeDir)) {
          throw new Error(`Invalid swipe direction: "${step.value}" — must be left, right, up, or down`);
        }
        await executeSwipe(page, locator, swipeDir);
        break;
      }

      // V16: Click at coordinates — for canvas, maps, charts (elements without DOM targets)
      case 'click_at': {
        const { parseClickAtCoordinates, clickAtCoordinates } = await import('@/agent/playwright/core/native-input-helpers');
        const coords = parseClickAtCoordinates(step.value);
        if (!coords) {
          throw new Error(`Invalid coordinates: "${step.value}" — use "x,y" format (e.g., "500,300")`);
        }
        await clickAtCoordinates(page, coords);
        break;
      }

      // V6: File upload — supports both native <input type="file"> and trigger-button patterns
      case 'upload': {
        if (!locator) throw new Error('No selector for upload action');

        const fileUrl = step.value;
        if (!fileUrl) throw new Error('File URL/path is required for upload action');

        const uploadOpts = step.options?.upload;
        let localFilePath: string;
        let downloadedFilename: string = '';
        let downloadedContentType: string | undefined;
        let needsCleanup = false;

        // Both 'url' and 'storage' source types use public URLs — download to temp dir
        {
          const { downloadFileForUpload } = await import('@/agent/execution/file-download.service');
          const result = await downloadFileForUpload(fileUrl, {
            filename: uploadOpts?.filename,
            maxSizeBytes: uploadOpts?.maxSizeBytes,
          });
          localFilePath = result.localPath;
          downloadedFilename = result.filename;
          downloadedContentType = result.contentType;
          needsCleanup = true;
        }

        try {
          // Check if the resolved element is already an <input type="file">
          const tagName = await locator.evaluate((el: any) => el.tagName?.toLowerCase()).catch(() => '');
          const inputType = await locator.evaluate((el: any) => el.type?.toLowerCase()).catch(() => '');
          const isFileInput = tagName === 'input' && inputType === 'file';

          if (isFileInput) {
            // Direct path: element is already a file input
            await locator.waitFor({ state: 'attached', timeout });
            await locator.setInputFiles(localFilePath, { timeout });
          } else {
            // Trigger-button pattern: the resolved element is a <button>/<div>/<label> that
            // opens a native file dialog. The real <input type="file"> is hidden via CSS.
            // Strategy: 1) Try to find a hidden file input nearby in DOM
            //           2) Fall back to fileChooser event interception (most universal)

            // Attempt 1: Search for a hidden file input associated with this trigger element.
            // Checks: children, shadow DOM children, parent containers (up to 3 levels),
            // shadow roots in parent trees, and label[for] association.
            const nearbyFileInput = await locator.evaluate((el: any) => {
              // Helper: check a root and its open shadow roots for input[type="file"]
              const findFileInput = (root: any): boolean => {
                if (!root) return false;
                if (root.querySelector?.('input[type="file"]')) return true;
                // Traverse open shadow roots of all child elements
                const children = root.querySelectorAll?.('*') || [];
                for (const child of children) {
                  if (child.shadowRoot?.querySelector('input[type="file"]')) return true;
                }
                return false;
              };

              // Check element itself (children + shadow)
              if (findFileInput(el)) return true;
              if (el.shadowRoot && findFileInput(el.shadowRoot)) return true;

              // Check parent containers (up to 3 levels) for a file input
              let parent = el.parentElement;
              for (let i = 0; i < 3 && parent; i++) {
                if (findFileInput(parent)) return true;
                parent = parent.parentElement;
              }

              // Check by label[for] association
              if (el.tagName === 'LABEL' && el.htmlFor) {
                const target = el.ownerDocument.getElementById(el.htmlFor);
                if (target?.type === 'file') return true;
              }

              return false;
            }).catch(() => false);

            if (nearbyFileInput) {
              // Found a nearby hidden file input — locate and use it
              const fileInputLocator = await (async () => {
                // Try child first (Playwright pierces open shadow DOM)
                const child = locator.locator('input[type="file"]');
                if (await child.count() > 0) return child.first();

                // Try parent containers (up to 3 levels)
                for (let i = 1; i <= 3; i++) {
                  const ancestor = locator.locator(`xpath=${'..'.concat('/..'.repeat(i - 1))}`);
                  const input = ancestor.locator('input[type="file"]');
                  if (await input.count() > 0) return input.first();
                }

                // No page-level fallback — too risky with multiple file inputs.
                // Fall through to fileChooser interception instead.
                return null;
              })();

              if (fileInputLocator) {
                await fileInputLocator.waitFor({ state: 'attached', timeout });
                await fileInputLocator.setInputFiles(localFilePath, { timeout });
              } else {
                // Nearby input detected in evaluate() but Playwright locator couldn't reach it
                // (e.g., closed shadow DOM). Fall back to fileChooser → drag-drop chain.
                await uploadViaFileChooserOrDrop(page, locator, localFilePath, downloadedFilename, downloadedContentType, timeout);
              }
            } else {
              // Attempt 2: No hidden file input found anywhere near the trigger.
              // Try fileChooser interception first (works with programmatic input.click()),
              // then fall back to synthetic drag-drop (for drop-only zones).
              await uploadViaFileChooserOrDrop(page, locator, localFilePath, downloadedFilename, downloadedContentType, timeout);
            }
          }
        } finally {
          if (needsCleanup) {
            const { cleanupUploadTempFile } = await import('@/agent/execution/file-download.service');
            setTimeout(() => {
              cleanupUploadTempFile(localFilePath).catch(() => {});
            }, 10_000);
          }
        }
        break;
      }

      default:
        return { success: false, error: `Unknown action type: ${step.type}`, urlChanged: false };
    }

    const urlAfter = page.url();
    return { success: true, urlChanged: urlBefore !== urlAfter };
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    logger.warn('[PREVIEW_APPLY] Action execution failed', {
      stepType: step.type,
      candidateRef: candidate.ref,
      error: rawMsg,
    });
    // Translate Playwright actionability failures into a hint that points
    // at the previous step. Recorded tests that submit a form often pair a
    // "fill last field" + "click Submit" pair where Submit is gated until
    // the form validates — if validation needs more than ACTION_TIMEOUT_MS
    // (e.g. server-side validation roundtrip), Playwright will throw with
    // generic "element is not enabled" / "not stable" / "intercepts pointer
    // events" messages. Wrapping with a clearer hint saves users a long
    // debugging trip.
    let augmentedMsg = rawMsg;
    if (/element is not enabled|not enabled|disabled/i.test(rawMsg)) {
      augmentedMsg = `${rawMsg}\n\n[hint] The target was still disabled at click time. The previous step may not have brought the form into a valid/enabled state. Check that the prior fill/select step actually applied (it might have failed silently, or the app does async validation that exceeds the action timeout).`;
    } else if (/element is not visible|hidden/i.test(rawMsg) && !/timeout/i.test(rawMsg)) {
      augmentedMsg = `${rawMsg}\n\n[hint] The target wasn't visible. Possible causes: the previous step closed/navigated away, the element is inside a collapsed accordion, or a modal moved it off-screen.`;
    } else if (/intercepts pointer events|element is outside of the viewport/i.test(rawMsg)) {
      augmentedMsg = `${rawMsg}\n\n[hint] Another element is on top of the target (sticky header, modal backdrop) or the element is offscreen. A scroll-into-view or close-modal step before this one may be missing.`;
    }
    return {
      success: false,
      error: augmentedMsg,
      urlChanged: page.url() !== urlBefore,
    };
  }
}

/**
 * Preview Step Apply Service
 */
export class PreviewStepApplyService {
  /**
   * V26 Batch A — Single failure-result builder for the whole apply path.
   *
   * Why this exists: applyStep historically had ~29 different `return {
   * success: false, ... }` sites — wait_for timeouts, select-no-match,
   * upload-no-file, navigate failures, fake-success rejections, etc. Only
   * the final resolver-exhaustion path bothered to attach
   * `failureEvidence`, so 95% of user-visible failures shipped to the UI
   * with a bare error string and no diagnostic bundle.
   *
   * Centralizing here means:
   *   1. Every failure that goes through this helper gets the same
   *      page-state evidence (URL, title, node count, recorded
   *      fingerprint presence) for the UI's "needs review" panel.
   *   2. Adding a new field to the bundle is one diff, not 29.
   *   3. The collector's try/catch is in ONE place — every caller is
   *      shielded from collector throws.
   *
   * Constraints:
   *   - Best-effort. Caller MUST be able to fail even if collector
   *     throws — never re-throw, swallow + log.
   *   - Don't override decisionTrace / highlight / etc. when caller
   *     already populated them; pass-through.
   *   - `skipBundle: true` for early failures where `page` may be
   *     unusable (session expired, page closed) — return result with
   *     no bundle but same shape.
   *
   * Not yet covered: per-attempt failure tracking. We don't yet thread
   * each compiled-locator / lint-candidate failure into `attempts[]` —
   * that needs the resolver loop to record per-attempt diagnostics. For
   * now, `attempts` defaults to a single synthetic record built from the
   * caller-provided context (originatingStrategy + matched flag).
   */
  private static async _buildFailureResult(opts: {
    previewSessionId: string;
    stepDraft: IntentStep;
    page: Page | null;
    error: string;
    /**
     * Where in the apply pipeline did this failure originate. Surfaced
     * in the bundle so the dashboard can group/filter by failure mode
     * instead of staring at 29 indistinguishable "step failed" rows.
     */
    originatingStrategy:
      | 'wait_for_timeout'
      | 'wait_for_email_failed'
      | 'select_no_match'
      | 'upload_no_file'
      | 'navigate_failed'
      | 'click_action_threw'
      | 'fake_success_guard'
      | 'pre_click_label_mismatch'
      | 'resolver_exhausted'
      | 'session_invalid'
      | 'apply_threw'
      | 'other';
    /** Caller-provided count of attempts so far (default 1). */
    attempts?: number;
    /** Optional decisionTrace if caller already built one. */
    decisionTrace?: StepDecisionTrace;
    /** Optional highlight overlay (resolved candidates that we tried). */
    highlight?: ApplyResult['highlight'];
    /** Optional resolvedCandidates → seeds the attempts[] array in bundle. */
    resolvedCandidates?: LintCandidate[];
    /** Skip page-state collection (session/page is gone — collector would throw). */
    skipBundle?: boolean;
    /** Extra fields to merge into final ApplyResult (e.g. urlChanged, retried). */
    extra?: Partial<ApplyResult>;
  }): Promise<ApplyResult> {
    const {
      previewSessionId,
      stepDraft,
      page,
      error,
      originatingStrategy,
      attempts = 1,
      decisionTrace,
      highlight,
      resolvedCandidates,
      skipBundle,
      extra,
    } = opts;

    let failureBundle: StepFailureEvidence | undefined;
    if (!skipBundle && page) {
      try {
        const { collectFailureEvidence } = await import('./failure-collector.service');
        // sessionService is the module factory — calling getSession by ref
        // is enough; helper is a static method so we can't use the
        // applyStep-local `sessionService` const. Recreate factory here.
        const sessSvc = getPreviewSessionService();
        const sess = sessSvc.getSession(previewSessionId);
        const interactiveNodeCount = sess?.pageState?.domNodes?.length;
        // Synthetic attempts[] from resolved candidates (if any). When
        // caller had no candidates (validation failure, session error)
        // emit a single record marked with the originating strategy so
        // the bundle is never empty.
        const attemptRecords = (resolvedCandidates ?? []).length > 0
          ? resolvedCandidates!.map((c) => ({
              strategy: 'lint_candidate',
              matched: !!c.ref,
              failureKind: originatingStrategy,
              value: c.ref ? `[data-agent-ref="${c.ref}"]` : undefined,
            }))
          : [{
              strategy: originatingStrategy,
              matched: false,
              failureKind: originatingStrategy,
            }];
        failureBundle = await collectFailureEvidence({
          step: stepDraft,
          page,
          totalAttempts: attempts,
          originatingStrategy,
          lastError: error,
          attempts: attemptRecords,
          interactiveNodeCount,
        });
      } catch (collectorErr) {
        logger.warn('[PREVIEW_APPLY] Failure collector threw — skipping bundle', {
          previewSessionId,
          stepId: stepDraft.id,
          originatingStrategy,
          error: collectorErr instanceof Error ? collectorErr.message : String(collectorErr),
        });
      }
    }

    // Merge logic: caller's `extra` may carry an appliedStep variant
    // (e.g. navigate path stamps `compiled` onto stepDraft). We must
    // PRESERVE that AND attach failureEvidence on top — losing either
    // breaks downstream (no compiled = re-LLM next run; no bundle =
    // silent failure to user). Resolve by deep-merging:
    //   extra.appliedStep ?? stepDraft  → base
    //   + failureEvidence on top         → final
    const baseAppliedStep =
      (extra && (extra as any).appliedStep)
        ? (extra as any).appliedStep
        : stepDraft;
    const appliedStepWithFailure = failureBundle
      ? { ...baseAppliedStep, failureEvidence: failureBundle }
      : (extra && (extra as any).appliedStep ? baseAppliedStep : undefined);

    // Strip appliedStep from extra so the spread below doesn't clobber
    // our merged version — and retain everything else verbatim.
    const extraWithoutAppliedStep = extra ? { ...extra } : {};
    delete (extraWithoutAppliedStep as any).appliedStep;

    return {
      success: false,
      error,
      attempts,
      ...(decisionTrace ? { decisionTrace } : {}),
      ...(highlight ? { highlight } : {}),
      ...extraWithoutAppliedStep,
      ...(appliedStepWithFailure ? { appliedStep: appliedStepWithFailure } : {}),
    };
  }

  /**
   * Apply a step in the preview session
   * Tries top candidates with limited retries
   * V3: If selectedRef is provided (from user clarification), use it directly
   */
  static async applyStep(params: {
    previewSessionId: string;
    stepDraft: IntentStep;
    pageRef?: string;
    userId: string;
    selectedRef?: string; // V3: User-confirmed element ref from clarification
    skipPostActionWait?: boolean; // V12: Skip post-action settle when caller uses lookahead (e.g. Run mode)
    expectsNavigation?: boolean; // V13: Next step is wait_for with changedFrom — wrap click with waitForNavigation
    skipCompiled?: boolean; // Skip compiled shortcut (stale plans after deploy or URL change)
  }): Promise<ApplyResult> {
    const { previewSessionId, userId, selectedRef, skipPostActionWait, expectsNavigation } = params;
    let { stepDraft } = params;

    // V23: Aggregate decision trace across all branches. Every meaningful
    // decision point writes into this; final result returns it. Use a
    // fresh object — never mutate from a caller's reference.
    const decisionTrace: StepDecisionTrace = {};
    const traceTimingStart = Date.now();
    const setTrace = (patch: Partial<StepDecisionTrace>): void => {
      Object.assign(decisionTrace, patch);
    };
    const setTraceCompiled = (patch: Partial<NonNullable<StepDecisionTrace['compiled']>>): void => {
      decisionTrace.compiled = { ...(decisionTrace.compiled || { available: false }), ...patch };
    };
    const setTraceTiming = (patch: Partial<NonNullable<StepDecisionTrace['timing']>>): void => {
      decisionTrace.timing = { ...(decisionTrace.timing || {}), ...patch };
    };
    // Capture the recorded snapshot once at the start so all branches share
    // the same baseline for diff against `chosen`. Truncate text fields to
    // keep the JSONL line readable.
    if (stepDraft.recordedFingerprint) {
      const rfp = stepDraft.recordedFingerprint;
      decisionTrace.recorded = {
        tag: rfp.tag,
        role: rfp.role,
        label: rfp.labelText || rfp.ariaLabel || rfp.title,
        text: rfp.text ? rfp.text.slice(0, 60) : undefined,
        id: rfp.elementId,
        testIdAttr: rfp.testIdAttr,
        bbox: rfp.boundingBox,
      };
    }

    // ── Scratchpad + workspace vars: interpolate {{key}} placeholders ──
    // Resolves cross-step data (OTP codes, stored values, extracted text)
    // and workspace resources (env / secret / data_fixture variables —
    // populated when bindings have been applied to the preview session)
    // before locator resolution. Same source priority as preview-run.
    // Phase 2.5: collect secret values once per applyStep call so the
    // intent-resolve-audit log lines (potentially several per apply via
    // pre-lint + apply + post-verify reject paths) can redact the
    // post-interpolation step body before persisting it to JSONL.
    let secretValuesForAudit: readonly string[] = [];
    try {
      const sessionService = getPreviewSessionService();
      const session = sessionService.getSession(previewSessionId);
      const contextData = session?.contextData;
      const runVariables = (session as { contextRunVariables?: Map<string, unknown> } | undefined)?.contextRunVariables;
      secretValuesForAudit = collectSecretValues(runVariables ?? null);
      const hasContext = !!contextData && Object.keys(contextData).length > 0;
      const hasRunVars = !!runVariables && runVariables.size > 0;
      if (hasContext || hasRunVars) {
        const sources = [
          recordSource('contextData', contextData ?? null),
          ...(hasRunVars
            ? [{
                name: 'runVariables',
                lookup: (k: string) => (runVariables as Map<string, unknown>).get(k),
              }]
            : []),
        ];
        const resolved = { ...stepDraft };
        if (resolved.value) resolved.value = resolvePlaceholders(resolved.value, sources);
        if (resolved.assertionText) resolved.assertionText = resolvePlaceholders(resolved.assertionText, sources);
        stepDraft = resolved;
      }
    } catch {
      // Non-critical — proceed without interpolation
    }

    logger.info('[PREVIEW_APPLY] Applying step', {
      previewSessionId,
      stepType: stepDraft.type,
      descriptionPreview: sanitizeIntent(stepDraft).slice(0, 80),
      selectedRef: selectedRef || 'none (will lint)',
    });

    // Every single-step Apply is user-intent: the user clicked "Apply" in
    // the editor, so any cross-origin navigation that results (even from a
    // click step) is an intentional consequence of that action. Mark intent
    // once per apply so the external-nav trap gives the step a 3s window to
    // settle without reverting.
    try {
      const { markIntentionalGoto } = await import('./external-nav-trap');
      markIntentionalGoto(previewSessionId, '');
    } catch { /* non-fatal */ }

    try {
      const sessionService = getPreviewSessionService();

      // ── Scratchpad: handle 'store' meta-step ──
      if (stepDraft.type === 'store') {
        const storeKey = stepDraft.description?.trim();
        const storeValue = stepDraft.value;
        if (storeKey && storeValue) {
          // Merge into existing contextData (setContextData replaces the full object)
          const session = sessionService.getSession(previewSessionId);
          const existingData = session?.contextData || {};
          sessionService.setContextData(previewSessionId, userId, { ...existingData, [storeKey]: storeValue });
        }
        return {
          success: true,
          appliedStep: stepDraft,
        };
      }

      // V15: Handle switch_tab action — switch active tab and return
      if (stepDraft.type === 'switch_tab') {
        const targetTab = parseInt(stepDraft.value || '0', 10);

        // Wait for tab to appear if not yet available (popup handler is async)
        let switched = false;
        for (let wait = 0; wait < 10; wait++) {
          switched = await sessionService.switchTab(previewSessionId, userId, targetTab);
          if (switched) break;
          await new Promise(r => setTimeout(r, 500)); // 500ms × 10 = 5s max wait
        }

        // V18: Lightweight settle after switch — just domcontentloaded (fast).
        // Full readiness (loading indicators, DOM stable, element visible) is handled
        // by the lookahead system in preview-run loop, which now runs after switch_tab.
        if (switched) {
          const newPage = sessionService.getPage(previewSessionId, userId);
          if (newPage) {
            try { await newPage.waitForLoadState('domcontentloaded', { timeout: 5_000 }); } catch { /* proceed */ }
          }
        }

        return {
          success: switched,
          error: switched ? undefined : `Tab ${targetTab} not available after waiting`,
          url: sessionService.getPage(previewSessionId, userId)?.url() || '',
          attempts: 1,
        };
      }

      // close_tab action — symmetric replay of a recording-time × click.
      // Soft-success semantics: if the target tab is already gone (closed
      // by the site, evicted, never opened on this replay because a popup
      // step earlier was skipped), we treat the step as a no-op success.
      // The user intent "this tab should not exist anymore" is already
      // true; failing the step here would block downstream actions for
      // no good reason. The only hard failure path is closeTab returning
      // false WHILE the tab still exists (e.g. tab index 0 with no other
      // tabs — the root guard refuses). That's surfaced as an explicit
      // error so the user sees why replay diverges.
      if (stepDraft.type === 'close_tab') {
        const targetTab = parseInt(stepDraft.value || '0', 10);
        const session = sessionService.getSession(previewSessionId);
        const tabExists = !!session && targetTab >= 0 && targetTab < session.pages.length;
        if (!tabExists) {
          return {
            success: true,
            url: sessionService.getPage(previewSessionId, userId)?.url() || '',
            attempts: 1,
          };
        }
        const closed = await sessionService.closeTab(previewSessionId, userId, targetTab);
        return {
          success: closed,
          error: closed
            ? undefined
            : `Could not close tab ${targetTab} (root tab is protected when it's the only one)`,
          url: sessionService.getPage(previewSessionId, userId)?.url() || '',
          attempts: 1,
        };
      }

      // open_tab action — create a new tab and navigate it to `value` (URL).
      // The new tab becomes active (popup-adoption semantics). A URL is
      // required; openTab refuses an empty value because a blank tab is
      // auto-closed by the popup handler.
      if (stepDraft.type === 'open_tab') {
        const url = (stepDraft.value || '').trim();
        const opened = await sessionService.openTab(previewSessionId, userId, url);

        // V18: Lightweight settle after open — domcontentloaded only. Full
        // readiness for the new page is handled by the lookahead before the
        // next step (same pattern as switch_tab).
        if (opened) {
          const newPage = sessionService.getPage(previewSessionId, userId);
          if (newPage) {
            try { await newPage.waitForLoadState('domcontentloaded', { timeout: 5_000 }); } catch { /* proceed */ }
          }
        }

        return {
          success: opened,
          error: opened ? undefined : (url ? `Could not open new tab at ${url}` : 'open_tab requires a URL'),
          url: sessionService.getPage(previewSessionId, userId)?.url() || '',
          attempts: 1,
        };
      }

      // V15: Auto-switch tab if step targets a different tab than currently active
      const session = sessionService.getSession(previewSessionId);
      if (session && stepDraft.tabIndex !== undefined && stepDraft.tabIndex !== session.activeTabIndex) {
        // Wait for tab if not yet available (popup may still be loading)
        let switched = false;
        for (let wait = 0; wait < 6; wait++) {
          switched = await sessionService.switchTab(previewSessionId, userId, stepDraft.tabIndex);
          if (switched) break;
          await new Promise(r => setTimeout(r, 500));
        }
        if (!switched) {
          return {
            success: false,
            error: `Tab ${stepDraft.tabIndex} no longer available`,
            url: session.page?.url() || '',
            attempts: 0,
          };
        }
        // V18: Lightweight settle after auto-switch — just domcontentloaded.
        // Full readiness handled by lookahead (which now runs after switch_tab).
        const switchedPage = sessionService.getPage(previewSessionId, userId);
        if (switchedPage) {
          try { await switchedPage.waitForLoadState('domcontentloaded', { timeout: 5_000 }); } catch { /* proceed */ }
        }
      }

      // Get page from session (may have changed after tab switch)
      const page = sessionService.getPage(previewSessionId, userId);

      if (!page) {
        return {
          success: false,
          error: 'Preview session not found or expired',
        };
      }

      // Handle non-targeting actions (navigate, wait, timeout, scroll)
      // Scroll is page-level: uses step.value (deltaY) without targeting a DOM element
      if (['navigate', 'wait', 'timeout', 'scroll'].includes(stepDraft.type)) {
        // V5: Capture URL BEFORE action for accurate compiled context
        // This is important for auto-wait-for-url injection which compares adjacent pageUrls
        const urlBeforeAction = page.url();

        // ── Progress events for navigate (slow site feedback) ──
        let navProgressInterval: ReturnType<typeof setInterval> | null = null;
        if (stepDraft.type === 'navigate') {
          const navStart = Date.now();
          const navUrl = stepDraft.value || '';
          navProgressInterval = setInterval(() => {
            const elapsed = Date.now() - navStart;
            if (elapsed >= 5000) {
              webSocketService.emitToRoom('preview', previewSessionId, 'preview:loading', {
                previewSessionId, phase: 'navigating' as const, url: navUrl, elapsedMs: elapsed,
              });
            }
          }, 3000);
        }

        let result;
        try {
          result = await executeAction(page, stepDraft, { label: '', reason: '', confidence: 1 }, undefined, { secretValues: secretValuesForAudit });
          // Emit complete phase for navigate
          if (stepDraft.type === 'navigate') {
            const navUrl = stepDraft.value || '';
            webSocketService.emitToRoom('preview', previewSessionId, 'preview:loading', {
              previewSessionId, phase: 'complete' as const, url: navUrl, elapsedMs: Date.now() - (navProgressInterval ? Date.now() : 0),
            });
          }
        } catch (navErr) {
          // Emit error phase for navigate
          if (stepDraft.type === 'navigate') {
            const navUrl = stepDraft.value || '';
            webSocketService.emitToRoom('preview', previewSessionId, 'preview:loading', {
              previewSessionId, phase: 'error' as const, url: navUrl, elapsedMs: 0,
              error: navErr instanceof Error ? navErr.message : String(navErr),
            });
          }
          throw navErr;
        } finally {
          if (navProgressInterval) clearInterval(navProgressInterval);
        }

        // Generate compiled plan for non-targeting actions
        // Use urlBeforeAction to record the context where action was initiated
        let compiled;
        try {
          compiled = LocatorPlanBuilder.buildCompiledPlanForNonTargetingAction({
            step: stepDraft,
            pageUrl: urlBeforeAction,
            pageTitle: await page.title().catch(() => undefined),
          });
        } catch (compileError) {
          logger.warn('[PREVIEW_APPLY] Failed to generate compiled plan for non-targeting action', {
            error: compileError instanceof Error ? compileError.message : String(compileError),
          });
        }

        // V26 Batch A: navigate/wait/scroll failures used to ship a bare
        // error string. Now we attach failureEvidence on failure so the UI
        // shows page state at the moment things broke.
        if (!result.success) {
          return await PreviewStepApplyService._buildFailureResult({
            previewSessionId,
            stepDraft,
            page,
            error: result.error || `${stepDraft.type} failed`,
            originatingStrategy: stepDraft.type === 'navigate' ? 'navigate_failed' : 'other',
            attempts: 1,
            extra: {
              appliedStep: { ...stepDraft, compiled },
              urlChanged: result.urlChanged,
              url: page.url(),
            },
          });
        }
        return {
          success: true,
          appliedStep: {
            ...stepDraft,
            compiled,
          },
          urlChanged: result.urlChanged,
          url: page.url(), // Current URL after action (may have changed)
          attempts: 1,
        };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V5: Handle wait_for (SPA-safe URL waiting)
      // ═══════════════════════════════════════════════════════════════════════
      if (stepDraft.type === 'wait_for') {
        const urlBefore = page.url();
        const matcher = stepDraft.options?.urlMatcher;
        // V5.1: timeout is now primary (required from frontend), urlMatcher.timeoutMs is fallback
        const timeoutMs = stepDraft.options?.timeout ?? matcher?.timeoutMs ?? 15000;

        // V13 fix: changedFrom holds the URL from before navigation (recording-time).
        // If the current URL already differs from changedFrom, navigation already happened
        // (e.g. previous click used expectsNavigation=true) — skip the wait entirely.
        // Only replace changedFrom with current URL when they still match (navigation pending).
        let runtimeMatcher = matcher;
        if (matcher?.changedFrom) {
          const currentUrl = page.url();
          if (normalizeUrlForComparison(currentUrl) !== normalizeUrlForComparison(matcher.changedFrom)) {
            // URL already changed — navigation happened via expectsNavigation on previous click.
            // V15: Must still wait for SPA rendering before returning. Without this,
            // the next step starts before the new page content is rendered (race condition:
            // URL changed but React/Vue/Angular hasn't hydrated the new route yet).
            const settleStartMs = Date.now();
            const settleBudget = Math.min(3000, Math.max(1000, timeoutMs / 2));
            try {
              await page.waitForLoadState('load', { timeout: settleBudget });
            } catch { /* timeout acceptable — DOM may still be usable */ }
            const remainingSettle = Math.max(500, settleBudget - (Date.now() - settleStartMs));
            await waitForPageSettled(page, remainingSettle, 500);

            logger.info('[PREVIEW_APPLY] wait_for: URL already changed, settled before continuing', {
              previewSessionId,
              changedFrom: matcher.changedFrom,
              currentUrl: page.url(),
              settleMs: Date.now() - settleStartMs,
            });
            return {
              success: true,
              appliedStep: stepDraft,
              urlChanged: true,
              url: page.url(),
              attempts: 1,
              fastPathSettled: true,
              waitForBranch: 'fast_path',
              waitForChangedFrom: matcher.changedFrom,
              waitForUrlBefore: urlBefore,
            };
          }
          // URL hasn't changed yet — replace changedFrom with current URL for runtime
          runtimeMatcher = { ...matcher, changedFrom: currentUrl };
        }

        logger.info('[PREVIEW_APPLY] Handling wait_for', {
          previewSessionId,
          matcher: runtimeMatcher ? Object.keys(runtimeMatcher).filter(k => (runtimeMatcher as any)[k] !== undefined) : [],
          timeoutMs,
          changedFromOverride: matcher?.changedFrom ? `${matcher.changedFrom} → ${page.url()}` : undefined,
        });

        // Pick a diagnostic branch label for the slow path. `runtime_changed`
        // means matcher had a changedFrom but current URL still matched it, so
        // we rewrote changedFrom to the current URL before handing off to
        // executeWaitFor. `slow_path` means no changedFrom (substring/regex/etc).
        // `no_matcher` means the step had no urlMatcher at all (timeout-only).
        const slowPathBranch: 'runtime_changed' | 'slow_path' | 'no_matcher' = !matcher
          ? 'no_matcher'
          : matcher.changedFrom
            ? 'runtime_changed'
            : 'slow_path';

        try {
          const result = await executeWaitFor(page, runtimeMatcher, timeoutMs, stepDraft.isAutoInjected === true);
          if (result.degraded === 'page_settled') {
            logger.info('[PREVIEW_APPLY] wait_for degraded to page-settle (auto-injected)', {
              previewSessionId,
              stepId: stepDraft.id,
            });
          }

          // Generate compiled plan for wait_for
          let compiled;
          try {
            compiled = LocatorPlanBuilder.buildCompiledPlanForNonTargetingAction({
              step: stepDraft,
              pageUrl: page.url(),
              pageTitle: await page.title().catch(() => undefined),
            });
          } catch (compileError) {
            logger.warn('[PREVIEW_APPLY] Failed to generate compiled plan for wait_for', {
              error: compileError instanceof Error ? compileError.message : String(compileError),
            });
          }

          return {
            success: result.success,
            error: result.error,
            appliedStep: {
              ...stepDraft,
              compiled,
            },
            urlChanged: urlBefore !== page.url(),
            url: page.url(),
            attempts: 1,
            waitForBranch: result.degraded === 'page_settled' ? 'runtime_settle' : slowPathBranch,
            waitForChangedFrom: matcher?.changedFrom,
            waitForUrlBefore: urlBefore,
          };
        } catch (error) {
          // V26 Batch A: was silent failure — returns error string with no
          // failureEvidence. UI sees "wait_for failed" with no page state.
          // Now collects screenshot/HTML/console at the moment of timeout.
          return await PreviewStepApplyService._buildFailureResult({
            previewSessionId,
            stepDraft,
            page,
            error: error instanceof Error ? error.message : 'wait_for failed',
            originatingStrategy: 'wait_for_timeout',
            attempts: 1,
            extra: {
              urlChanged: urlBefore !== page.url(),
              url: page.url(),
              waitForBranch: slowPathBranch,
              waitForChangedFrom: matcher?.changedFrom,
              waitForUrlBefore: urlBefore,
            },
          });
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V13: Handle dialog steps (pre-install handler for upcoming dialog)
      // ═══════════════════════════════════════════════════════════════════════
      if (stepDraft.type === 'dialog') {
        const dialogOpts = stepDraft.options?.dialog;
        if (!dialogOpts) {
          return {
            success: false,
            error: 'Dialog step missing dialog options',
            attempts: 0,
          };
        }

        logger.info('[PREVIEW_APPLY] Pre-installing dialog handler', {
          previewSessionId,
          dialogType: dialogOpts.dialogType,
          action: dialogOpts.action,
        });

        // Pre-install the pending dialog action on the session.
        // The next step (typically a click) will trigger the dialog,
        // and the session's dialog handler will consume this action.
        const sessionService = getPreviewSessionService();
        sessionService.setPendingDialogAction(previewSessionId, userId, {
          action: dialogOpts.action,
          promptText: dialogOpts.promptText,
        });

        return {
          success: true,
          appliedStep: stepDraft,
          url: page.url(),
          attempts: 1,
        };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V13: Handle download verification (wait for download event)
      // ═══════════════════════════════════════════════════════════════════════
      if (stepDraft.type === 'download') {
        const downloadOpts = stepDraft.options?.download;
        const expectedFilename = downloadOpts?.filename || stepDraft.value;
        const timeoutMs = downloadOpts?.timeoutMs || 15000;

        logger.info('[PREVIEW_APPLY] Waiting for download', {
          previewSessionId, expectedFilename, timeoutMs,
        });

        try {
          // Wait for the download event (triggered by the previous click)
          const download = await page.waitForEvent('download', { timeout: timeoutMs });
          const actualFilename = download.suggestedFilename();

          // Verify filename matches if expected
          if (expectedFilename && !actualFilename.toLowerCase().includes(expectedFilename.toLowerCase())) {
            // Cancel download to prevent temp file buildup
            await download.cancel().catch(() => {});
            return {
              success: false,
              error: `Download filename mismatch. Expected: "${expectedFilename}", Got: "${actualFilename}"`,
              appliedStep: stepDraft,
              url: page.url(),
              attempts: 1,
            };
          }

          // Cancel download (preview/test mode — we only verify it started)
          await download.cancel().catch(() => {});

          return {
            success: true,
            appliedStep: stepDraft,
            url: page.url(),
            attempts: 1,
          };
        } catch (error) {
          return {
            success: false,
            error: `Download did not start within ${timeoutMs}ms`,
            appliedStep: stepDraft,
            url: page.url(),
            attempts: 1,
          };
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V3: Handle ai_check assertions
      // ═══════════════════════════════════════════════════════════════════════
      if (stepDraft.type === 'ai_check') {
        logger.info('[PREVIEW_APPLY] Handling ai_check assertion', {
          previewSessionId,
          assertion: stepDraft.assertionText,
          contextMode: stepDraft.options?.aiContextMode || 'html+a11y+screenshot',
        });

        // Validate assertionText
        if (!stepDraft.assertionText || stepDraft.assertionText.trim().length === 0) {
          return {
            success: false,
            error: 'assertionText is required for ai_check',
            attempts: 0,
          };
        }

        try {
          // Import devtools collector, AI check service, and HTML context service
          const { fetchAccessibility } = await import('./preview-devtools-collector.service');
          const { evaluateAiCheck } = await import('./ai-check.service');
          const { buildSemanticHtmlFromPage } = await import('./html-context.service');

          // Determine context mode (default: html+a11y+screenshot)
          const contextMode = stepDraft.options?.aiContextMode || 'html+a11y+screenshot';

          // Gather context based on mode
          let html: string | undefined;
          let a11yTree: any[] | undefined;
          let screenshotBase64: string | undefined;

          const sessionService = getPreviewSessionService();

          // Feature flag: use semantic HTML builder (default: ON)
          const useSemanticHtml = process.env.AI_CHECK_SEMANTIC_HTML !== '0';

          if (contextMode.includes('html')) {
            if (useSemanticHtml) {
              try {
                // Use semantic HTML builder with token budgeting
                const semanticResult = await buildSemanticHtmlFromPage(page, {
                  assertionText: stepDraft.assertionText,
                  tokenBudget: 8000,
                  expandForNegative: true,
                });
                html = semanticResult.html;
                
                logger.debug('[PREVIEW_APPLY] Using semantic HTML for ai_check', {
                  previewSessionId,
                  originalLength: semanticResult.originalLength,
                  semanticLength: semanticResult.semanticLength,
                  tokens: semanticResult.tokens,
                  reduction: `${Math.round((1 - semanticResult.semanticLength / semanticResult.originalLength) * 100)}%`,
                });
              } catch (semanticError) {
                // Fallback to raw HTML if semantic builder fails
                logger.warn('[PREVIEW_APPLY] Semantic HTML builder failed, falling back to raw HTML', {
                  previewSessionId,
                  error: semanticError instanceof Error ? semanticError.message : String(semanticError),
                });
                const rawHtml = await page.content();
                html = rawHtml.substring(0, 100 * 1024); // Fallback: 100KB truncation
              }
            } else {
              // Legacy path: use raw HTML
              const { fetchHtml } = await import('./preview-devtools-collector.service');
              const htmlPayload = await fetchHtml(page, previewSessionId, 0);
              html = htmlPayload.html;
            }
          }

          if (contextMode.includes('a11y')) {
            const a11yPayload = await fetchAccessibility(page, previewSessionId, 0);
            a11yTree = a11yPayload.tree;
          }

          if (contextMode.includes('screenshot')) {
            const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
              force: true,
              includeScreenshot: true,
              includeDomNodes: false,
            });
            screenshotBase64 = snapshot?.screenshot;
            if (!screenshotBase64) {
              logger.warn('[PREVIEW_APPLY] ai_check screenshot not available from snapshot', {
                previewSessionId,
              });
            }
          }

          // Evaluate AI check — wrap in tracking context so the LLM call shows
          // up in the user's AI activity feed labelled as 'ai-check'.
          // Hoist `assertionText` so TS narrowing isn't lost across the closure.
          const _assertionText = stepDraft.assertionText as string;
          const _pageUrl = page.url();

          // Editor trace: ai_check is a separate code path that bypasses
          // executeAction, so it never emits action_attempt / action_result /
          // llm_request_*. Without these events the step is invisible in
          // the trace (only run_summary records the final pass/fail). Bracket
          // the call ourselves so reading the JSONL tells the full story.
          const aiCheckStartedAt = Date.now();
          try {
            EditorTraceService.get(previewSessionId)?.writeLlmRequestStart({
              stepId: stepDraft.id,
              purpose: 'diagnosis',
            });
          } catch { /* non-fatal */ }

          const aiCheckResult = await Promise.resolve(
            withAIContext(
              {
                workspaceId: '',
                userId,
                operationType: 'lite-test',
                logSource: 'ai-check',
                logActionType: 'assert',
                logEntityType: 'test_execution',
                logEntityId: previewSessionId,
              },
              () =>
                evaluateAiCheck({
                  assertionText: _assertionText,
                  url: _pageUrl,
                  html,
                  a11yTree,
                  screenshotBase64,
                }),
            ),
          );

          try {
            const aiCheckTrace = EditorTraceService.get(previewSessionId);
            aiCheckTrace?.writeLlmRequestEnd({
              stepId: stepDraft.id,
              purpose: 'diagnosis',
              durationMs: Date.now() - aiCheckStartedAt,
              success: aiCheckResult.pass,
              confidence: aiCheckResult.confidence,
              ...(aiCheckResult.pass ? {} : { errorReason: (aiCheckResult.explanation || '').slice(0, 200) }),
            });
            aiCheckTrace?.writeActionResult({
              stepId: stepDraft.id,
              stepType: stepDraft.type,
              success: aiCheckResult.pass,
              durationMs: Date.now() - aiCheckStartedAt,
              ...(aiCheckResult.pass ? {} : { error: (aiCheckResult.explanation || 'ai_check failed').slice(0, 200) }),
            });
          } catch { /* non-fatal */ }

          logger.info('[PREVIEW_APPLY] ai_check evaluation completed', {
            previewSessionId,
            pass: aiCheckResult.pass,
            confidence: aiCheckResult.confidence,
            explanation: aiCheckResult.explanation,
            highlightRefsCount: aiCheckResult.highlightRefs?.length || 0,
          });

          /**
           * V4: Best-effort highlight mapping for ai_check.
           *
           * We can only reliably highlight DOM elements when the model returns `data-agent-ref` values
           * (highlightRefs). Those refs are mapped to `InteractiveNode.boundingBox` when available.
           *
           * Limitations:
           * - If HTML lacks `data-agent-ref` attributes, `highlightRefs` will likely be empty.
           * - If domNodes are not available (ownership / snapshot missing), highlights may miss boundingBox.
           */
          let highlight: ApplyResult['highlight'] = [];
          if (aiCheckResult.highlightRefs && aiCheckResult.highlightRefs.length > 0) {
            const isOwned = sessionService.isSessionOwned(previewSessionId, userId);
            if (!isOwned) {
              logger.warn('[PREVIEW_APPLY] Skip ai_check highlight mapping: session is not owned by user', {
                previewSessionId,
                userId,
              });
            } else {
              // Force-including domNodes is cheap when throttled (reuses session.pageState.domNodes).
              // When not throttled, it collects a fresh snapshot and updates session.pageState.
              const snapshotWithDom = await sessionService.getSnapshot(previewSessionId, userId, {
                force: true,
                includeDomNodes: true,
                includeScreenshot: false,
              });
              const domNodes = snapshotWithDom?.domNodes ?? sessionService.getSession(previewSessionId)?.pageState?.domNodes ?? [];

              highlight = aiCheckResult.highlightRefs.map((ref) => {
                const node = domNodes.find((n) => n.ref === ref);
                return {
                  ref,
                  boundingBox: node?.boundingBox,
                  type: aiCheckResult.pass ? 'success' : 'error',
                };
              });
            }
          }

          // Build appliedStep with evidence
          const updatedStep: IntentStep = {
            ...stepDraft,
            evidence: {
              ...stepDraft.evidence,
              confidence: aiCheckResult.confidence,
              resolutionMeta: {
                allowedCount: 1,
                usedRules: ['ai_check'],
                usedLLM: false,
                confidenceTier: (aiCheckResult.confidence || 0) >= 0.85 ? 'high' :
                                (aiCheckResult.confidence || 0) >= 0.6 ? 'medium' : 'low',
              },
            },
            // No compiled plan for ai_check (it's evaluated by LLM, not by locators)
          };

          return {
            success: aiCheckResult.pass,
            error: aiCheckResult.pass ? undefined : aiCheckResult.explanation,
            appliedStep: updatedStep,
            urlChanged: false,
            url: page.url(),
            highlight,
            attempts: 1,
          };
        } catch (error) {
          logger.error('[PREVIEW_APPLY] ai_check evaluation failed', {
            previewSessionId,
            error: error instanceof Error ? error.message : String(error),
          });

          return {
            success: false,
            error: `AI check failed: ${error instanceof Error ? error.message : String(error)}`,
            attempts: 0,
          };
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V12: Handle wait_for_email (IMAP polling + AI extraction)
      // ═══════════════════════════════════════════════════════════════════════
      if (stepDraft.type === 'wait_for_email') {
        const emailFilter = stepDraft.options?.emailFilter;
        if (!emailFilter?.extractPrompt || !emailFilter?.extractVariable) {
          return {
            success: false,
            error: 'emailFilter with extractPrompt and extractVariable is required for wait_for_email',
            attempts: 0,
          };
        }

        logger.info('[PREVIEW_APPLY] Handling wait_for_email', {
          previewSessionId,
          extractVariable: emailFilter.extractVariable,
          subject: emailFilter.subject,
          from: emailFilter.from,
        });

        try {
          const { EmailInboxService } = await import('@/services/testing/email-inbox/email-inbox.service');

          if (!EmailInboxService.isConfigured()) {
            return {
              success: false,
              error: 'Email inbox not configured. Set IMAP_USER and IMAP_PASSWORD in environment.',
              attempts: 0,
            };
          }

          // Get or generate inbox address from session contextData
          const sessionService = getPreviewSessionService();
          const session = sessionService.getSession(previewSessionId);
          const contextData = session?.contextData || {};

          // Use existing inbox address or generate a new one
          let inboxAddress = contextData['email._inboxAddress'] as string | undefined;
          if (!inboxAddress) {
            inboxAddress = EmailInboxService.generateAddress(previewSessionId);
            // Store in session contextData for subsequent steps
            if (session) {
              session.contextData['email._inboxAddress'] = inboxAddress;
            }
          }

          const timeoutMs = stepDraft.options?.timeout ?? 60_000;

          // Poll IMAP for matching email
          const result = await EmailInboxService.waitForEmail({
            recipient: inboxAddress,
            filter: {
              subject: emailFilter.subject,
              from: emailFilter.from,
            },
            extractPrompt: emailFilter.extractPrompt,
            extractVariable: emailFilter.extractVariable,
            timeoutMs,
          });

          // Store extracted value in session contextData
          if (session && result.value) {
            session.contextData[`email.${emailFilter.extractVariable}`] = result.value;
          }

          // Build compiled plan for wait_for_email
          let compiled;
          try {
            const { LocatorPlanBuilder } = await import('./locator-plan-builder.service');
            compiled = LocatorPlanBuilder.buildCompiledPlanForNonTargetingAction({
              step: stepDraft,
              pageUrl: page.url(),
              pageTitle: await page.title().catch(() => undefined),
            });
          } catch {
            // Non-fatal
          }

          const updatedStep: IntentStep = {
            ...stepDraft,
            evidence: {
              ...stepDraft.evidence,
              confidence: result.confidence,
              resolutionMeta: {
                allowedCount: 1,
                usedRules: ['wait_for_email'],
                usedLLM: true,
                confidenceTier: result.confidence >= 0.85 ? 'high' :
                                result.confidence >= 0.6 ? 'medium' : 'low',
              },
            },
            compiled,
          };

          logger.info('[PREVIEW_APPLY] wait_for_email completed', {
            previewSessionId,
            extractVariable: emailFilter.extractVariable,
            valueLength: result.value.length,
            confidence: result.confidence,
            inboxAddress,
          });

          return {
            success: !!result.value,
            error: result.value ? undefined : `Email extraction returned empty value: ${result.reasoning}`,
            appliedStep: updatedStep,
            urlChanged: false,
            url: page.url(),
            attempts: 1,
          };
        } catch (error) {
          logger.error('[PREVIEW_APPLY] wait_for_email failed', {
            previewSessionId,
            error: error instanceof Error ? error.message : String(error),
          });

          return {
            success: false,
            error: `Email wait failed: ${error instanceof Error ? error.message : String(error)}`,
            attempts: 0,
          };
        }
      }

      // V3: If user confirmed a selection, use it directly without re-linting
      if (selectedRef) {
        logger.info('[PREVIEW_APPLY] Using user-confirmed selectedRef', {
          previewSessionId,
          selectedRef,
        });

        const confirmedCandidate: LintCandidate = {
          ref: selectedRef,
          label: 'User confirmed',
          reason: 'User selected from clarification options',
          confidence: 1.0,
        };

        // V5: Capture URL BEFORE action for accurate compiled context
        const urlBeforeAction = page.url();
        
        const result = await executeAction(page, stepDraft, confirmedCandidate, undefined, { expectsNavigation, secretValues: secretValuesForAudit });

        if (result.success) {
          // V16: Post-action settle via smartStepWait('post'). In run-mode
          // (skipPostActionWait) the between-step lookahead already does the
          // heavy lifting, so we skip the full plan here.
          if (!skipPostActionWait) {
            await smartStepWait({
              page,
              step: stepDraft,
              phase: 'post',
            }).catch(() => { /* non-fatal */ });
          }

          // Invalidate snapshot cache for DOM-mutating actions so next step's lint gets fresh nodes
          if (DOM_MUTATING_ACTIONS.has(stepDraft.type)) {
            const sess = sessionService.getSession(previewSessionId);
            if (sess) sess.lastSnapshotEmit = 0;
          }

          // Try to get the node from current session for compiled plan
          const isOwned = sessionService.isSessionOwned(previewSessionId, userId);
          const session = isOwned ? sessionService.getSession(previewSessionId) : undefined;
          const resolvedNode = session?.pageState?.domNodes?.find(n => n.ref === selectedRef);

          // Generate compiled plan if node is available
          // Use urlBeforeAction to record the context where element was found
          let compiled;
          if (resolvedNode) {
            try {
              // Local trace handle — the outer scope's `editorTrace`
              // (defined ~4379) hasn't been initialised yet at this
              // call site. Get a fresh handle so the validation event
              // lands on the same JSONL.
              const localTrace = EditorTraceService.get(previewSessionId);
              compiled = await LocatorPlanBuilder.buildCompiledPlan({
                step: stepDraft,
                resolvedNode,
                pageUrl: urlBeforeAction,
                pageTitle: await page.title().catch(() => undefined),
                page,
                // May 2026 — emit `compiled_validation` per-build so
                // forensic analysts can tell "plan was dead on arrival"
                // from a single JSONL line instead of cross-referencing
                // multiple compiled_attempt rows.
                onValidation: (stats) => {
                  try {
                    localTrace?.writeCompiledValidation({ stepId: stepDraft.id, ...stats });
                  } catch { /* trace never breaks apply path */ }
                },
              });
            } catch (compileError) {
              logger.warn('[PREVIEW_APPLY] Failed to generate compiled plan for user-confirmed selection', {
                error: compileError instanceof Error ? compileError.message : String(compileError),
              });
            }
          } else if (!isOwned) {
            logger.warn('[PREVIEW_APPLY] Skip compiled plan: session is not owned by user', {
              previewSessionId,
              userId,
            });
          }

          // Build resolution meta for user-confirmed selection
          const resolutionMeta: ResolutionMeta = {
            allowedCount: 1,
            usedRules: ['user_confirmed'],
            usedLLM: false,
            confidenceTier: 'high' as ConfidenceTier,
          };

          // V2: Auto-populate bindingHints from resolved node
          const enrichedBindingHints = resolvedNode
            ? { ...stepDraft.bindingHints, ...buildBindingHintsFromNode(resolvedNode) }
            : stepDraft.bindingHints;

          // Update step evidence with resolutionMeta and enriched bindingHints
          const updatedStep: IntentStep = {
            ...stepDraft,
            bindingHints: enrichedBindingHints,
            evidence: {
              ...stepDraft.evidence,
              lastSuccessRef: selectedRef,
              confidence: 1.0,
              resolutionMeta,
              // V15.6: Timestamp so the shortcut can reject stale refs.
              // data-agent-ref values are ephemeral DOM counters; after a long
              // gap (page reload, server restart + replay) the same ref can
              // point at a different element even on the same URL.
              capturedAt: new Date().toISOString(),
            },
            compiled, // NEW: compiled execution plan
          };

          // user_confirmed path: we just clicked the user-picked element
          // successfully, so the plan that targets that node is by-construction
          // valid at runtime even if its build-time count() raced navigation.
          // Mutate the plan to clear `unverified` BEFORE deriving WS-payload
          // planQuality and BEFORE the run-loop persists `step.compiled` to
          // DB — this is what makes the editor's "unstable" badge stop
          // showing on next session.
          clearUnverifiedOnRuntimeMatch(compiled);
          const planQuality = derivePlanQuality(compiled);
          if (planQuality?.unverified) {
            logger.warn('[PREVIEW_APPLY] Plan flagged unverified', {
              previewSessionId,
              stepId: stepDraft.id,
              reason: planQuality.reason,
              path: 'user_confirmed',
            });
            try {
              EditorTraceService.get(previewSessionId)?.writePlanQuality({
                stepId: stepDraft.id,
                unverified: true,
                reason: planQuality.reason,
                path: 'user_confirmed',
              });
            } catch { /* trace is advisory */ }
          }
          return {
            success: true,
            appliedStep: updatedStep,
            urlChanged: result.urlChanged,
            url: page.url(),
            highlight: [{
              ref: selectedRef,
              type: 'success',
            }],
            attempts: 1,
            planQuality,
          };
        }

        // If confirmed selection failed, return error (don't fallback to lint)
        return {
          success: false,
          error: result.error || 'Failed to apply user-confirmed element',
          highlight: [{
            ref: selectedRef,
            type: 'error',
          }],
          attempts: 1,
        };
      }

      // Track whether compiled plan was tried but failed (reported to caller for skip-compiled optimization)
      let compiledWasTried = false;

      // ═══════════════════════════════════════════════════════════════════════
      // V7: Try compiled locator plan first (if available) before lint
      // This is a fast path that avoids expensive AI/LLM resolution when we have
      // a cached, validated locator from a previous successful resolution
      // ═══════════════════════════════════════════════════════════════════════
      // Skip compiled shortcut if:
      // - Caller flagged skipCompiled (previous step's compiled failed = likely stale plans)
      // - Page URL changed since compiled was generated (plan targets wrong page)
      // V13: Strict URL check for compiled plans. If the compiled plan was
      // generated on a different page, the locator strategies are stale —
      // executing them can "succeed" on a wrong element (e.g. sidebar link
      // with the same label exists on every page). If the compiled plan
      // has no pageUrl recorded, treat it as stale to be safe.
      const compiledPageUrl = stepDraft.compiled?.context?.pageUrl;
      const currentPageUrl = page.url();
      const compiledUrlStale = !compiledPageUrl
        || (normalizeUrlForComparison(compiledPageUrl) !== normalizeUrlForComparison(currentPageUrl));

      // V23: snapshot compiled-path state regardless of branch taken below.
      setTraceCompiled({
        available: !!(stepDraft.compiled && stepDraft.compiled.locatorPlan && stepDraft.compiled.locatorPlan.length > 0),
        urlStale: compiledUrlStale,
        compiledPageUrl,
        currentPageUrl,
        locatorCount: stepDraft.compiled?.locatorPlan?.length,
        ...(params.skipCompiled || compiledUrlStale || stepDraft.options?.useScreenshotOnly === true ? { fellThroughTo: 'skipped' as const } : {}),
      });

      if (
        stepDraft.compiled && stepDraft.compiled.locatorPlan && stepDraft.compiled.locatorPlan.length > 0
        && !params.skipCompiled
        && !compiledUrlStale
        // Force vision-only: skip the compiled fast-path so apply falls through
        // to lintStepWithAI → resolveElement's screenshot-only gate.
        && stepDraft.options?.useScreenshotOnly !== true
      ) {
        logger.debug('[PREVIEW_APPLY] Trying compiled locator plan before lint', {
          previewSessionId,
          stepId: stepDraft.id,
          locatorCount: stepDraft.compiled.locatorPlan.length,
          pageUrl: compiledPageUrl,
        });

        try {
          // Import and execute compiled plan
          const { executeCompiledLocatorPlan } = await import('@/agent/execution/compiled-locator-executor');

          // V15: Route per-attempt events into the trace file — answers "which
          // strategy from the plan actually worked, and how long did losers take?"
          const editorTrace = EditorTraceService.get(previewSessionId);
          const compiledTracer = editorTrace ? {
            attempt: editorTrace.writeCompiledAttempt.bind(editorTrace),
            reorder: editorTrace.writeCompiledReorder.bind(editorTrace),
          } : undefined;

          const compiledResult = await executeCompiledLocatorPlan(
            page,
            stepDraft.compiled,
            stepDraft.type,
            3000, // 3s timeout — fast path, if compiled doesn't resolve quickly fall through to lint
            compiledTracer,
            stepDraft.id,
          );

          if (compiledResult.success && compiledResult.locator) {
            logger.info('[PREVIEW_APPLY] Compiled locator succeeded, skipping lint', {
              previewSessionId,
              stepId: stepDraft.id,
              strategy: compiledResult.usedStrategy,
            });
            // V23: compiled fast-path won — record it. fellThroughTo cleared
            // because we're staying in compiled.
            setTrace({ resolverPath: 'compiled' });
            setTraceCompiled({
              succeededStrategy: compiledResult.usedStrategy,
              succeededWithFingerprintMatch: compiledResult.confidence,
              fellThroughTo: null,
            });

            // ── Recorded-identity guard ──────────────────────────────────
            // `executeCompiledLocatorPlan` only validated the match against the
            // plan's OWN `targetFingerprint` — a self-echo of a PRIOR resolver
            // decision (invariant #15). It never re-checks the ORIGINAL recorded
            // identity, so a drifted text/label strategy can "succeed" on a
            // different element than a fresh single-step Apply (which always
            // resolves via the LLM, because the editor sends no compiled plan).
            // Re-probe the resolved element and reject when a recorded STRONG
            // identifier (id/testId/name/href/svgIcon/routerLink, URL-normalized)
            // contradicts it — throw to fall through to lint so Run and Apply
            // converge. SAME comparator as the evidence path and the readiness
            // gate (hasStrongIdentityContradiction). Only probes when the
            // fingerprint has strong identity; manual-add steps (no fingerprint)
            // and probe failures fail open.
            if (recordedFingerprintHasStrongIdentity(stepDraft.recordedFingerprint)) {
              const identityProbe = await probeIdentity(compiledResult.locator, RECORDED_IDENTITY_PROBE_CAP_MS).catch(() => null);
              if (hasStrongIdentityContradiction(identityProbe, stepDraft.recordedFingerprint)) {
                logger.info('[PREVIEW_APPLY] Compiled hit rejected — recorded-identity contradiction, falling through to lint', {
                  previewSessionId,
                  stepId: stepDraft.id,
                  strategy: compiledResult.usedStrategy,
                });
                setTraceCompiled({ fellThroughTo: 'recorded_identity_mismatch' });
                try {
                  EditorTraceService.get(previewSessionId)?.writeCompiledPostcondition({
                    stepId: stepDraft.id,
                    expectsNavigation: false,
                    urlChanged: false,
                    accepted: false,
                    reason: 'recorded_identity_mismatch',
                  });
                } catch { /* non-fatal */ }
                compiledWasTried = true;
                // Break out of the success path; the surrounding try/catch turns
                // this into a `compiledWasTried = true` fall-through to lint —
                // same idiom as the compiled-click-no-effect bail below.
                throw new Error('compiled-recorded-identity-mismatch');
              }
            }

            // Build candidate from compiled result
            // V15: Extract data-agent-ref from resolved element so evidence shortcut
            // works on next run (previously stored '' which made evidence cache miss every time)
            let compiledRef = '';
            try {
              compiledRef = await compiledResult.locator!.getAttribute('data-agent-ref') ?? '';
            } catch { /* element may not have ref attr — that's fine */ }

            const compiledCandidate: LintCandidate = {
              ref: compiledRef,
              reason: `Compiled locator: ${compiledResult.usedStrategy}`,
              confidence: compiledResult.confidence || 0.9,
              label: '',
            };

            // V13: Postconditions from compiled plan (hoisted for pre/post click checks)
            const postconditions = stepDraft.compiled?.postconditions || [];
            const expectedNav = postconditions.includes('navigation') || postconditions.includes('urlChange');

            // V13: Snapshot body child count BEFORE click — used by postcondition
            // DOM mutation check to detect modals/overlays opened by the click.
            if (expectedNav) {
              await page.evaluate(() => {
                (globalThis as unknown as { __qaitPreClickChildCount?: number }).__qaitPreClickChildCount =
                  (globalThis as unknown as { document: { body: { children: { length: number } } } }).document.body.children.length;
              }).catch(() => {});
            }

            // Editor click-effect verification: also snapshot pre-state for
            // non-navigating clicks so we can detect "click in void" cases
            // (target obstructed by overlay, no-op handler, etc.) on the
            // compiled fast-path. Mirrors the lint-path check.
            const compiledTargetFrame = (stepDraft.type === 'click' && !expectedNav)
              ? await resolveTargetFrame(page, stepDraft)
              : null;
            const compiledClickPreState = (stepDraft.type === 'click' && !expectedNav && compiledRef)
              ? await captureClickPreState(page, compiledRef, compiledTargetFrame)
              : null;

            // Execute action with compiled locator
            const result = await executeAction(page, stepDraft, compiledCandidate, compiledResult.locator, { expectsNavigation, secretValues: secretValuesForAudit });

            if (result.success) {
              // V13: Postcondition verification — if the compiled plan
              // predicted navigation but URL didn't change, the click
              // likely hit a wrong element (e.g. sidebar link instead of
              // main content CTA). Treat as compiled-miss and fall through
              // to lint for proper AI-based resolution.
              // If URL didn't change immediately, give SPA routers a moment.
              // pushState/replaceState often fires asynchronously after the
              // click handler returns — 300ms covers React Router, Next.js,
              // Vue Router, and most SPA frameworks.
              //
              // V23: Angular routers with route guards / resolvers / lazy
              // module loading can take >300ms before URL updates. Observed
              // on juz40-edu Angular curator: click resolved to navigation
              // but page.url() lagged ~150ms past our 300ms ceiling →
              // postcondition reported false-failure → fall through to lint
              // → URL guard fired (URL had since updated) → false positive
              // FAIL on a successful click. Bump to 1000ms with poll interval
              // so we exit early on fast routers but tolerate slow ones.
              let urlActuallyChanged = result.urlChanged;
              if (expectedNav && !urlActuallyChanged) {
                const SPA_NAV_WAIT_MS = 1000;
                const POLL_INTERVAL_MS = 100;
                const start = Date.now();
                while (Date.now() - start < SPA_NAV_WAIT_MS) {
                  await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => {});
                  const urlNow = page.url();
                  if (normalizeUrlForComparison(urlNow) !== normalizeUrlForComparison(currentPageUrl)) {
                    urlActuallyChanged = true;
                    break;
                  }
                }
              }
              if (expectedNav && !urlActuallyChanged) {
                // Before falling through, check if DOM visibly changed (modal/popup/
                // overlay appeared). A <a> tag that opens a modal instead of
                // navigating is valid — the postcondition heuristic (tag=a →
                // navigation) was wrong, not the click.
                //
                // We ask the browser directly: did body.children.length or any
                // dialog/modal appear since the click? This is synchronous with
                // the DOM and doesn't depend on the async snapshot pipeline.
                let domVisiblyChanged = false;
                try {
                  domVisiblyChanged = await page.evaluate(() => {
                    const g = globalThis as unknown as {
                      __qaitPreClickChildCount?: number;
                      document: { body: { children: { length: number } }; querySelectorAll: (s: string) => { length: number } };
                    };
                    const currentCount = g.document.body.children.length;
                    const preCount = g.__qaitPreClickChildCount;
                    // Clean up marker
                    delete g.__qaitPreClickChildCount;
                    // If we have a baseline and it changed, DOM mutated
                    if (preCount !== undefined && currentCount !== preCount) return true;
                    // Also check for new dialogs/modals/overlays
                    const modals = g.document.querySelectorAll(
                      '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]'
                    );
                    return modals.length > 0;
                  });
                } catch { /* page navigating — counts as change */ domVisiblyChanged = true; }

                if (domVisiblyChanged) {
                  logger.debug('[PREVIEW_APPLY] Compiled postcondition: URL unchanged but DOM mutated — accepting', {
                    previewSessionId, stepId: stepDraft.id,
                  });
                  try {
                    EditorTraceService.get(previewSessionId)?.writeCompiledPostcondition({
                      stepId: stepDraft.id,
                      expectsNavigation: true,
                      urlChanged: false,
                      domChanged: true,
                      accepted: true,
                      reason: 'dom_mutated',
                    });
                  } catch { /* non-fatal */ }
                  // Accept as success — fall through to the normal success path below
                } else {
                  logger.info('[PREVIEW_APPLY] Compiled plan postcondition failed — expected navigation but URL and DOM unchanged', {
                    previewSessionId,
                    stepId: stepDraft.id,
                    postconditions,
                    url: page.url(),
                  });
                  try {
                    EditorTraceService.get(previewSessionId)?.writeCompiledPostcondition({
                      stepId: stepDraft.id,
                      expectsNavigation: true,
                      urlChanged: false,
                      domChanged: false,
                      accepted: false,
                      reason: 'expected_navigation_no_change',
                    });
                  } catch { /* non-fatal */ }
                  // Fall through to lint instead of returning success
                  compiledWasTried = true;
                  setTraceCompiled({ fellThroughTo: 'postcondition' });
                }
              }

              // If compiledWasTried was set by postcondition failure above, skip success return
              if (!compiledWasTried) {
                // V16: Post-action settle via smartStepWait (see note above).
                if (!skipPostActionWait) {
                  await smartStepWait({
                    page,
                    step: stepDraft,
                    phase: 'post',
                  }).catch(() => { /* non-fatal */ });
                }

                // Editor click-effect verification on compiled fast-path.
                // Must run AFTER smartStepWait('post') so the DOM has had a
                // chance to settle (handlers fire, animations run, modals
                // mount). Earlier and we get false negatives on slow SPAs.
                //
                // Important: a compiled click that hits nothing is NOT a
                // compiled-plan failure (the locator did find the right
                // element by fingerprint). It's a runtime issue — page
                // state changed (overlay appeared, etc). So we keep
                // `compiledWasTried` false and `compiledFailed` false in
                // the result — that prevents Run loop from disabling
                // compiled-fast-path for remaining steps.
                let compiledClickEffected = true;
                if (
                  stepDraft.type === 'click'
                  && !expectedNav
                  && compiledClickPreState
                ) {
                  const effect = await verifyClickHadEffect(page, compiledClickPreState, compiledRef, compiledTargetFrame);
                  if (!effect.effected) {
                    // Compiled hit a stale target — page didn't react. Common
                    // root causes for manual-add steps (no `recordedFingerprint`):
                    //   • The plan was generated against an element the LLM picked
                    //     last run; that ref/text now resolves to a different
                    //     element (off-screen card, archived item, hidden duplicate).
                    //   • Page now has an overlay (modal backdrop) intercepting
                    //     pointer events on the target.
                    //
                    // Old behaviour: hard-return failure → next step skipped.
                    // New behaviour: mark `compiledWasTried` so we fall through
                    // to lint+LLM resolve below. The LLM resolver can re-pick
                    // a fresh candidate from the live DOM, which is exactly
                    // what manual steps with stale `compiled` need to recover.
                    logger.info('[PREVIEW_APPLY] Compiled click had no effect — falling back to lint', {
                      previewSessionId,
                      stepId: stepDraft.id,
                      signal: effect.signal,
                    });
                    try {
                      editorTrace?.writeActionVerify({
                        stepId: stepDraft.id,
                        stepType: stepDraft.type,
                        verificationMethod: 'click-effect',
                        verified: false,
                        durationMs: 0,
                        signal: effect.signal,
                      });
                      editorTrace?.writeCompiledPostcondition({
                        stepId: stepDraft.id,
                        expectsNavigation: false,
                        urlChanged: false,
                        clickEffectSignal: effect.signal,
                        accepted: false,
                        reason: 'click_no_effect',
                      });
                    } catch { /* non-fatal */ }
                    compiledWasTried = true;
                    compiledClickEffected = false;
                    setTraceCompiled({ fellThroughTo: 'click_no_effect' });
                    decisionTrace.clickEffectSignal = effect.signal as any;
                  } else {
                    decisionTrace.clickEffectSignal = effect.signal as any;
                    try {
                      editorTrace?.writeActionVerify({
                        stepId: stepDraft.id,
                        stepType: stepDraft.type,
                        verificationMethod: 'click-effect',
                        verified: true,
                        durationMs: 0,
                        signal: effect.signal,
                      });
                    } catch { /* non-fatal */ }
                  }
                }
                // If the click had no effect, skip the success-return path and
                // let execution fall through to lint+LLM further down.
                if (!compiledClickEffected) {
                  // throw to break out of the success path; the surrounding
                  // try/catch turns it into a `compiledWasTried = true`
                  // fallthrough to lint just like any other compiled error.
                  throw new Error('compiled-click-no-effect');
                }

                // Invalidate snapshot cache for DOM-mutating actions so next step's lint gets fresh nodes
                if (DOM_MUTATING_ACTIONS.has(stepDraft.type)) {
                  const sess = sessionService.getSession(previewSessionId);
                  if (sess) sess.lastSnapshotEmit = 0;
                }

                // Build resolution meta for compiled success
                const resolutionMeta: ResolutionMeta = {
                  allowedCount: 1,
                  usedRules: ['compiled_plan'],
                  usedLLM: false,
                  confidenceTier: 'high' as ConfidenceTier,
                };

                // V22 — Opportunistic plan upgrade on compiled-success path.
                //
                // Before: the compiled fast-path returned success and rebuilt
                // ONLY `evidence.*`, leaving `stepDraft.compiled` untouched.
                // That meant an old test case whose plan was compiled with
                // stale builder logic (e.g. pre-`computeImplicitRole`, where
                // native <button> ended up with `locatorPlan=[text]`) would
                // run forever on that weak plan — it succeeds, we never fall
                // into lint, lint was the only place buildCompiledPlan runs.
                //
                // Strategy here: after success, look up the live node by the
                // ref that actually worked and build a FRESH plan from it.
                // Only commit the rebuild if it is structurally stronger than
                // the old plan (more strategies, or richer first strategy).
                // Anything else keeps the old plan untouched — guarantees we
                // never regress a well-scored plan with a thinner live snapshot
                // (e.g. page reflowed and the accessible-name disappeared).
                //
                // All failures are soft — any throw, missing node, or weaker
                // rebuild falls through to the old plan, so this path can
                // NEVER turn a successful step into a failure.
                let upgradedCompiled = stepDraft.compiled;
                // CRITICAL: skip the rebuild if navigation happened during the action.
                // After a click that triggers navigation (e.g. OpenID Connect → SSO),
                // `page.url()` is the destination page, not the page the step was
                // recorded on. The session's domNodes also reflect the post-nav DOM.
                // Looking up `compiledRef` there returns either nothing or a stale
                // ref re-bound to a wholly unrelated post-nav element, and we'd
                // persist a corrupted plan whose `context.pageUrl` points at the
                // destination — every subsequent run would fail `compiledUrlStale`
                // and the URL guard in lint with `url_mismatch`. The upgrade is a
                // soft, never-load-bearing optimization — bail out when unsafe.
                const postActionUrl = page.url();
                const navigationOccurred = !!currentPageUrl
                  && normalizeUrlForComparison(currentPageUrl) !== normalizeUrlForComparison(postActionUrl);
                if (compiledRef && !navigationOccurred) {
                  try {
                    const sess = sessionService.getSession(previewSessionId);
                    const liveNode = sess?.pageState?.domNodes?.find(n => n.ref === compiledRef);
                    if (liveNode) {
                      const candidatePlan = await LocatorPlanBuilder.buildCompiledPlan({
                        step: stepDraft,
                        resolvedNode: liveNode,
                        pageUrl: postActionUrl,
                        pageTitle: await page.title().catch(() => undefined),
                        pageSignature: sess?.lastPageSignature,
                        page,
                      });
                      if (shouldUpgradeCompiledPlan(stepDraft.compiled, candidatePlan)) {
                        logger.info('[PREVIEW_APPLY] Upgraded compiled plan on fast-path success', {
                          previewSessionId,
                          stepId: stepDraft.id,
                          oldStrategies: stepDraft.compiled?.locatorPlan?.map(e => e.strategy) ?? [],
                          newStrategies: candidatePlan.locatorPlan.map(e => e.strategy),
                        });
                        upgradedCompiled = candidatePlan;
                      }
                    }
                  } catch (upgradeErr) {
                    // Plan upgrade must never break a successful step —
                    // fall through with the original plan untouched.
                    logger.debug('[PREVIEW_APPLY] Compiled plan upgrade skipped', {
                      previewSessionId,
                      stepId: stepDraft.id,
                      error: upgradeErr instanceof Error ? upgradeErr.message : String(upgradeErr),
                    });
                  }
                } else if (navigationOccurred) {
                  logger.debug('[PREVIEW_APPLY] Compiled plan upgrade skipped — navigation occurred mid-action', {
                    previewSessionId,
                    stepId: stepDraft.id,
                    fromUrl: currentPageUrl,
                    toUrl: postActionUrl,
                  });
                }

                // Update step with success evidence
                let updatedStep: IntentStep = {
                  ...stepDraft,
                  compiled: upgradedCompiled,
                  evidence: {
                    ...stepDraft.evidence,
                    lastSuccessRef: compiledRef || '', // V15: Preserve ref for evidence shortcut
                    confidence: compiledResult.confidence || 0.9,
                    resolutionMeta,
                    capturedAt: new Date().toISOString(), // V15.6: staleness guard
                  },
                };

                // Synthesize `recordedFingerprint` for manually-added click
                // steps on the compiled fast-path. Mirrors the lint-path
                // synthesis at the bottom of the resolver loop. Click only,
                // and only if the field is missing — never overwrites a
                // genuine recorder-provided fingerprint. Uses the live DOM
                // node looked up by `compiledRef` so the identity reflects
                // what the click actually hit, not what was in the plan.
                if (
                  stepDraft.type === 'click'
                  && !stepDraft.recordedFingerprint
                  && compiledRef
                ) {
                  try {
                    const sess = sessionService.getSession(previewSessionId);
                    const liveNode = sess?.pageState?.domNodes?.find(n => n.ref === compiledRef);
                    if (liveNode) {
                      const synthetic = buildSyntheticFingerprintFromNode(liveNode);
                      if (Object.keys(synthetic).length > 0) {
                        updatedStep = { ...updatedStep, recordedFingerprint: synthetic };
                        logger.info('[PREVIEW_APPLY] Synthesized recordedFingerprint on compiled fast-path', {
                          previewSessionId,
                          stepId: stepDraft.id,
                          fpKeys: Object.keys(synthetic).slice(0, 10),
                        });
                      }
                    }
                  } catch { /* synthesis is non-fatal */ }
                } else if (
                  // V26: Mirror the lint-path backfill on the compiled
                  // fast-path. Recorded fingerprints captured by older
                  // recorder versions don't have the new V26 identity
                  // fields (firstTextFragment, href, etc.) — without
                  // backfill they only get populated by re-recording
                  // by hand. Same gate (click + has recordedFp + has
                  // compiledRef), same predicate (only fill missing
                  // slots, never overwrite recorded values).
                  stepDraft.type === 'click'
                  && stepDraft.recordedFingerprint
                  && compiledRef
                ) {
                  try {
                    const sess = sessionService.getSession(previewSessionId);
                    const liveNode = sess?.pageState?.domNodes?.find(n => n.ref === compiledRef);
                    if (liveNode) {
                      const fp = stepDraft.recordedFingerprint;
                      const live = liveNode as any;
                      const backfill: Partial<TargetFingerprint> = {};
                      const fillIfMissing = <K extends keyof TargetFingerprint>(
                        key: K,
                        liveKey: string = key as string,
                      ): void => {
                        const v = live[liveKey];
                        if (fp[key] === undefined && v !== undefined && v !== null && v !== '') {
                          (backfill as any)[key] = v;
                        }
                      };
                      fillIfMissing('firstTextFragment');
                      fillIfMissing('href');
                      if (fp.elementId === undefined && live.id && !live.isDynamicId) {
                        backfill.elementId = live.id;
                      }
                      fillIfMissing('testIdAttr');
                      fillIfMissing('name');
                      fillIfMissing('alt');
                      fillIfMissing('svgIcon');
                      fillIfMissing('iconLabel');
                      fillIfMissing('customElementTag');
                      fillIfMissing('cssClass');
                      fillIfMissing('ariaControls');
                      fillIfMissing('vueScopeId');
                      fillIfMissing('childTestId');
                      fillIfMissing('nearestLandmark');
                      fillIfMissing('title');
                      if (
                        (!fp.containerTitles || fp.containerTitles.length === 0)
                        && Array.isArray(live.containerTitles)
                        && live.containerTitles.length > 0
                      ) {
                        backfill.containerTitles = live.containerTitles.slice(0, 3);
                      }
                      if (Object.keys(backfill).length > 0) {
                        updatedStep = {
                          ...updatedStep,
                          recordedFingerprint: { ...fp, ...backfill },
                        };
                        logger.info('[PREVIEW_APPLY] Backfilled missing identity fields on compiled fast-path', {
                          previewSessionId,
                          stepId: stepDraft.id,
                          backfilledKeys: Object.keys(backfill),
                        });
                      }
                    }
                  } catch { /* backfill is non-fatal */ }
                }

                // V23: compiled fast-path success — pull live node info into
                // chosen for trace. Always populate ref (even when DOM lookup
                // fails) so the field is never silently empty — analysis
                // tooling assumes `decisionTrace.chosen.ref` is set on any
                // success path.
                try {
                  const sess2 = sessionService.getSession(previewSessionId);
                  const liveNode2 = sess2?.pageState?.domNodes?.find((n) => n.ref === compiledRef);
                  decisionTrace.chosen = liveNode2
                    ? {
                        ref: compiledRef,
                        tag: liveNode2.tag,
                        role: liveNode2.role,
                        label: getEffectiveLabel(liveNode2),
                        text: liveNode2.text ? liveNode2.text.slice(0, 60) : undefined,
                        id: liveNode2.id ?? undefined,
                        testIdAttr: liveNode2.testIdAttr,
                        bbox: liveNode2.boundingBox,
                      }
                    : { ref: compiledRef };
                } catch {
                  decisionTrace.chosen = { ref: compiledRef };
                }
                setTraceTiming({ totalMs: Date.now() - traceTimingStart });
                // compiled fast-path upgrade: we got here ONLY because the
                // compiled plan just successfully matched, clicked, and
                // (for non-nav clicks) passed verifyClickHadEffect. That's
                // direct runtime proof of plan stability — beats build-time
                // count() which races click→navigation on click steps.
                // Clear `unverified` on the plan that will be persisted (also
                // covers the `compiled === upgradedCompiled` case where the
                // upgrade was skipped due to navigation).
                clearUnverifiedOnRuntimeMatch(upgradedCompiled);
                const planQuality = derivePlanQuality(upgradedCompiled);
                if (planQuality?.unverified) {
                  logger.warn('[PREVIEW_APPLY] Plan flagged unverified', {
                    previewSessionId,
                    stepId: stepDraft.id,
                    reason: planQuality.reason,
                    path: 'compiled_fast_path_upgrade',
                  });
                  try {
                    EditorTraceService.get(previewSessionId)?.writePlanQuality({
                      stepId: stepDraft.id,
                      unverified: true,
                      reason: planQuality.reason,
                      path: 'compiled_fast_path_upgrade',
                    });
                  } catch { /* trace is advisory */ }
                }
                return {
                  success: true,
                  appliedStep: updatedStep,
                  urlChanged: result.urlChanged,
                  url: page.url(),
                  attempts: 1,
                  decisionTrace,
                  planQuality,
                };
              }
            }
          }

          // Compiled failed or element not found - fallthrough to lint
          compiledWasTried = true;
          if (!decisionTrace.compiled?.fellThroughTo) {
            setTraceCompiled({ fellThroughTo: 'click_failed' });
          }
          logger.debug('[PREVIEW_APPLY] Compiled locator failed, falling back to lint', {
            previewSessionId,
            stepId: stepDraft.id,
            reason: compiledResult.skipReason,
          });
        } catch (compiledError) {
          // Compiled execution threw - fallthrough to lint
          compiledWasTried = true;
          if (!decisionTrace.compiled?.fellThroughTo) {
            setTraceCompiled({ fellThroughTo: 'lint' });
          }
          logger.debug('[PREVIEW_APPLY] Compiled execution error, falling back to lint', {
            previewSessionId,
            stepId: stepDraft.id,
            error: compiledError instanceof Error ? compiledError.message : String(compiledError),
          });
        }
      }

      // Normal flow: Lint the step to get candidates.
      // forceFreshSnapshot: apply is triggered by user clicking Run — the DOM may
      // have changed since the last snapshot tick (e.g. a dropdown opened during
      // typing, or a compiled shortcut just ran and mutated the page).
      const lintPhaseStart = Date.now();
      try {
        const traceForLint = EditorTraceService.get(previewSessionId);
        traceForLint?.writeApplyPhaseEntry({ stepId: stepDraft.id, phase: 'lint_resolve' });
      } catch { /* non-fatal */ }
      const lintResult = await IntentStepLintService.lintStepWithAI({
        previewSessionId,
        stepDraft,
        pageRef: params.pageRef,
        userId,
        forceFreshSnapshot: true,
        auditTrigger: 'apply_prelint',
      });
      // HIDDEN-CANDIDATE RETARGET (codemify #submenu, June 2026 — proven root).
      // The CDP snapshot does NOT compute real visibility, so the resolver can
      // hand back a HIDDEN copy of the target (e.g. a nav item duplicated into a
      // collapsed dropdown submenu) whose recorded identity ALSO matches a
      // VISIBLE element elsewhere on the page. The collector marks both
      // "visible", so an in-snapshot filter can't tell them apart — only the
      // live browser can. So we ask PLAYWRIGHT (the source of truth): if the
      // chosen candidate is hidden, find a VISIBLE element sharing the SAME
      // recorded identity and retarget to it. This stops the ~70-80s stall
      // (click waiting out its full "element is not visible" timeout ×retries).
      //
      // Universal across sites: we try identity signals in strength order —
      // testId → id → href → name → exact visible text — so it works for
      // links (href), framework menus (data-testid), id-anchored items, form
      // controls (name), and plain text buttons/divs alike, not just <a href>.
      // Click-class only; fully fail-open (any miss → keep original candidate).
      try {
        const isClickClass = stepDraft.type === 'click' || stepDraft.type === 'hover' || stepDraft.type === 'select';
        const chosen0 = lintResult.status === 'resolved' ? lintResult.candidates?.[0] : undefined;
        const fp = stepDraft.recordedFingerprint;
        if (isClickClass && chosen0?.ref && fp) {
          const chosenLoc = page.locator(`[data-agent-ref="${chosen0.ref}"]`).first();
          const chosenVisible = await chosenLoc.isVisible({ timeout: 1000 }).catch(() => true);
          if (!chosenVisible) {
            const cssEsc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            // Build :visible candidate locators in identity-strength order.
            // Each entry: a Playwright Locator already scoped to :visible.
            const tries: Array<{ by: string; loc: import('playwright').Locator }> = [];
            if (fp.testIdAttr) {
              const v = cssEsc(fp.testIdAttr);
              tries.push({ by: 'testid', loc: page.locator(`[data-testid="${v}"]:visible, [data-test="${v}"]:visible, [data-qa="${v}"]:visible`).first() });
            }
            if (fp.elementId) {
              // Attribute form (not `#id`) so React useId() colons / special
              // chars don't need CSS.escape (unavailable in Node).
              tries.push({ by: 'id', loc: page.locator(`[id="${cssEsc(fp.elementId)}"]:visible`).first() });
            }
            if (fp.href) {
              tries.push({ by: 'href', loc: page.locator(`a[href="${cssEsc(fp.href)}"]:visible`).first() });
            }
            if (fp.name) {
              tries.push({ by: 'name', loc: page.locator(`[name="${cssEsc(fp.name)}"]:visible`).first() });
            }
            // Exact visible text — last resort, len>=2 (short strings
            // substring-collide). Prefer firstTextFragment (a real single
            // text-node match) over the joined `text` which getByText can't
            // match. `.filter({ visible: true })` keeps only the visible node.
            const recText = (fp.firstTextFragment || fp.text || '').trim();
            if (recText.length >= 2) {
              tries.push({ by: 'text', loc: page.getByText(recText, { exact: true }).filter({ visible: true }).first() });
            }

            for (const t of tries) {
              const ok = await t.loc.isVisible({ timeout: 800 }).catch(() => false);
              if (!ok) continue;
              const altRef = await t.loc.getAttribute('data-agent-ref').catch(() => null);
              logger.info('[PREVIEW_APPLY] Retargeted hidden candidate → visible same-identity element', {
                previewSessionId, stepId: stepDraft.id,
                hiddenRef: chosen0.ref, matchedBy: t.by, visibleRef: altRef,
              });
              if (altRef) {
                lintResult.candidates = [{ ...chosen0, ref: altRef }];
                lintResult.highlight = [{ ref: altRef, type: 'success' }];
              }
              break; // first visible same-identity match wins
            }
          }
        }
      } catch { /* retarget is best-effort — never blocks apply */ }

      // V23: lint phase finished — record path + LLM diagnostics. resolverPath
      // here may be 'identity_*' / 'evidence_shortcut' / 'compiled' (rare from
      // lint) / 'llm' / 'vision' / 'rule_fallback'.
      setTrace({ resolverPath: lintResult.resolverPath });
      // V23: surface lint phase timings (snapshot/resolve/total) through trace
      // so analysis can answer "where did the 19s go?". Without this, llm.latencyMs
      // looks like LLM was slow when really snapshot collect on a 50K DOM was slow.
      if (lintResult.phaseTimings) {
        setTraceTiming({
          // mirror lint phases into the existing timing block (lintMs already exists)
          // and add granular sub-phases via direct assignment.
        });
        (decisionTrace.timing as any) = {
          ...(decisionTrace.timing || {}),
          lintSnapshotMs: lintResult.phaseTimings.snapshotMs,
          lintResolveMs: lintResult.phaseTimings.resolveMs,
          lintTotalMs: lintResult.phaseTimings.totalMs,
          lintDomNodeCount: lintResult.phaseTimings.domNodeCount,
        };
      }
      decisionTrace.llm = {
        cacheHit: !!lintResult.cacheHit,
        latencyMs: Date.now() - lintPhaseStart,
        candidatesCount: lintResult.candidates?.length,
        selectedRef: lintResult.candidates?.[0]?.ref,
        confidence: lintResult.confidence,
        degraded: !!lintResult.degradedMode,
        degradedReason: lintResult.degradedReason,
      };
      // Identity fast-path may have fired inside the resolver — surface that
      // separately so a future "identity_id but wrong element" pattern is
      // visible at a glance.
      if (lintResult.resolverPath === 'identity_id' || lintResult.resolverPath === 'identity_testid' || lintResult.resolverPath === 'identity_name') {
        const fp = stepDraft.recordedFingerprint;
        decisionTrace.identity = {
          recordedId: fp?.elementId,
          recordedTestId: fp?.testIdAttr,
          recordedName: fp?.name,
          matched: true,
          matchType: lintResult.resolverPath === 'identity_id' ? 'id'
            : lintResult.resolverPath === 'identity_testid' ? 'testid'
            : 'name',
        };
      }
      if (lintResult.resolverPath === 'evidence_shortcut') {
        decisionTrace.evidence = {
          cachedRef: stepDraft.evidence?.lastSuccessRef,
          cachedAtIso: stepDraft.evidence?.capturedAt,
          foundInLiveDom: true,
          bypassReason: 'ok',
        };
      }
      setTraceTiming({ lintMs: Date.now() - lintPhaseStart });
      try {
        const traceForLint = EditorTraceService.get(previewSessionId);
        traceForLint?.writeApplyPhaseExit({
          stepId: stepDraft.id,
          phase: 'lint_resolve',
          durationMs: Date.now() - lintPhaseStart,
          success: lintResult.status === 'resolved',
          ...(lintResult.status !== 'resolved' ? { skipReason: lintResult.status } : {}),
        });
        // Top-3 candidates so we can spot "weak step" cases — e.g. only 1
        // candidate at confidence 0.3 means the description doesn't match
        // anything well even though Playwright might still click it.
        if (Array.isArray(lintResult.candidates) && lintResult.candidates.length > 0) {
          const top = lintResult.candidates
            .slice(0, 3)
            .filter((c) => typeof c.ref === 'string')
            .map((c) => ({
              ref: c.ref as string,
              score: c.confidence,
              role: (c as unknown as { node?: { role?: string } }).node?.role,
              text: c.label,
            }));
          traceForLint?.writeResolverCandidates({
            stepId: stepDraft.id,
            source: 'lint',
            totalCount: lintResult.candidates.length,
            chosenRef: lintResult.candidates[0]?.ref,
            chosenScore: lintResult.candidates[0]?.confidence,
            top3: top,
          });
        }
      } catch { /* non-fatal */ }

      if (lintResult.status === 'needs_clarification') {
        setTraceTiming({ totalMs: Date.now() - traceTimingStart });
        return {
          success: false,
          error: lintResult.message || 'Please clarify which element to use',
          highlight: lintResult.highlight,
          attempts: 0,
          decisionTrace,
        };
      }

      if (lintResult.status === 'error') {
        setTraceTiming({ totalMs: Date.now() - traceTimingStart });
        return {
          success: false,
          error: lintResult.message || 'Linting failed',
          highlight: [],
          attempts: 0,
          decisionTrace,
        };
      }

      if (lintResult.status === 'not_found' || lintResult.candidates.length === 0) {
        // ═══════════════════════════════════════════════════════════════════
        // V11: Modal-aware "not found" — if a modal is open, the target may
        // be behind it. Inform the user so they can dismiss the modal first.
        // V13: Only surface the modal warning if the modal has an iron-clad
        // ARIA signature (role=dialog/alertdialog, aria-modal, native <dialog>)
        // — positional-heuristic modals (floating chats, onboarding cards)
        // are too unreliable to report as "blocking" in the not-found path.
        // ═══════════════════════════════════════════════════════════════════
        const modalInfo = detectModalBlockingFromSession(previewSessionId, userId);
        const sessionForNotFound = sessionService.getSession(previewSessionId);
        const modalNodeForNotFound = modalInfo
          ? sessionForNotFound?.pageState?.domNodes?.find(n => n.ref === modalInfo.modalRef)
          : undefined;
        const isIronCladModal = !!modalNodeForNotFound && (
          modalNodeForNotFound.role === 'dialog' ||
          modalNodeForNotFound.role === 'alertdialog' ||
          modalNodeForNotFound.tag === 'dialog'
        );
        if (modalInfo && isIronCladModal) {
          logger.info('[PREVIEW_APPLY] Element not found — modal/popup may be blocking', {
            previewSessionId,
            modalRef: modalInfo.modalRef,
            modalText: modalInfo.modalText?.slice(0, 80),
          });
          decisionTrace.overlayBlock = {
            blocked: true,
            overlayRef: modalInfo.modalRef,
            overlayText: modalInfo.modalText ? modalInfo.modalText.slice(0, 100) : undefined,
          };
          setTraceTiming({ totalMs: Date.now() - traceTimingStart });
          return {
            success: false,
            error: 'A popup/modal is currently open and may be blocking the target element. Dismiss it or interact with it first.',
            highlight: modalInfo.boundingBox ? [{
              boundingBox: modalInfo.boundingBox,
              type: 'warning' as const,
            }] : [],
            modalBlocking: modalInfo,
            decisionTrace,
          };
        }

        setTraceTiming({ totalMs: Date.now() - traceTimingStart });
        return {
          success: false,
          error: lintResult.message || 'No matching elements found',
          highlight: [],
          decisionTrace,
        };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V11: Layer-aware execution — check if modal blocks the target element.
      // Like a real user: if a popup is open, you interact with its elements.
      // If your target is behind the popup, you must dismiss it first.
      // ═══════════════════════════════════════════════════════════════════════
      const resolvedCandidates = lintResult.candidates.slice(0, MAX_ATTEMPTS);
      const anyInsideModal = resolvedCandidates.some(c => c.node?.isInsideActiveModal === true);
      const modalDetected = detectModalBlockingFromSession(previewSessionId, userId);

      if (modalDetected && !anyInsideModal) {
        // V13: The session's modal flag is a heuristic signal — verify with
        // the browser before blocking. Geometric + hit-test ground truth
        // eliminates false positives from onboarding tooltips, floating
        // chats, toasts, cookie banners, sticky headers, etc.
        const candidateRefs = resolvedCandidates.map(c => c.ref).filter((r): r is string => !!r);
        const verdict = await verifyModalActuallyBlocks(page, candidateRefs, modalDetected.modalRef);

        if (verdict.blocked) {
          logger.info('[PREVIEW_APPLY] Modal blocking target — verified by hit-test', {
            previewSessionId,
            modalRef: modalDetected.modalRef,
            reason: verdict.reason,
            occludingText: verdict.occludingText,
            candidateRefs: candidateRefs.join(', '),
          });
          const modalLabel = modalDetected.modalText?.trim() || verdict.occludingText;
          const modalError = modalLabel
            ? `A popup "${modalLabel.slice(0, 80)}" is covering the target. Dismiss it in the preview or interact with elements inside it first.`
            : 'A popup/modal is blocking the target element. Dismiss it or interact with elements inside the popup first.';
          decisionTrace.overlayBlock = {
            blocked: true,
            overlayRef: modalDetected.modalRef,
            overlayText: (modalLabel || '').slice(0, 100) || undefined,
          };
          setTraceTiming({ totalMs: Date.now() - traceTimingStart });
          return {
            success: false,
            error: modalError,
            highlight: [
              ...(modalDetected.boundingBox ? [{
                boundingBox: modalDetected.boundingBox,
                type: 'warning' as const,
              }] : []),
              ...resolvedCandidates.map(c => ({
                ref: c.ref,
                boundingBox: c.boundingBox,
                type: 'error' as const,
              })),
            ],
            modalBlocking: modalDetected,
            attempts: 0,
            decisionTrace,
          };
        }

        // Verified NOT blocked — log and fall through to normal execution.
        logger.debug('[PREVIEW_APPLY] Modal flag cleared by hit-test verification', {
          previewSessionId,
          modalRef: modalDetected.modalRef,
          reason: verdict.reason,
        });
      }
      // If target IS inside the modal (anyInsideModal=true) or no modal detected
      // or modal-blocking was disproven by hit-test, proceed normally.

      // ═══════════════════════════════════════════════════════════════════════
      // V16: Promo-banner / floating-overlay detection.
      // The modal path above only fires when the snapshot collector flags
      // something as `isInsideActiveModal` — that misses fixed-position promo
      // banners, cookie strips, sticky CTAs, etc. which our collector treats
      // as regular chrome. When the top candidate is NOT topmost-at-center,
      // something fixed is painting over it; run a hit-test to confirm and
      // fail fast with a banner-aware error so the user doesn't wait 40s for
      // Playwright to give up on a covered button.
      // ═══════════════════════════════════════════════════════════════════════
      const topCandidate = resolvedCandidates[0];
      const topCandidateNode = topCandidate?.ref
        ? sessionService.getSession(previewSessionId)?.pageState?.domNodes?.find(n => n.ref === topCandidate.ref)
        : undefined;
      const topCandidateCovered = topCandidateNode?.isVisible === true &&
        topCandidateNode?.isTopMostAtCenter === false;

      // Run overlay detection whenever the top candidate is visibly covered,
      // independent of whether a modal was previously detected. The detector
      // explicitly skips the candidate's own ancestors, so an in-modal button
      // being covered by a *different* floating banner will still be caught.
      if (topCandidateCovered) {
        const overlayCandidateRefs = resolvedCandidates.map(c => c.ref).filter((r): r is string => !!r);
        const overlay = await detectOverlayBlockingCandidate(page, previewSessionId, overlayCandidateRefs);
        if (overlay) {
          const bannerLabel = overlay.modalText || overlay.occludingText;
          const targetLabel = topCandidate?.node?.text || topCandidate?.node?.ariaLabel || topCandidate?.node?.labelText;
          const errorParts = [
            targetLabel ? `Can't reach "${targetLabel}" —` : `Target element is covered —`,
            bannerLabel ? `overlay "${bannerLabel}" is painting on top of it.` : `a floating overlay is painting on top of it.`,
            `Close the overlay in the preview, then re-run this step.`,
          ];
          logger.info('[PREVIEW_APPLY] Overlay blocking target — verified by hit-test', {
            previewSessionId,
            overlayRef: overlay.modalRef,
            overlayText: bannerLabel?.slice(0, 80),
            candidateRef: topCandidate?.ref,
          });
          // V23: capture overlay block for trace. This is the same path that
          // produced "Can't reach МАТ-SMART — overlay X is painting on top"
          // in the user's juz40 logs — surfacing it lets analysis see WHICH
          // overlay blocked WHICH candidate without grepping server stdout.
          decisionTrace.overlayBlock = {
            blocked: true,
            overlayRef: overlay.modalRef,
            overlayText: bannerLabel ? bannerLabel.slice(0, 100) : undefined,
          };
          if (topCandidate) {
            decisionTrace.chosen = {
              ref: topCandidate.ref,
              tag: topCandidate.node?.tag,
              role: topCandidate.node?.role,
              label: getEffectiveLabel(topCandidate.node),
              text: topCandidate.node?.text ? topCandidate.node.text.slice(0, 60) : undefined,
              id: topCandidate.node?.id ?? undefined,
              testIdAttr: topCandidate.node?.testIdAttr,
              bbox: topCandidate.boundingBox,
            };
          }
          setTraceTiming({ totalMs: Date.now() - traceTimingStart });
          return {
            success: false,
            error: errorParts.join(' '),
            highlight: [
              ...(overlay.boundingBox ? [{
                boundingBox: overlay.boundingBox,
                type: 'warning' as const,
              }] : []),
              ...resolvedCandidates.map(c => ({
                ref: c.ref,
                boundingBox: c.boundingBox,
                type: 'error' as const,
              })),
            ],
            modalBlocking: {
              modalRef: overlay.modalRef,
              modalText: overlay.modalText,
              boundingBox: overlay.boundingBox,
            },
            attempts: 0,
            decisionTrace,
          };
        }
      }

      // Try candidates in order (reuse resolvedCandidates from modal check above)
      let lastError: string | undefined;
      let attempts = 0;

      // V5: Capture URL BEFORE trying candidates for accurate compiled context
      // This URL represents the page state when elements were found by lint
      const urlBeforeAction = page.url();

      // V15: Trace helper — lazy lookup of the trace writer so we don't pay the
      // cost when no editor session is active. Every call is wrapped so a broken
      // tracer (disk full, buffer overflow, JSON serialization error) can never
      // kill a step. Matches the safety pattern in step-readiness.service.ts and
      // compiled-locator-executor.ts — tracing is advisory, never load-bearing.
      const rawTrace = EditorTraceService.get(previewSessionId);
      const trace = rawTrace ? {
        writeActionAttempt: (d: Parameters<typeof rawTrace.writeActionAttempt>[0]) => {
          try { rawTrace.writeActionAttempt(d); } catch { /* non-fatal */ }
        },
        writeActionResult: (d: Parameters<typeof rawTrace.writeActionResult>[0]) => {
          try { rawTrace.writeActionResult(d); } catch { /* non-fatal */ }
        },
        writeActionVerify: (d: Parameters<typeof rawTrace.writeActionVerify>[0]) => {
          try { rawTrace.writeActionVerify(d); } catch { /* non-fatal */ }
        },
        // V15.1: fine-grained action timing — surfaces the visible-wait portion
        // of Playwright's internal actionability sequence so we can see if a
        // 15s click was spent on "waiting for element visible" vs "waiting for
        // navigation" vs "waiting for click handler to fire".
        writeActionTiming: (d: Parameters<typeof rawTrace.writeActionTiming>[0]) => {
          try { rawTrace.writeActionTiming(d); } catch { /* non-fatal */ }
        },
      } : undefined;

      for (const candidate of resolvedCandidates) {
        attempts++;
        logger.debug('[PREVIEW_APPLY] Trying candidate', {
          attempt: attempts,
          ref: candidate.ref,
          confidence: candidate.confidence,
        });

        // V15: emit action_attempt so the trace shows exactly which locator source
        // drove this click/type/etc. Pre-action timestamp captures Playwright's
        // total actionability wait (visible + enabled + stable + receives events).
        trace?.writeActionAttempt({
          stepId: stepDraft.id,
          stepType: stepDraft.type,
          locatorSource: (candidate as any).source === 'compiled' ? 'compiled'
            : (candidate as any).source === 'evidence' ? 'evidence'
            : 'resolver',
          selector: candidate.ref ? `[data-agent-ref="${candidate.ref}"]` : undefined,
          ref: candidate.ref,
          attempt: attempts,
        });
        const actionStart = Date.now();

        // V15.1: Non-blocking "was it already visible?" probe. This REPLACES an
        // earlier attempt that used `waitFor({state:'visible', timeout:3000})`
        // which added up to 3s per candidate when the ref was stale.
        //
        // Instead we use `isVisible()` with a 200ms hard cap — it returns instantly
        // for already-visible elements, and for non-matching refs it bails out
        // within 200ms instead of waiting 3s. Cost: ~0ms (success) or ~200ms
        // (stale ref) per candidate, vs 0ms / 3000ms before. That's 15× faster
        // on failing paths.
        //
        // The trade-off: we no longer wait for elements to become visible before
        // firing the action. That's fine because `executeAction` internally runs
        // Playwright's actionability sequence which does its own wait. Our probe
        // is ONLY for diagnostics: we record whether the element was already
        // actionable so we can tell, post-hoc, whether a slow action was spent
        // waiting for rendering (pre-wait) vs stability (post-wait).
        let preWaitVisibleMs: number | undefined;
        let wasAlreadyVisible: boolean | undefined;
        try {
          if (candidate.ref) {
            const probeStart = Date.now();
            const selector = `[data-agent-ref="${candidate.ref}"]`;
            // Promise.race with a 200ms timer — mirror the withHardCap pattern
            // from step-readiness.service.ts. Don't import withHardCap here to
            // keep this file's imports minimal.
            const visiblePromise = page.locator(selector).first().isVisible();
            wasAlreadyVisible = await Promise.race([
              visiblePromise,
              new Promise<boolean>(resolve => setTimeout(() => resolve(false), 200)),
            ]);
            preWaitVisibleMs = Date.now() - probeStart;
          }
        } catch { /* non-fatal diagnostic */ }

        // Editor click-effect verification: snapshot page state pre-click so we
        // can detect whether the click actually changed anything afterwards.
        // Skip when expectsNavigation — the upstream waitForNavigation race
        // already proves an effect, and snapshotting during a pending nav
        // races with the document going away.
        const clickTargetFrame = (stepDraft.type === 'click' && !expectsNavigation)
          ? await resolveTargetFrame(page, stepDraft)
          : null;
        const clickPreState = (stepDraft.type === 'click' && !expectsNavigation && candidate.ref)
          ? await captureClickPreState(page, candidate.ref, clickTargetFrame)
          : null;

        // V24 — Pre-click text-overlap guard.
        //
        // Catches obvious wrong-element picks BEFORE the click fires, so the
        // wrong click's side-effect (opening a profile menu, modal, drawer)
        // never happens. Without this, a wrong click on the avatar "Б" opens
        // the cdk-overlay-pane, which then blocks the retry's correct click.
        //
        // Conditions (all required to abort):
        //   1. Click action.
        //   2. Step has a `recordedFingerprint` — i.e. it was captured via the
        //      recorder, not added manually. Manual-add steps are intentionally
        //      skipped: the user already saw the lint preview (highlighted
        //      element in editor) and explicitly chose to Run. Blocking them
        //      here would override their judgement and produce false-positives
        //      on multilingual / synonym descriptions ("save" vs "Сохранить").
        //   3. Resolver did NOT come from identity fast-path (id/testId/name
        //      match is deterministic — text might not encode the recorded
        //      label, e.g. id="login-btn" with text="Click here").
        //   4. We have a meaningful recorded label (≥1 token after 3-char filter).
        //   5. Chosen candidate has a label/text we can read.
        //   6. Zero token overlap between recorded and chosen (after Cyrillic
        //      fold + substring tolerance).
        //
        // We INTENTIONALLY don't gate on confidence — LLM frequently returns
        // 0.95 on completely wrong picks (saw "Б" with 0.95 for "MAT-SMART"
        // on juz40). Token-overlap is a more honest signal.
        let preClickAborted = false;
        if (
          stepDraft.type === 'click'
          && !!stepDraft.recordedFingerprint  // recorded steps only — see condition 2
          && lintResult.resolverPath !== 'identity_id'
          && lintResult.resolverPath !== 'identity_testid'
          && lintResult.resolverPath !== 'identity_name'
        ) {
          const recordedLabelForGuard =
            stepDraft.bindingHints?.label
            || stepDraft.bindingHints?.text
            || stepDraft.bindingHints?.nearText
            || stepDraft.recordedFingerprint?.text
            || stepDraft.recordedFingerprint?.labelText
            || stepDraft.recordedFingerprint?.ariaLabel
            || stepDraft.description
            || '';
          const chosenLabelForGuard =
            (candidate.node ? getEffectiveLabel(candidate.node) : '')
            || (candidate as any).label
            || (candidate.node?.text ?? '')
            || '';
          const recTokens = tokenizeLabel(recordedLabelForGuard);
          const choTokens = tokenizeLabel(chosenLabelForGuard);
          // V24 — multilang escape: if labels disagree but the chosen
          // element sits in the same geometric position as recorded, treat
          // as i18n / dynamic copy rather than wrong element. Same logic +
          // thresholds as the post-click guard below.
          // V24 — bbox-missing fail-open. If either side has no bbox (rare:
          // degraded LLM mode, recorder corruption), default to "assume same
          // place" so the multilang/i18n escape kicks in. Better to allow a
          // potentially-wrong click than to block a potentially-correct one
          // that we can't verify spatially.
          let preClickBboxImpliesSame = false;
          if (
            stepDraft.recordedFingerprint?.boundingBox
            && candidate.boundingBox
          ) {
            const rb = stepDraft.recordedFingerprint.boundingBox;
            const cb = candidate.boundingBox;
            const dx = (rb.x + rb.width / 2) - (cb.x + cb.width / 2);
            const dy = (rb.y + rb.height / 2) - (cb.y + cb.height / 2);
            const centerDist = Math.hypot(dx, dy);
            const recArea = Math.max(1, rb.width * rb.height);
            const choArea = Math.max(1, cb.width * cb.height);
            const sizeRatio = Math.min(recArea, choArea) / Math.max(recArea, choArea);
            preClickBboxImpliesSame = centerDist <= 50 && sizeRatio >= 0.5;
          } else {
            // bbox info missing — fail-open: don't escalate purely on labels
            // when we can't verify position. Multilang false-positive is
            // worse than letting through a wrong click (post-click guard
            // catches that one anyway, with the click signal as evidence).
            preClickBboxImpliesSame = true;
          }
          // Only guard when BOTH sides have meaningful tokens — if recorded
          // has no usable label (recording drift / icon-only) we can't fairly
          // judge. Same for chosen (icon-only nodes).
          // Skip the guard if bbox suggests same element (multilang/i18n case).
          if (
            recTokens.size >= 1
            && choTokens.size >= 1
            && !hasAnyOverlap(recTokens, choTokens)
            && !preClickBboxImpliesSame
          ) {
            logger.warn('[PREVIEW_APPLY] Pre-click guard: zero text overlap, aborting before click', {
              stepId: stepDraft.id,
              candidateRef: candidate.ref,
              recordedLabel: recordedLabelForGuard.slice(0, 80),
              chosenLabel: chosenLabelForGuard.slice(0, 80),
              recordedTokens: Array.from(recTokens).slice(0, 5),
              chosenTokens: Array.from(choTokens).slice(0, 5),
              resolverPath: lintResult.resolverPath,
            });
            trace?.writeActionResult({
              stepId: stepDraft.id,
              stepType: stepDraft.type,
              success: false,
              durationMs: 0,
              error: 'pre-click-text-overlap-zero',
            });
            preClickAborted = true;
            // Cleanup the click-effect listener since we're not clicking.
            try { clickPreState?.cleanupDownloadListener?.(); } catch { /* non-fatal */ }
            // V24: invalidate cache so retry / next run doesn't get the same
            // wrong ref back in 200ms. Cache poisoning is the canonical cause
            // of "fixed once, broken forever" regressions on Angular Material
            // sites — guard rejected the pick, but cache still served it.
            try {
              const removed = invalidateLlmSelectionsForRef({
                rejectedRef: candidate.ref,
                pageUrl: page.url(),
                intentText: stepDraft.description || '',
              });
              if (removed > 0) {
                logger.info('[PREVIEW_APPLY] LLM cache invalidated after pre-click rejection', {
                  stepId: stepDraft.id,
                  rejectedRef: candidate.ref,
                  entriesRemoved: removed,
                });
              }
            } catch { /* never break apply on cache cleanup */ }
            // V25: invalidate stable-tokens cache too. If the rejected pick
            // was driven by a token-chain locator built from cached LLM
            // tokens, those tokens are now suspect — re-derive on next run.
            try {
              const recordedText = stepDraft.recordedFingerprint?.text || stepDraft.description || '';
              if (invalidateTokensForText(recordedText)) {
                logger.info('[PREVIEW_APPLY] Token cache invalidated after pre-click rejection', {
                  stepId: stepDraft.id,
                });
              }
            } catch { /* never break apply on cache cleanup */ }
            // V25 Phase 4: invalidate the pruner cache for the same
            // (pageUrl, intentText) so the next resolver call doesn't
            // serve a cached top-15 that included the rejected ref.
            // Mirrors `invalidateLlmSelectionsForRef` semantics.
            try {
              const removed = invalidatePrunerForRef({
                rejectedRef: candidate.ref,
                pageUrl: page.url(),
                intentText: stepDraft.description || '',
              });
              if (removed > 0) {
                logger.info('[PREVIEW_APPLY] Pruner cache invalidated after pre-click rejection', {
                  stepId: stepDraft.id,
                  rejectedRef: candidate.ref,
                  entriesRemoved: removed,
                });
              }
            } catch { /* never break apply on cache cleanup */ }
            // V26 Batch A: pre-click label-mismatch guard — same evidence
            // collection as the post-click fake-success guards above.
            return await PreviewStepApplyService._buildFailureResult({
              previewSessionId,
              stepDraft,
              page,
              error: `[wrong-element] Resolver wanted to click "${chosenLabelForGuard.slice(0, 60)}" for step targeting "${recordedLabelForGuard.slice(0, 60)}" — labels share no meaningful words. Click aborted to avoid side-effects. Refine the step description, or re-record so a structural fingerprint anchors the target.`,
              originatingStrategy: 'pre_click_label_mismatch',
              attempts,
              decisionTrace,
              highlight: [{
                ref: candidate.ref,
                boundingBox: candidate.boundingBox,
                type: 'error' as const,
              }],
              resolvedCandidates: [candidate],
              extra: {
                chosenRef: candidate.ref,
                chosenLabel: chosenLabelForGuard,
                chosenBoundingBox: candidate.boundingBox,
                resolverPath: lintResult.resolverPath,
              },
            });
          }
        }
        // Suppress unused-variable lint when guard didn't fire.
        if (preClickAborted) { /* unreachable */ }

        try {
          EditorTraceService.get(previewSessionId)?.writeApplyPhaseEntry({
            stepId: stepDraft.id, phase: 'action_execute',
          });
        } catch { /* non-fatal */ }
        let playwrightThrew = false;
        const result = await executeAction(page, stepDraft, candidate, undefined, { expectsNavigation, secretValues: secretValuesForAudit });
        const actionDur = Date.now() - actionStart;
        if (!result.success && result.error) playwrightThrew = true;
        try {
          EditorTraceService.get(previewSessionId)?.writeApplyPhaseExit({
            stepId: stepDraft.id, phase: 'action_execute',
            durationMs: actionDur,
            success: result.success,
            ...(playwrightThrew ? { skipReason: (result.error || '').slice(0, 80) } : {}),
          });
        } catch { /* non-fatal */ }

        // Emit fine-grained action timing before success/failure branches diverge.
        // `preWaitVisibleMs` is now the probe cost (~0 or ~200ms), not a real wait.
        // `wasAlreadyVisible` is the diagnostic signal — false means executeAction
        // had to wait for visibility internally.
        trace?.writeActionTiming({
          stepId: stepDraft.id,
          stepType: stepDraft.type,
          totalMs: actionDur,
          preWaitVisibleMs,
          wasAlreadyVisible,
          playwrightThrew,
          method: stepDraft.type,
        });

        if (result.success) {
          // V16: Post-action settle.
          //
          // Single-step Apply (!skipPostActionWait): run the full
          //   smartStepWait('post') plan — dom-settle + loading-clear + any
          //   action-specific post-phases (value-reflected, state-reflected,
          //   challenge-clear, etc.). Phase fast-checks skip quickly on a
          //   quiet page, so this is often cheaper than the old flat 2s
          //   waitForLoadState.
          //
          // Run mode (skipPostActionWait): the between-step lookahead does
          //   the heavy lifting; we keep only the 1s noWaitAfter safety
          //   buffer for mutating actions so reactive handlers get a chance
          //   to dispatch before snapshot invalidation.
          let postSettleMs = 0;
          let postSettleFired = false;
          if (!skipPostActionWait) {
            const settleStart = Date.now();
            try {
              EditorTraceService.get(previewSessionId)?.writeApplyPhaseEntry({
                stepId: stepDraft.id, phase: 'post_wait',
              });
            } catch { /* non-fatal */ }
            const waitResult = await smartStepWait({
              page,
              step: stepDraft,
              phase: 'post',
            }).catch(() => null);
            postSettleMs = Date.now() - settleStart;
            postSettleFired = !!waitResult?.ready;
            try {
              EditorTraceService.get(previewSessionId)?.writeApplyPhaseExit({
                stepId: stepDraft.id, phase: 'post_wait',
                durationMs: postSettleMs,
                success: postSettleFired,
                ...(postSettleFired ? {} : { skipReason: 'timeout_or_unsettled' }),
              });
            } catch { /* non-fatal */ }
          } else if (POST_ACTION_BUFFER_ACTIONS.has(stepDraft.type)) {
            await page.waitForTimeout(1000);
          }
          // Invalidate snapshot cache for DOM-mutating actions so next step's lint gets fresh nodes
          if (DOM_MUTATING_ACTIONS.has(stepDraft.type)) {
            const sess = sessionService.getSession(previewSessionId);
            if (sess) sess.lastSnapshotEmit = 0;
          }

          // V2: Post-action verification for state-aware actions
          let verified = false;
          let clickEffectSignal: ClickEffectSignal | undefined;
          // V23: marks a manual-add no-effect click that passed via soft
          // validation. Used downstream to skip compiled plan write (we
          // don't want next run's strict path to fail on the same legit no-op).
          let softPassedOnNoEffect = false;
          const stateChange: ApplyResult['stateChange'] = undefined;

          if (STATE_VERIFIABLE_ACTIONS.has(stepDraft.type) && candidate.ref) {
            const verifyStart = Date.now();
            try {
              EditorTraceService.get(previewSessionId)?.writeApplyPhaseEntry({
                stepId: stepDraft.id, phase: 'verify',
              });
            } catch { /* non-fatal */ }
            try {
              verified = await verifyActionEffect(page, stepDraft, candidate.ref);

              // Editor click-effect check: verifyActionEffect for click is
              // permissive (always true) so the action is "successful" even
              // when nothing on the page changed. We compare a pre-click
              // snapshot with the live DOM to catch click-in-void cases
              // (clicked through a modal backdrop, hit a no-op handler, etc.)
              // and surface them as honest failures instead of fake green.
              if (stepDraft.type === 'click' && verified && clickPreState) {
                const effect = await verifyClickHadEffect(page, clickPreState, candidate.ref, clickTargetFrame);
                clickEffectSignal = effect.signal;
                if (!effect.effected) {
                  verified = false;
                  logger.info('[PREVIEW_APPLY] Click had no observable effect', {
                    stepId: stepDraft.id,
                    candidateRef: candidate.ref,
                    signal: effect.signal,
                  });
                }
              }

              if (verified) {
                logger.debug('[PREVIEW_APPLY] Action verified', {
                  stepType: stepDraft.type,
                  candidateRef: candidate.ref,
                });
              }
              trace?.writeActionVerify({
                stepId: stepDraft.id,
                stepType: stepDraft.type,
                verificationMethod: stepDraft.type === 'click' ? 'click-effect'
                  : stepDraft.type === 'check' || stepDraft.type === 'uncheck' ? 'checked'
                  : stepDraft.type === 'open' || stepDraft.type === 'close' ? 'aria-expanded'
                  : stepDraft.type === 'toggle' ? 'aria-pressed'
                  : 'isVisible',
                verified,
                durationMs: Date.now() - verifyStart,
                ...(clickEffectSignal !== undefined ? { signal: clickEffectSignal } : {}),
              });
            } catch (verifyError) {
              logger.warn('[PREVIEW_APPLY] Verification failed', {
                error: verifyError instanceof Error ? verifyError.message : String(verifyError),
              });
              trace?.writeActionVerify({
                stepId: stepDraft.id,
                stepType: stepDraft.type,
                verificationMethod: 'none',
                verified: false,
                durationMs: Date.now() - verifyStart,
              });
            }
            try {
              EditorTraceService.get(previewSessionId)?.writeApplyPhaseExit({
                stepId: stepDraft.id, phase: 'verify',
                durationMs: Date.now() - verifyStart,
                success: verified,
                ...(clickEffectSignal !== undefined ? { skipReason: 'click_signal=' + clickEffectSignal } : {}),
              });
            } catch { /* non-fatal */ }
          }

          // For click in editor preview, treat verify=false as a real failure.
          // Don't try the next resolver candidate — they typically point at the
          // same screen region with the same overlay/state issue, so retrying
          // wastes ~2s per candidate without changing the outcome. Return fail
          // immediately; the Run loop's step-level retry already gives us a
          // second attempt with disabled cache + relaxed timeout.
          if (stepDraft.type === 'click' && !verified && clickEffectSignal === 'none') {
            // V23 (April 2026): SOFT validation for manual-add steps.
            //
            // Class of legit no-effect clicks that this strict guard breaks:
            //   - Self-link ("Главная" / "Explore" pointing to current page)
            //   - Idempotent toggle (already-subscribed "Subscribe" button)
            //   - Already-open accordion clicked again
            //   - Anchor link to a section already scrolled into view
            //
            // For RECORDED steps we have ground truth (recordedFingerprint +
            // future recordedClickEffect), so strict failure is correct: the
            // recorded interaction DID change something, and live "none"
            // means regression.
            //
            // For MANUAL-ADD steps (no recordedFingerprint, no compiled),
            // we have no ground truth. The user authored the step by typing
            // a description and the LLM picked a candidate. If the candidate:
            //   • is a legitimate interactive element (button / a / role=button|link), AND
            //   • LLM was confident (≥0.75), AND
            //   • fingerprint comparison didn't say "mismatch" (i.e. nothing
            //     suggests we hit the wrong element),
            // then "none" is most likely a legitimate no-op. Pass with a
            // warning surfaced via trace + lint; the user can inspect.
            //
            // This intentionally accepts a small false-negative rate (LLM
            // picked the wrong but interactive element with high confidence
            // by accident). The alternative — failing every Главная-style
            // self-link — produces a much worse UX.
            const isManualAdd = !stepDraft.recordedFingerprint && !stepDraft.compiled;
            const candidateNode = candidate.node;
            const isInteractiveTarget = !!candidateNode && (
              candidateNode.tag === 'button'
              || candidateNode.tag === 'a'
              || candidateNode.role === 'button'
              || candidateNode.role === 'link'
              || candidateNode.role === 'menuitem'
              || candidateNode.role === 'tab'
              || candidateNode.tag === 'input'
              || candidateNode.tag === 'summary'
            );
            const llmConfident = candidate.confidence >= 0.75;
            // For manual-add we already gated on `!stepDraft.recordedFingerprint`
            // via isManualAdd, so identity-audit signals (fingerprintMatch) don't
            // exist on this code path. When the step has neither recorded
            // fingerprint nor compiled plan, there's nothing to compare against —
            // the only signals we have are interactivity + confidence.

            if (isManualAdd && isInteractiveTarget && llmConfident) {
              logger.info('[PREVIEW_APPLY] Manual-add no-effect click — soft pass', {
                stepId: stepDraft.id,
                candidateRef: candidate.ref,
                candidateTag: candidateNode?.tag,
                candidateRole: candidateNode?.role,
                confidence: candidate.confidence,
              });
              trace?.writeActionResult({
                stepId: stepDraft.id,
                stepType: stepDraft.type,
                success: true,
                durationMs: actionDur,
                ...(clickEffectSignal !== undefined ? { signal: clickEffectSignal + ' (soft pass)' } as any : {}),
              });
              // Mark verified so the rest of the pipeline proceeds normally.
              // BUT: set `softPassedOnNoEffect` so we DON'T write a compiled
              // plan / promote the step out of manual-add. Otherwise the next
              // run would carry `compiled` and bypass this guard, falling back
              // into the strict path and failing again on the same legit no-op.
              verified = true;
              softPassedOnNoEffect = true;
              decisionTrace.softPassedOnNoEffect = true;
            } else {
              const clickNoEffectMsg = '[click-no-effect] Click did not change page state (URL, dialog, ARIA, focus). The element may be obstructed by an overlay, or the click handler did nothing.';
              trace?.writeActionResult({
                stepId: stepDraft.id,
                stepType: stepDraft.type,
                success: false,
                durationMs: actionDur,
                error: 'click-no-effect',
              });
              return {
                success: false,
                error: clickNoEffectMsg,
                attempts,
                highlight: [{
                  ref: candidate.ref,
                  boundingBox: candidate.boundingBox,
                  type: 'error' as const,
                }],
              };
            }
          }

          // Action genuinely succeeded — record the success result now (after
          // verification), so we don't emit a misleading success-then-fail
          // pair for click-in-void cases handled above.
          trace?.writeActionResult({
            stepId: stepDraft.id,
            stepType: stepDraft.type,
            success: true,
            durationMs: actionDur,
            postActionSettleMs: postSettleMs || undefined,
            postActionSettleFired: !skipPostActionWait ? postSettleFired : undefined,
          });

          // V3: Generate compiled plan from resolved node
          // Include pageSignature from session for staleness detection
          // Use urlBeforeAction to record the context where element was found
          let compiled;
          let pageSignature: string | undefined;
          // V23: skip compiled plan write when this run was a soft-pass on
          // no-effect click. We're not confident the click did the right thing
          // (we just trusted "interactive target + high LLM confidence"), so
          // pinning a compiled plan would lock the step onto a possibly-wrong
          // element AND promote it out of manual-add status, which would
          // bypass this same soft-validation guard on the next run.
          if (candidate.node && !softPassedOnNoEffect) {
            try {
              // Get pageSignature from session if available
              const session = sessionService.getSession(previewSessionId);
              pageSignature = session?.lastPageSignature;

              compiled = await LocatorPlanBuilder.buildCompiledPlan({
                step: stepDraft,
                resolvedNode: candidate.node,
                pageUrl: urlBeforeAction,
                pageTitle: await page.title().catch(() => undefined),
                pageSignature,
                page,
                onValidation: (stats) => {
                  try {
                    const t = EditorTraceService.get(previewSessionId);
                    t?.writeCompiledValidation({ stepId: stepDraft.id, ...stats });
                  } catch { /* never breaks apply */ }
                },
              });
              logger.debug('[PREVIEW_APPLY] Compiled plan generated', {
                stepId: stepDraft.id,
                locatorCount: compiled.locatorPlan.length,
                hasPageSignature: !!pageSignature,
              });
            } catch (compileError) {
              logger.warn('[PREVIEW_APPLY] Failed to generate compiled plan', {
                error: compileError instanceof Error ? compileError.message : String(compileError),
              });
            }
          } else if (softPassedOnNoEffect) {
            logger.debug('[PREVIEW_APPLY] Skipping compiled plan — soft pass on no-effect', {
              stepId: stepDraft.id,
            });
          }

          // Build resolution meta from lint result
          // Determine confidence tier based on candidate confidence
          const confidenceTier: ConfidenceTier =
            candidate.confidence >= 0.85 ? 'high' :
            candidate.confidence >= 0.6 ? 'medium' : 'low';

          const resolutionMeta: ResolutionMeta = {
            allowedCount: lintResult.candidates.length,
            usedRules: [],
            usedLLM: !lintResult.degradedMode,
            confidenceTier,
            topSimilarity: lintResult.topSimilarity,
          };

          // V27 — Compute fingerprintMatch FIRST so the backfill gate below
          // can consult it. Audit fields (chosenLabel etc.) are also needed
          // by trace below; computing here keeps the original audit contract.
          let chosenLabel: string | undefined;
          let chosenTagLive: string | undefined;
          let chosenIdLive: string | null | undefined;
          try {
            if (candidate.node) {
              // V23: universal label extractor — covers title (Angular routerLink),
              // alt (img), iconLabel/svgIcon (Lucide / FA / Material), childTestId
              // (lifted icon child), customElementTag (Angular wrapper). Without
              // this, identity-poor wrappers like `<a title="Папкалар"><svg/></a>`
              // produced chosenLabel="<a>" → label-mismatch guard always fired.
              chosenLabel = getEffectiveLabel(candidate.node) || `<${candidate.node.tag}>`;
              chosenTagLive = candidate.node.tag;
              chosenIdLive = candidate.node.id;
            }
          } catch { /* best-effort */ }
          const fingerprintMatch = compareToRecordedFingerprint(
            {
              tag: chosenTagLive,
              id: chosenIdLive,
              boundingBox: candidate.boundingBox || null,
            },
            stepDraft.recordedFingerprint
              ? {
                  tag: stepDraft.recordedFingerprint.tag,
                  elementId: stepDraft.recordedFingerprint.elementId,
                  boundingBox: stepDraft.recordedFingerprint.boundingBox,
                }
              : null,
          );

          // V23: capture chosen element for the trace (lint+success path).
          decisionTrace.chosen = {
            ref: candidate.ref,
            tag: chosenTagLive,
            role: candidate.node?.role,
            label: chosenLabel,
            text: candidate.node?.text ? candidate.node.text.slice(0, 60) : undefined,
            id: chosenIdLive ?? undefined,
            testIdAttr: candidate.node?.testIdAttr,
            bbox: candidate.boundingBox,
          };
          decisionTrace.fingerprintMatch = fingerprintMatch;
          if (typeof clickEffectSignal !== 'undefined') {
            decisionTrace.clickEffectSignal = clickEffectSignal;
          }

          // V27 — Backfill safety gate (root cause #2 of documentolog regression).
          //
          // Until V27 we rewrote `bindingHints` and `compiled` from the
          // resolved node *unconditionally*. That meant a single fake-success
          // (e.g. LLM picks <span>"Русский" for a `type:"email"` step, click
          // succeeds with weak/none signal, fingerprint mismatched but
          // recorded fingerprint absent so the fake-success guard couldn't
          // fire) corrupted the saved step in the DB on the very first Run —
          // and every subsequent Run reused the corrupted plan.
          //
          // The gate below restricts `bindingHints` / `compiled` writeback to
          // outcomes we are confident about. We keep `evidence.lastSuccessRef`
          // and `resolutionMeta` either way (those are diagnostic and short-
          // TTL — `capturedAt` lets the next run reject stale refs anyway).
          //
          // Trust criteria (must hold to backfill):
          //   1. Action was verified (`verified === true`) AND not on the
          //      manual-add soft-pass path (`!softPassedOnNoEffect` — soft
          //      pass intentionally suppresses compiled to avoid the same
          //      trap, so we don't backfill bindingHints either).
          //   2. Click effect signal is "strong" — not 'none' / 'newtab' /
          //      'focus'. Those are the canonical fake-success symptoms.
          //      `undefined` (non-click action like type/select) is allowed
          //      because verifyActionEffect already proved the effect via
          //      live inputValue / aria-state read.
          //   3. Fingerprint comparison is NOT a hard `mismatch`. `match` and
          //      `unknown` proceed (`unknown` is normal when the original
          //      record had no identifying fingerprint — see root cause #1).
          //
          // When any criterion fails, we keep the existing `bindingHints` and
          // `compiled` untouched. The step still reports success to the user
          // (this code path runs only after verified=true propagated into
          // the success branch); the DB just no longer absorbs a wrong
          // identity that would corrupt every subsequent Run.
          const isWeakSignal_v27 =
            clickEffectSignal === 'none'
            || clickEffectSignal === 'newtab'
            || clickEffectSignal === 'focus';
          const safeToBackfill_v27 =
            verified === true
            && !softPassedOnNoEffect
            && !isWeakSignal_v27
            && fingerprintMatch !== 'mismatch';

          if (!safeToBackfill_v27 && candidate.node) {
            logger.info('[PREVIEW_APPLY] Skipped bindingHints/compiled backfill — untrusted apply', {
              stepId: stepDraft.id,
              verified,
              softPassedOnNoEffect,
              clickEffectSignal,
              fingerprintMatch,
              candidateRef: candidate.ref,
              candidateTag: candidate.node.tag,
              candidateRole: candidate.node.role,
            });
          }

          // V2: Auto-populate bindingHints from resolved node — gated.
          const enrichedBindingHints_v27 = (candidate.node && safeToBackfill_v27)
            ? { ...stepDraft.bindingHints, ...buildBindingHintsFromNode(candidate.node) }
            : stepDraft.bindingHints;
          // Compiled plan only persists on a trusted apply.
          const compiledForUpdate_v27 = safeToBackfill_v27 ? compiled : stepDraft.compiled;

          // Build updatedStep with gated bindingHints/compiled. Evidence
          // (lastSuccessRef, resolutionMeta, capturedAt) is always written —
          // it's diagnostic and TTL-stamped, so a stale ref can't corrupt
          // future runs.
          const updatedStep: IntentStep = {
            ...stepDraft,
            bindingHints: enrichedBindingHints_v27,
            evidence: {
              ...stepDraft.evidence,
              lastSuccessRef: candidate.ref,
              confidence: candidate.confidence,
              resolutionMeta,
              capturedAt: new Date().toISOString(), // V15.6: staleness guard
            },
            compiled: compiledForUpdate_v27,
          };

          // Diagnostic: capture user intent → resolved element pair so
          // bisecting wrong-element regressions doesn't require a re-run.
          // Written BEFORE the fake-success guard so we see what the resolver
          // actually picked, even if we then reject it.
          try {
            logIntentResolveApply({
              stepDraft,
              candidate,
              resolverPath: lintResult.resolverPath,
              fingerprintMatch,
              clickEffectSignal,
              outcome: 'pass', // tentative; reject branches log again with their own outcome
              url: urlBeforeAction,
              attempts,
              durationMs: actionDur,
              resolverDegraded: lintResult.degradedMode,
              topSimilarity: lintResult.topSimilarity,
              candidatesCount: lintResult.candidates?.length,
              secretValues: secretValuesForAudit,
            });
          } catch { /* never break apply on diagnostics */ }

          // Fake-success guard. The resolver landed on an element whose
          // identity does not line up with what the recorder captured, AND
          // the only thing that "verified" the click was a focus shift or
          // 'none'. Almost every fake-success bug we hunted on hub.atk.pro
          // matches this pattern: LLM picked the loudest CTA next to the
          // real target, the click navigated *somewhere*, focus moved, and
          // the verifier rubber-stamped it green. With the recorded id
          // present we have ground truth — if it doesn't match, this is
          // not a pass. Strong signals (url / dialog / aria expansion /
          // dom mutation / detach / newtab) are still allowed through:
          // mismatch under those is suspicious but the click did clearly
          // do something the test cared about, so we let trace audit catch
          // it post-hoc rather than block.
          // V23: hasGroundTruth widened. Originally required id/testId/name —
          // strong identifiers. But on Angular sites (juz40-edu, documentolog
          // curator) those don't exist on every recorded element; recorder
          // saves `tag + text + bbox` as the fingerprint. When `bbox` is
          // recorded AND chosen ended up far away (chosen.bbox vs
          // recorded.bbox in geographically different regions of the page),
          // that's identity ground-truth too — strict equality of the bbox
          // isn't required; mismatch via `compareToRecordedFingerprint` already
          // means tag+id+bbox don't agree. Without this widening, the LLM
          // picking the profile-avatar `<li>` in the top-right (36×36 at
          // x=1220) when recorded was the `<a>` MAT-SMART card (752×80 at
          // y=120) passed as success because `hasGroundTruth=false` → guard
          // skipped. We saw exactly that on juz40 stepIndex=8: chosenLabel="Б"
          // for intent "MAT-SMART раздел". This widens the ground-truth set
          // to include any recordedFingerprint with text+bbox (the recorder's
          // baseline), keeping id/testId/name as stronger signals when they
          // exist but no longer requiring them.
          // V23: hasGroundTruth covers the FULL identity universe per
          // recorder. Three tiers — strong (unique on page), accessible-name
          // (visible label + bbox baseline), and product-specific markers.
          // The recorder always saves bbox, so any field paired with it
          // gives us something to compare against.
          //
          // Each entry is documented with WHY it counts as identity:
          //   strong: unique attribute the dev assigned for stability
          //   accessible-name: WCAG-recommended user-visible identifier
          //   marker: framework/library-specific stable handle
          const rfp = stepDraft.recordedFingerprint;
          const hasBbox = !!rfp?.boundingBox;
          const hasGroundTruth =
            stepDraft.type === 'click' &&
            !!rfp &&
            (
              // ── TIER 1 — strong identifiers (unique by author intent) ──
              !!rfp.elementId          ||  // <button id="login-btn">
              !!rfp.testIdAttr         ||  // data-testid / data-cy / data-qa
              !!rfp.name               ||  // <input name="email">
              !!rfp.svgIcon            ||  // <mat-icon svgicon="folder"> registry name
              !!rfp.childTestId        ||  // lifted icon-child data-testid (V22 Pkg1)
              !!rfp.customElementTag   ||  // <app-excel-btn> semantic wrapper
              !!rfp.dataValue          ||  // <option value="kz"> semantic key
              !!rfp.dataRowKey         ||  // AntD <tr data-row-key="..."> stable row id
              (!!rfp.bsToggle && !!rfp.bsTarget) ||  // Bootstrap toggle+target combo
              !!rfp.href               ||  // <a href="..."> link destination

              // ── TIER 2 — accessible-name + bbox (recorder baseline) ──
              (!!rfp.text       && hasBbox) ||  // visible textContent
              (!!rfp.labelText  && hasBbox) ||  // <label for=> / wrapping <label>
              (!!rfp.ariaLabel  && hasBbox) ||  // explicit ARIA accessible name
              (!!rfp.title      && hasBbox) ||  // <a title>/<button title> tooltip
              (!!rfp.alt        && hasBbox) ||  // <img alt> / <input type=image alt>
              (!!rfp.iconLabel  && hasBbox) ||  // svg <title>/data-lucide/FA class
              (!!rfp.placeholder && hasBbox)    // input placeholder
            );
          // 'newtab' is treated as weak under mismatch — opening an unrelated
          // tab is the canonical fake-success symptom (recorder captured a
          // settings cog with id="layout-header-setting", LLM clicked a
          // neighbouring "click me!" banner, popup→yuque.com docs, verifier
          // saw newtab and stamped pass). Real navigations land on the same
          // page (url change without popup), which is signal 'url'.
          //
          // V23: 'url' signal also treated as suspicious when fingerprintMatch
          // is mismatch AND chosen bbox is geographically far from recorded.
          // Observed on juz40: click on profile avatar (bbox x=1220 y=10)
          // momentarily flipped URL via Angular router → signal='url' →
          // guard let it through despite recorded bbox (x=344 y=120) being
          // ~880px away. Verify URL actually persisted (not transient
          // redirect/error-handler bounce) by comparing recorded vs current.
          const weakSignal = clickEffectSignal === 'focus' || clickEffectSignal === 'none' || clickEffectSignal === 'newtab' || clickEffectSignal === undefined;
          // V23: bbox-distance heuristic — if chosen and recorded bboxes have
          // no spatial overlap (centers >200px apart in either axis), even
          // a 'url' signal becomes suspicious for a mismatch. Real navigations
          // by the right element happen at THAT element's bbox; a URL flip
          // from a different region is almost always a side-effect of clicking
          // somewhere else (profile menu opens, internal nav, etc.).
          let bboxFarApart = false;
          // V24 — multilang escape (mirrors label guard): if chosen sits in
          // the same geometric position as recorded AND has comparable size,
          // treat as i18n / dynamic copy — fingerprint text mismatch is then
          // a translation difference, not a wrong-element pick.
          //
          // Example:
          //   recorded fingerprint: {text: "Save", bbox: {x:100,y:200,w:80,h:32}}
          //   chosen: <button>Сохранить</button> at same coords
          //   compareToRecordedFingerprint says mismatch (text differs)
          //   weak signal (focus) → would reject WITHOUT this escape
          //   With escape: bbox close + size similar → trust the click.
          //
          // Same thresholds as label guard for consistency: ≤50px center
          // distance + ≥0.5 size ratio. See cell-by-cell rationale at the
          // bbox helper in label guard below.
          let identityBboxImpliesSame = false;
          try {
            const rb = stepDraft.recordedFingerprint?.boundingBox;
            const cb = candidate.boundingBox;
            if (rb && cb) {
              const recCenterX = rb.x + rb.width / 2;
              const recCenterY = rb.y + rb.height / 2;
              const choCenterX = cb.x + cb.width / 2;
              const choCenterY = cb.y + cb.height / 2;
              const dx = Math.abs(recCenterX - choCenterX);
              const dy = Math.abs(recCenterY - choCenterY);
              // Threshold: 200px in either axis. Tight enough to allow
              // legitimate layout shifts (header re-flow), wide enough to
              // catch "clicked the avatar instead of the card" cases.
              bboxFarApart = dx > 200 || dy > 200;
              // Multilang escape: close + same size = same widget.
              const centerDist = Math.hypot(dx, dy);
              const recArea = Math.max(1, rb.width * rb.height);
              const choArea = Math.max(1, cb.width * cb.height);
              const sizeRatio = Math.min(recArea, choArea) / Math.max(recArea, choArea);
              identityBboxImpliesSame = centerDist <= 50 && sizeRatio >= 0.5;
            }
          } catch { /* defensive */ }
          // Treat 'url' as weak when bbox is far apart — see above.
          const effectivelyWeak = weakSignal || (clickEffectSignal === 'url' && bboxFarApart);
          // Multilang escape: only override for non-'none' signals. signal=none
          // even at the same bbox means click went into a void — still suspicious.
          const identityMultilangEscape = identityBboxImpliesSame && clickEffectSignal !== 'none';
          if (hasGroundTruth && fingerprintMatch === 'mismatch' && effectivelyWeak && !identityMultilangEscape) {
            logger.warn('[PREVIEW_APPLY] Rejecting fake-success: fingerprint mismatch with weak click signal', {
              stepId: stepDraft.id,
              candidateRef: candidate.ref,
              chosenLabel,
              chosenIdLive,
              recordedId: stepDraft.recordedFingerprint?.elementId,
              recordedTestId: stepDraft.recordedFingerprint?.testIdAttr,
              clickEffectSignal,
            });
            try {
              logIntentResolveApply({
                stepDraft,
                candidate,
                resolverPath: lintResult.resolverPath,
                fingerprintMatch,
                clickEffectSignal,
                outcome: 'reject',
                rejectReason: 'fingerprint-mismatch-weak-signal',
                url: urlBeforeAction,
                attempts,
                durationMs: actionDur,
                resolverDegraded: lintResult.degradedMode,
                topSimilarity: lintResult.topSimilarity,
                candidatesCount: lintResult.candidates?.length,
                secretValues: secretValuesForAudit,
              });
            } catch { /* never break apply on diagnostics */ }
            trace?.writeActionResult({
              stepId: stepDraft.id,
              stepType: stepDraft.type,
              success: false,
              durationMs: actionDur,
              error: 'fingerprint-mismatch-weak-signal',
            });
            // V24: dismiss any parasitic overlay opened by this rejected click,
            // so the run-loop's retry can find its target. Conditional — refuses
            // to dismiss overlays that pre-existed (legitimate user-recorded popup).
            await dismissParasiticOverlay(page, clickPreState, {
              previewSessionId,
              stepId: stepDraft.id,
              reason: 'identity-fingerprint-mismatch-rejection',
            });
            // V24: invalidate LLM cache so retry doesn't get the same wrong
            // ref. Without this, run #2 cacheHit returns the stale wrong pick
            // in 200ms and we re-fail on the same false answer.
            try {
              const removed = invalidateLlmSelectionsForRef({
                rejectedRef: candidate.ref,
                pageUrl: page.url(),
                intentText: stepDraft.description || '',
              });
              if (removed > 0) {
                logger.info('[PREVIEW_APPLY] LLM cache invalidated after identity-mismatch rejection', {
                  stepId: stepDraft.id,
                  rejectedRef: candidate.ref,
                  entriesRemoved: removed,
                });
              }
            } catch { /* never break apply on cache cleanup */ }
            // V25: invalidate stable-tokens cache too — see pre-click guard
            // for rationale. Token-chain locators that drove this click may
            // be built from suspect cached tokens.
            try {
              const recordedText = stepDraft.recordedFingerprint?.text || stepDraft.description || '';
              if (invalidateTokensForText(recordedText)) {
                logger.info('[PREVIEW_APPLY] Token cache invalidated after identity-mismatch rejection', {
                  stepId: stepDraft.id,
                });
              }
            } catch { /* never break apply on cache cleanup */ }
            // V25 Phase 4: invalidate pruner cache — see pre-click guard.
            try {
              const removed = invalidatePrunerForRef({
                rejectedRef: candidate.ref,
                pageUrl: page.url(),
                intentText: stepDraft.description || '',
              });
              if (removed > 0) {
                logger.info('[PREVIEW_APPLY] Pruner cache invalidated after identity-mismatch rejection', {
                  stepId: stepDraft.id,
                  rejectedRef: candidate.ref,
                  entriesRemoved: removed,
                });
              }
            } catch { /* never break apply on cache cleanup */ }
            // V26 Batch A: fake-success rejection — was silent (no bundle).
            // Now collects evidence so the dashboard can show the wrong
            // element + page state to the user.
            return await PreviewStepApplyService._buildFailureResult({
              previewSessionId,
              stepDraft,
              page,
              error: `[wrong-element] Resolver clicked "${chosenLabel || candidate.ref}" but the recorded target had id="${stepDraft.recordedFingerprint?.elementId || stepDraft.recordedFingerprint?.testIdAttr}". The click only triggered a ${clickEffectSignal || 'no'} change, not a real navigation/dialog/state update — almost certainly a fake-success. Refine the step description or check that the recorded id still exists on the page.`,
              originatingStrategy: 'fake_success_guard',
              attempts,
              decisionTrace,
              highlight: [{
                ref: candidate.ref,
                boundingBox: candidate.boundingBox,
                type: 'error' as const,
              }],
              resolvedCandidates: [candidate],
              extra: {
                clickEffectSignal,
                chosenRef: candidate.ref,
                chosenLabel,
                chosenBoundingBox: candidate.boundingBox,
                fingerprintMatch,
                resolverPath: lintResult.resolverPath,
              },
            });
          }

          // Label-based fallback guard for steps recorded BEFORE
          // `recordedFingerprint` was added (April 27 2026). Identity gate
          // above can't fire for those — the field is just not in the DB row.
          // Without this fallback, on weak-signal clicks (focus / none / newtab),
          // the LLM is free to pick any visually loud element on the page and
          // the verifier rubber-stamps it. Real-world example: step
          // description "МАТ-smart желтоқсан", chosenLabel "Б" (profile avatar
          // in the header), signal `focus` → fake pass.
          //
          // Ground truth comes from whatever the recorder DID capture for the
          // step: bindingHints.{label,text,nearText} (preferred — recording
          // time, exact element) and the step description (fallback, may be
          // user-edited but still authoritative). chosenLabel is the live
          // accessible name of the element the resolver picked. If the two
          // share zero meaningful tokens AND the click signal is weak, treat
          // it the same as a fingerprint mismatch.
          //
          // Strong signals (url / dialog / aria / dom / detach) still pass —
          // those mean the click DID move the test forward, even if onto a
          // different element than the recording. That's a different class of
          // bug (recording drift) and gets caught by post-hoc trace audit.
          //
          // V24: tokenization / fuzzy / overlap helpers extracted to
          // `text-similarity.util.ts` (shared with the pre-click guard above
          // and unit-tested). Cyrillic↔Latin glyph fold + NFD diacritic strip
          // + stopwords filter + Damerau-Levenshtein ≤ 2.
          const recordedLabel =
            stepDraft.bindingHints?.label
            || stepDraft.bindingHints?.text
            || stepDraft.bindingHints?.nearText
            || stepDraft.description
            || '';
          const recordedTokens = tokenizeLabel(recordedLabel);
          const chosenTokens = tokenizeLabel(chosenLabel);
          // chosenLabel sometimes degrades to `<tag>` form when the live node
          // has no accessible name (icon button, single-char avatar, generic
          // <li>/<button>). Treat that as "no usable chosen label" → guard
          // fires whenever recorded labels are meaningful, because no overlap
          // is possible. Same effect when the live label is a single char
          // (e.g. profile avatar "Б" — 1-letter tokens are dropped by
          // tokenize()'s 3-char minimum).
          // V24 — Q2: relax for short valid labels.
          //
          // Old logic: chosenTokens.size === 0 → generic. But tokenizeLabel
          // drops anything <3 chars, so valid short labels like "OK", "Go",
          // "Yes", "Hi" all became "generic" → guard always fired against
          // recorded steps targeting them.
          //
          // We keep the "single Cyrillic letter" trap (juz40 avatar "Б") and
          // the bare-tag form ("<button>"), but accept short alpha words as
          // legitimate labels. Rationale: real interactive elements rarely
          // have 1-char labels by design — buttons say "OK", icons have
          // aria-labels, single chars are usually avatars / index markers.
          const trimmedChosen = (chosenLabel || '').trim();
          const isBareTagForm = /^<[^>]+>$/.test(trimmedChosen);
          const isSingleAlphaChar = trimmedChosen.length === 1 && /^[\p{L}]$/u.test(trimmedChosen);
          const hasTokens = chosenTokens.size > 0;
          const hasShortAlphaLabel = trimmedChosen.length >= 2 && /[\p{L}\p{N}]/u.test(trimmedChosen);
          const chosenLabelIsGeneric =
            !chosenLabel
            || isBareTagForm
            || isSingleAlphaChar
            || (!hasTokens && !hasShortAlphaLabel);
          // Eligibility: don't double-fire when the identity guard above
          // already had ground truth, and require a meaningful recorded
          // anchor (≥1 token after the 3-char filter).
          //
          // For label-based gating, `dom` is upgraded from "strong" to
          // "checkable" — a wrong click can still mutate the DOM (open a
          // profile menu, expand an unrelated panel) and the existing
          // identity guard's "strong = always pass" assumption stops
          // holding when there's no fingerprint to corroborate. Url /
          // dialog / aria / detach remain strong: those move the test
          // forward toward something testable.
          const labelGuardWeakSignal =
            weakSignal || clickEffectSignal === 'dom';
          // V24 — Gap 1: respect user's lint preview for manual-add steps.
          //
          // Manual-add steps have no recordedFingerprint — the user typed a
          // description and saw the lint highlight which element resolved.
          // If they then hit Run, they explicitly approved that pick. Blocking
          // their click here second-guesses an informed decision.
          //
          // BUT: between lint preview and Run, the page can mutate (SPA
          // route, modal close). LLM re-resolves on the fresh DOM and may
          // pick a different element the user never saw. For that race we
          // keep a narrow safety net: signal='none' (the click did literally
          // nothing) on a manual-add step still triggers the guard. Other
          // weak signals (focus / dom / newtab) are interpreted as "the user
          // approved this and the click had SOME effect" → trust them.
          //
          // Recorded steps are unchanged — full guard applies because the
          // fingerprint represents real ground truth from a past run.
          const isManualAddStep = !stepDraft.recordedFingerprint;
          const labelGuardSignalEligible = isManualAddStep
            ? clickEffectSignal === 'none'  // narrow: only literal no-effect
            : labelGuardWeakSignal;          // broad: focus / none / newtab / dom
          const labelGuardEligible =
            !hasGroundTruth
            && stepDraft.type === 'click'
            && labelGuardSignalEligible
            && recordedTokens.size >= 1;
          // Reject when recorded and chosen labels share zero tokens, OR
          // when the chosen label is too generic to validate at all.
          // Compute overlap once — the value is reused in the diagnostic log.
          const labelOverlapCount = tokenOverlap(recordedTokens, chosenTokens);
          // V24 — Multilang escape hatch.
          //
          // If labels share zero tokens but the chosen element is in the SAME
          // geometric position as the recorded element, treat it as i18n /
          // dynamic copy (legit) rather than wrong-element.
          //
          // Example we'd otherwise break:
          //   Recorded label: "Кнопка сохранить" (user wrote in Russian)
          //   Live UI: "Сақтау" (page is in Kazakh)
          //   Same button, just translated. text overlap = 0, but bbox is
          //   identical → don't block.
          //
          // Threshold: centres within 50px AND size ratio ≥0.5 (allows minor
          // re-flow but rejects "same place by accident" matches between an
          // 80-px button and a 600-px banner). Tight enough that "clicked the
          // banner instead of the button" doesn't slip through (those are
          // usually ≥100px apart).
          //
          // Only for recorded steps (manual-add has no recorded bbox).
          let bboxImpliesSameElement = false;
          if (
            !isManualAddStep
            && stepDraft.recordedFingerprint?.boundingBox
            && candidate.boundingBox
          ) {
            const rb = stepDraft.recordedFingerprint.boundingBox;
            const cb = candidate.boundingBox;
            const recCenterX = rb.x + rb.width / 2;
            const recCenterY = rb.y + rb.height / 2;
            const choCenterX = cb.x + cb.width / 2;
            const choCenterY = cb.y + cb.height / 2;
            const centerDist = Math.hypot(recCenterX - choCenterX, recCenterY - choCenterY);
            const recArea = Math.max(1, rb.width * rb.height);
            const choArea = Math.max(1, cb.width * cb.height);
            const sizeRatio = Math.min(recArea, choArea) / Math.max(recArea, choArea);
            // 50px ≈ "same widget after re-flow"; 0.5 size ratio rules out
            // catching a giant container that happens to overlap geometrically.
            bboxImpliesSameElement = centerDist <= 50 && sizeRatio >= 0.5;
          }
          // V24 — Gap 6: tighten 'none' signal handling.
          //
          // signal='none' means the click triggered absolutely nothing on the
          // page (no URL change, no DOM mutation, no focus shift, no dialog).
          // For a correct click this is rare — almost any real interactive
          // element produces SOME effect. So 'none' on top of label-mismatch
          // is a strong "wrong element" signal.
          //
          // But there are legit no-effect clicks: self-link to current page,
          // already-toggled idempotent action, anchor to already-visible
          // section. In those cases labels should agree (recorded "Главная"
          // vs chosen "Главная" → overlap > 0 → guard already passes them).
          //
          // Edge case this catches: labels share 1 random token by accident
          // ("form" in both "Click submit form" and "form input field") AND
          // signal=none AND bbox is geographically far. Standard guard would
          // pass on overlap=1; we want to block.
          //
          // Fail-open default: if bbox info missing (rare — recorder always
          // captures it for clicks), don't escalate. Better to false-negative
          // than to false-positive on a working test.
          let noneSignalSuspicious = false;
          if (clickEffectSignal === 'none' && labelOverlapCount > 0) {
            // Coverage gate: if all recorded tokens have a counterpart in
            // chosen, this is a full-label match (just bbox shifted on a
            // re-flowed page — Self-link "Главная", responsive layout). Do
            // NOT escalate — bbox alone after a full label match is too
            // weak to override.
            const fullLabelMatch = labelOverlapCount >= recordedTokens.size;
            if (!fullLabelMatch) {
              const rb = stepDraft.recordedFingerprint?.boundingBox;
              const cb = candidate.boundingBox;
              if (rb && cb) {
                const recCenterX = rb.x + rb.width / 2;
                const recCenterY = rb.y + rb.height / 2;
                const choCenterX = cb.x + cb.width / 2;
                const choCenterY = cb.y + cb.height / 2;
                const dx = Math.abs(recCenterX - choCenterX);
                const dy = Math.abs(recCenterY - choCenterY);
                // Same 200px threshold as identity guard's bboxFarApart.
                noneSignalSuspicious = dx > 200 || dy > 200;
              }
            }
          }
          const labelMismatchRaw =
            chosenLabelIsGeneric
            || labelOverlapCount === 0
            || noneSignalSuspicious;
          // V24 — multilang escape: same geometric position implies same
          // element regardless of label difference. But: don't override the
          // 'none' signal — even at the same bbox, no-effect click still
          // means the click went into a void (overlapping disabled element,
          // hidden interactive layer). Only override pure label-disagreement.
          const labelMismatch =
            labelMismatchRaw
            && !(bboxImpliesSameElement && clickEffectSignal !== 'none');
          if (labelGuardEligible && labelMismatch) {
            logger.warn('[PREVIEW_APPLY] Rejecting fake-success: label mismatch (no recorded fingerprint)', {
              stepId: stepDraft.id,
              candidateRef: candidate.ref,
              chosenLabel,
              chosenLabelIsGeneric,
              recordedLabel: recordedLabel.slice(0, 80),
              clickEffectSignal,
              recordedTokens: Array.from(recordedTokens).slice(0, 5),
              chosenTokens: Array.from(chosenTokens).slice(0, 5),
              tokenOverlap: labelOverlapCount,
            });
            try {
              logIntentResolveApply({
                stepDraft,
                candidate,
                resolverPath: lintResult.resolverPath,
                fingerprintMatch,
                clickEffectSignal,
                outcome: 'reject',
                rejectReason: `label-mismatch-weak-signal recorded=[${Array.from(recordedTokens).slice(0, 5).join(',')}] chosen=[${Array.from(chosenTokens).slice(0, 5).join(',')}]`,
                url: urlBeforeAction,
                attempts,
                durationMs: actionDur,
                resolverDegraded: lintResult.degradedMode,
                topSimilarity: lintResult.topSimilarity,
                candidatesCount: lintResult.candidates?.length,
                secretValues: secretValuesForAudit,
              });
            } catch { /* never break apply on diagnostics */ }
            trace?.writeActionResult({
              stepId: stepDraft.id,
              stepType: stepDraft.type,
              success: false,
              durationMs: actionDur,
              error: 'label-mismatch-weak-signal',
            });
            // V24: dismiss only if the overlay is parasitic (didn't exist
            // before our click). The helper compares pre-click overlay
            // signature with current state — if they match, the overlay was
            // user-recorded and we leave it alone (closing it would break
            // the test's intended flow on the retry).
            //
            // Sequence this protects against (juz40-edu.kz / hub.atk.pro):
            //   1. attempt 1 → wrong target (e.g. profile "Б") → opens
            //      cdk-overlay-pane (Angular Material profile menu)
            //   2. guard rejects → returns failure
            //   3. retry → correct target found → click
            //   4. cdk-overlay-backdrop intercepts → 15s timeout → fail
            //
            // Inverse case to NOT break (legitimate recorded popup):
            //   step N: "Click 'Меню'" → dropdown opens
            //   step N+1: "Click 'Настройки' in menu"
            //   if N+1's resolver guesses wrong, we MUST NOT close the
            //   dropdown here — the recorded user flow goes through it.
            await dismissParasiticOverlay(page, clickPreState, {
              previewSessionId,
              stepId: stepDraft.id,
              reason: 'label-mismatch-rejection',
            });
            // V24: invalidate LLM cache so retry doesn't get the same wrong
            // ref. Same rationale as identity guard above.
            try {
              const removed = invalidateLlmSelectionsForRef({
                rejectedRef: candidate.ref,
                pageUrl: page.url(),
                intentText: stepDraft.description || '',
              });
              if (removed > 0) {
                logger.info('[PREVIEW_APPLY] LLM cache invalidated after label-mismatch rejection', {
                  stepId: stepDraft.id,
                  rejectedRef: candidate.ref,
                  entriesRemoved: removed,
                });
              }
            } catch { /* never break apply on cache cleanup */ }
            // V25: invalidate stable-tokens cache too — see pre-click guard
            // for rationale.
            try {
              const recordedText = stepDraft.recordedFingerprint?.text || stepDraft.description || '';
              if (invalidateTokensForText(recordedText)) {
                logger.info('[PREVIEW_APPLY] Token cache invalidated after label-mismatch rejection', {
                  stepId: stepDraft.id,
                });
              }
            } catch { /* never break apply on cache cleanup */ }
            // V25 Phase 4: invalidate pruner cache — see pre-click guard.
            try {
              const removed = invalidatePrunerForRef({
                rejectedRef: candidate.ref,
                pageUrl: page.url(),
                intentText: stepDraft.description || '',
              });
              if (removed > 0) {
                logger.info('[PREVIEW_APPLY] Pruner cache invalidated after label-mismatch rejection', {
                  stepId: stepDraft.id,
                  rejectedRef: candidate.ref,
                  entriesRemoved: removed,
                });
              }
            } catch { /* never break apply on cache cleanup */ }
            // V26 Batch A: label-mismatch fake-success rejection — same
            // bundle treatment as the fingerprint-mismatch sibling above.
            return await PreviewStepApplyService._buildFailureResult({
              previewSessionId,
              stepDraft,
              page,
              error: `[wrong-element] Resolver clicked "${chosenLabel || candidate.ref}" but the step targets "${recordedLabel.slice(0, 60)}". The click only triggered a ${clickEffectSignal || 'no'} change, and the labels share no meaningful words — almost certainly a fake-success. Re-record the step so a structural fingerprint is captured, or refine the step description.`,
              originatingStrategy: 'fake_success_guard',
              attempts,
              decisionTrace,
              highlight: [{
                ref: candidate.ref,
                boundingBox: candidate.boundingBox,
                type: 'error' as const,
              }],
              resolvedCandidates: [candidate],
              extra: {
                clickEffectSignal,
                chosenRef: candidate.ref,
                chosenLabel,
                chosenBoundingBox: candidate.boundingBox,
                fingerprintMatch,
                resolverPath: lintResult.resolverPath,
              },
            });
          }
          // Synthesize a `recordedFingerprint` for manually-added steps.
          // By this point both guards (identity-mismatch + weak, label-
          // mismatch + weak) have already let the action through, AND the
          // V27 backfill gate has confirmed verified+strong+!mismatch — so
          // the resolved node is the trusted ground truth. Anchor the step
          // structurally so subsequent runs can use the identity fast-path
          // and the fake-success guard — exactly the protections recorded
          // steps get for free. Only writes when the field is missing, so
          // it never overwrites a real recorder fingerprint.
          //
          // V27 — extended from click-only to type/select/check/uncheck/
          // toggle. Rationale: when V27 dropped the
          // `compiled?.targetFingerprint` echo as an identity-fast-path
          // input (see element-resolver.service.ts), manual-add fill-class
          // steps lost their fast-path entirely (no recorded fingerprint
          // ever gets written; click was the only synth-target). Trusted
          // synthetic recordedFingerprint here gives those steps the same
          // structural anchor the click path already has, via the SAFE
          // channel (gated by the V27 trust criteria below) instead of
          // the unsafe compiled-echo path that caused the documentolog
          // poisoning.
          //
          // Trust criteria mirror the V27 backfill gate exactly: only
          // proceed when the apply was verified, signal was strong, and
          // fingerprint comparison wasn't a hard mismatch. Otherwise we
          // leave the step without a synthetic anchor — next Apply will
          // run the resolver fresh, which is the right behaviour for an
          // untrusted action.
          //
          // hover and other purely-visual actions are still excluded —
          // their post-action verification can't tell us whether we
          // actually hit the right element.
          const SYNTH_FP_ACTIONS = new Set(['click', 'type', 'select', 'check', 'uncheck', 'toggle']);
          const isWeakSignalForSynth =
            clickEffectSignal === 'none'
            || clickEffectSignal === 'newtab'
            || clickEffectSignal === 'focus';
          const trustedForSynth =
            verified === true
            && !softPassedOnNoEffect
            && !isWeakSignalForSynth
            && fingerprintMatch !== 'mismatch';
          let appliedStep = updatedStep;
          if (
            SYNTH_FP_ACTIONS.has(stepDraft.type)
            && !stepDraft.recordedFingerprint
            && trustedForSynth
            && candidate.node
          ) {
            const synthetic = buildSyntheticFingerprintFromNode(candidate.node);
            // Reject empty synthesis — without at least tag/role/labelText
            // there is no identity worth persisting.
            if (Object.keys(synthetic).length > 0) {
              appliedStep = { ...updatedStep, recordedFingerprint: synthetic };
              logger.info('[PREVIEW_APPLY] Synthesized recordedFingerprint for manual step', {
                previewSessionId,
                stepId: stepDraft.id,
                stepType: stepDraft.type,
                fpKeys: Object.keys(synthetic).slice(0, 10),
                signal: clickEffectSignal,
                fingerprintMatch,
              });
            }
          } else if (
            // V26: Backfill MISSING identity fields onto an EXISTING recorded
            // fingerprint when the LLM resolver successfully found the step's
            // target. Without this, fingerprints captured by older recorder
            // versions (or recorded before each new identity field was added
            // to the probe) never gained the new fields — the only path to
            // populate them was re-recording the click by hand.
            //
            // Fix: when LLM picks a node and post-action verifies (we're in
            // the success branch), copy every identity-bearing field from the
            // live node onto the recorded fingerprint — but ONLY where the
            // recorded value is missing. Never overwrite: the recorded value
            // is the authoritative one (the human-confirmed target at record
            // time); we're just filling in fields the recorder didn't yet
            // know how to capture.
            //
            // What we INCLUDE (stable identity that helps future resolution):
            //   firstTextFragment, href, elementId, testIdAttr, name, alt,
            //   svgIcon, iconLabel, customElementTag, cssClass, ariaControls,
            //   vueScopeId, childTestId, nearestLandmark, containerTitles
            //
            // What we EXCLUDE (state-dependent or page-layout dependent —
            // copying these would let a stale snapshot poison the recorded
            // identity across runs):
            //   boundingBox, text, ariaState, disabled, siblingIndex,
            //   arrowDir, ancestorSummary, dataValue, role, tag
            stepDraft.type === 'click'
            && stepDraft.recordedFingerprint
            && !softPassedOnNoEffect
            && candidate.node
          ) {
            const fp = stepDraft.recordedFingerprint;
            const liveNode = candidate.node as any;
            const backfill: Partial<TargetFingerprint> = {};

            // Helper: only set when recorded slot is empty AND live has value.
            // Keeps the "recorded is authoritative" invariant explicit.
            const fillIfMissing = <K extends keyof TargetFingerprint>(
              key: K,
              liveKey: string = key as string,
            ): void => {
              const liveVal = liveNode[liveKey];
              if (fp[key] === undefined && liveVal !== undefined && liveVal !== null && liveVal !== '') {
                (backfill as any)[key] = liveVal;
              }
            };

            // Identity-bearing single-value fields.
            fillIfMissing('firstTextFragment');
            fillIfMissing('href');
            // node.id (live) → fp.elementId (canonical name on fingerprint).
            // Skip framework-generated IDs — same gate as the recorder/synthetic
            // path so identity match doesn't lock onto an unstable token.
            if (fp.elementId === undefined && liveNode.id && !liveNode.isDynamicId) {
              backfill.elementId = liveNode.id;
            }
            fillIfMissing('testIdAttr');
            fillIfMissing('name');
            fillIfMissing('alt');
            fillIfMissing('svgIcon');
            fillIfMissing('iconLabel');
            fillIfMissing('customElementTag');
            fillIfMissing('cssClass');
            fillIfMissing('ariaControls');
            fillIfMissing('vueScopeId');
            fillIfMissing('childTestId');
            fillIfMissing('nearestLandmark');
            fillIfMissing('title');

            // containerTitles is an array — only fill when recorded array is
            // missing/empty AND live has at least one entry.
            if (
              (!fp.containerTitles || fp.containerTitles.length === 0)
              && Array.isArray(liveNode.containerTitles)
              && liveNode.containerTitles.length > 0
            ) {
              backfill.containerTitles = liveNode.containerTitles.slice(0, 3);
            }

            if (Object.keys(backfill).length > 0) {
              appliedStep = {
                ...updatedStep,
                recordedFingerprint: { ...fp, ...backfill },
              };
              logger.info('[PREVIEW_APPLY] Backfilled missing identity fields on recorded fingerprint', {
                previewSessionId,
                stepId: stepDraft.id,
                backfilledKeys: Object.keys(backfill),
                signal: clickEffectSignal,
              });
            }
          }

          // V23: finalize trace timing for the success path.
          setTraceTiming({ totalMs: Date.now() - traceTimingStart });
          // lint_resolve_post_verify: `verified === true` here means the
          // resolver-picked element was actually clicked AND
          // verifyClickHadEffect returned a positive signal. That's runtime
          // proof that whatever the compiled plan now describes (built from
          // the same node) does the right thing — beats build-time count()
          // which races navigation. Soft-pass path skips compile entirely
          // (`softPassedOnNoEffect` → no `compiled` write), so this branch
          // only runs on real success.
          if (verified) clearUnverifiedOnRuntimeMatch(compiled);
          const planQuality = derivePlanQuality(compiled);
          if (planQuality?.unverified) {
            logger.warn('[PREVIEW_APPLY] Plan flagged unverified', {
              previewSessionId,
              stepId: stepDraft.id,
              reason: planQuality.reason,
              path: 'lint_resolve_post_verify',
            });
            try {
              EditorTraceService.get(previewSessionId)?.writePlanQuality({
                stepId: stepDraft.id,
                unverified: true,
                reason: planQuality.reason,
                path: 'lint_resolve_post_verify',
              });
            } catch { /* trace is advisory */ }
          }
          return {
            success: true,
            appliedStep,
            urlChanged: result.urlChanged,
            url: page.url(),
            highlight: [{
              ref: candidate.ref,
              boundingBox: candidate.boundingBox,
              type: 'success',
            }],
            attempts,
            verified,
            // Surface the verify signal so preview_run trace can audit
            // whether passed clicks were backed by url/dialog/aria/etc
            // (strong) or only focus (weak — often fake-success when the
            // page is in a different state than recording).
            clickEffectSignal,
            chosenRef: candidate.ref,
            chosenLabel,
            chosenBoundingBox: candidate.boundingBox,
            fingerprintMatch,
            resolverPath: lintResult.resolverPath,
            stateChange,
            compiledFailed: compiledWasTried,
            decisionTrace,
            planQuality,
          };
        }

        // V15: action failed — emit result event before trying next candidate
        trace?.writeActionResult({
          stepId: stepDraft.id,
          stepType: stepDraft.type,
          success: false,
          durationMs: actionDur,
          error: result.error?.slice(0, 200),
        });
        lastError = result.error;
      }

      // All attempts failed
      setTraceTiming({ totalMs: Date.now() - traceTimingStart });

      // Etap 1D.2 — collect failure evidence bundle. Best-effort: any
      // throw from the collector is swallowed so the failure return
      // path never gets blocked by diagnostic code. The bundle is then
      // attached to the appliedStep so callers (WS handler, run loop)
      // can persist it to DB and emit `preview:step:needs-review`.
      let failureBundle;
      try {
        const { collectFailureEvidence } = await import('./failure-collector.service');
        const sess = sessionService.getSession(previewSessionId);
        const interactiveNodeCount = sess?.pageState?.domNodes?.length;
        // We don't have per-candidate failure tracking at the apply
        // loop level today — `lastError` is the single error string
        // accumulated across all candidates. Building synthetic attempt
        // records with `failureKind: 'fallthrough'` etc. would lie
        // about reality. Pass minimal entries — strategy + matched flag
        // — and let `lastError` + `totalAttempts` carry the real signal.
        // Per-candidate attempt detail is a follow-up that needs the
        // resolver loop to record per-attempt failures.
        const attemptRecords = resolvedCandidates.map((c) => ({
          strategy: 'lint_candidate',
          matched: !!c.ref,
          failureKind: 'unknown',
          value: c.ref ? `[data-agent-ref="${c.ref}"]` : undefined,
        }));
        failureBundle = await collectFailureEvidence({
          step: stepDraft,
          page,
          totalAttempts: attempts,
          originatingStrategy: 'resolver_exhausted',
          lastError,
          attempts: attemptRecords,
          interactiveNodeCount,
        });
      } catch (collectorErr) {
        logger.warn('[PREVIEW_APPLY] Failure collector threw — skipping bundle', {
          previewSessionId,
          stepId: stepDraft.id,
          error: collectorErr instanceof Error ? collectorErr.message : String(collectorErr),
        });
      }

      // Stamp the bundle onto the applied step so the WS handler can
      // persist it. Only attach when we have a bundle — happy path
      // (success) clears `failureEvidence` to undefined separately.
      const appliedStepWithFailure = failureBundle
        ? { ...stepDraft, failureEvidence: failureBundle }
        : undefined;

      return {
        success: false,
        error: lastError || 'All candidates failed',
        appliedStep: appliedStepWithFailure,
        highlight: resolvedCandidates.map(c => ({
          ref: c.ref,
          boundingBox: c.boundingBox,
          type: 'error' as const,
        })),
        attempts,
        decisionTrace,
      };
    } catch (error) {
      logger.error('[PREVIEW_APPLY] Apply failed', {
        error: error instanceof Error ? error.message : String(error),
        previewSessionId,
      });

      setTraceTiming({ totalMs: Date.now() - traceTimingStart });

      // Etap 1D.2 — also collect a bundle for thrown failures (page
      // crash, frame detached, navigation race, etc.). These are the
      // most diagnostically interesting failures — losing them would
      // defeat the whole point of the collector. Same best-effort
      // pattern as the structured-failure path above: any throw from
      // the collector itself is swallowed.
      //
      // We re-resolve `page` + `session` here because outer-catch is
      // outside the inner try where they're declared. The page may be
      // gone (closed/crashed — that's often what threw in the first
      // place); collector handles `page.url()` / `page.title()` throws
      // best-effort, so we don't need to pre-validate.
      let throwBundle;
      try {
        const { collectFailureEvidence } = await import('./failure-collector.service');
        const sess = getPreviewSessionService();
        const session = sess.getSession(previewSessionId);
        const page = sess.getPage(previewSessionId, userId);
        const interactiveNodeCount = session?.pageState?.domNodes?.length;
        if (page) {
          throwBundle = await collectFailureEvidence({
            step: stepDraft,
            page,
            totalAttempts: 0,
            originatingStrategy: 'apply_threw',
            lastError: error instanceof Error ? error.message : String(error),
            // No attempts log — exception was thrown before per-candidate
            // iteration could record one. Empty array is correct here:
            // it tells the UI "step crashed before we got to selectors".
            attempts: [],
            interactiveNodeCount,
          });
        }
      } catch (collectorErr) {
        logger.warn('[PREVIEW_APPLY] Failure collector threw on outer catch — skipping bundle', {
          previewSessionId,
          stepId: stepDraft.id,
          error: collectorErr instanceof Error ? collectorErr.message : String(collectorErr),
        });
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Apply failed',
        appliedStep: throwBundle ? { ...stepDraft, failureEvidence: throwBundle } : undefined,
        decisionTrace,
      };
    }
  }
}
