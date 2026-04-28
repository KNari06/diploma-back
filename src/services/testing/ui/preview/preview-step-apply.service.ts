/**
 * Preview Step Apply Service V2
 * Executes a single step in the preview session
 * Features: ownership enforcement, post-action verification, state-aware retries
 */

import { logger } from '@/utils/core/logger';
import { sanitizeUrl } from '@/utils/validation/validation';
import { webSocketService } from '@/websocket/core/websocket.service';
import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import { sanitizeIntent } from './element-resolver.service';
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
    UrlMatcher,
} from './preview.types';

import { STEP_APPLY_CONFIG, STEP_READINESS_CONFIG, COMMAND_EXECUTOR_CONFIG } from '@/config/testing/playwright-tuning';
import { executeCoordinateDrag, parseDragCoordinates } from '@/agent/playwright/core/drag-helpers';
import { normalizeUrlForComparison } from './auto-wait-for.utils';
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
const ACTION_TIMEOUT = STEP_APPLY_CONFIG.actionTimeoutMs;
const POST_ACTION_SETTLE_TIMEOUT = STEP_APPLY_CONFIG.postActionSettleTimeoutMs;

// V2: Action types that support state verification
const STATE_VERIFIABLE_ACTIONS = new Set(['check', 'uncheck', 'toggle', 'open', 'close', 'type', 'click', 'upload']);

// V11: Actions that don't target elements — skip modal check
const NON_TARGETING_ACTIONS = new Set(['navigate', 'wait', 'scroll', 'wait_for', 'ai_check', 'wait_for_email', 'dialog', 'download']);

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
      const SETTLE_MAX_MS = isAutoInjected ? 3000 : 1500;
      const urlWaitBudget = isAutoInjected
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
          const exitFn = isAutoInjected ? logger.info : logger.error;
          exitFn('[WAIT_FOR_URL] wait_for resolved via page-settle fallback (URL unchanged but page quiet)', {
            prevUrl,
            currentUrl: page.url(),
            isAutoInjected,
            hint: isAutoInjected
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
  clickEffectSignal?: 'url' | 'dialog' | 'aria' | 'focus' | 'detach' | 'dom' | 'newtab' | 'none';
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
  targetDisabled: boolean;
  pageCount: number; // browser-context tab count for new-tab detection
};

type ClickEffectSignal = 'url' | 'dialog' | 'aria' | 'focus' | 'detach' | 'dom' | 'newtab' | 'none';

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
  const fallback: ClickPreState = {
    url: page.url(),
    dialogCount: 0,
    bodyVisibleChildSig: '',
    activeElementSig: null,
    targetAriaPressed: null,
    targetAriaExpanded: null,
    targetAriaChecked: null,
    targetDisabled: false,
    pageCount,
  };
  try {
    const safeRef = ref ? ref.replace(/[^a-zA-Z0-9_-]/g, '') : '';
    // Page-level signals (URL, dialogs at top level) — always main frame.
    let pageSig: { url: string; dialogCount: number; bodyVisibleChildSig: string };
    try {
      pageSig = await page.evaluate(() => {
        // @ts-expect-error - browser context
        const doc = document;
        const dialogs = doc.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]');
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
        };
      });
    } catch {
      pageSig = { url: page.url(), dialogCount: 0, bodyVisibleChildSig: '' };
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
      return {
        activeElementSig: aeSig,
        targetAriaPressed: targetEl ? targetEl.getAttribute('aria-pressed') : null,
        targetAriaExpanded: targetEl ? targetEl.getAttribute('aria-expanded') : null,
        targetAriaChecked: targetEl ? targetEl.getAttribute('aria-checked') : null,
        targetDisabled: targetEl
          ? (targetEl.hasAttribute('disabled') || targetEl.getAttribute('aria-disabled') === 'true')
          : false,
      };
    }, { refSel: safeRef });
    return { ...pageSig, ...elemSig, pageCount };
  } catch {
    return fallback;
  }
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
  for (const delay of checkpoints) {
    if (delay > 0) await page.waitForTimeout(delay).catch(() => {});

    // Browser-context check: new tab opened? Cheap, runs against the
    // BrowserContext (no page.evaluate round-trip needed) so it survives
    // the case where evaluate would throw because the active page is
    // mid-navigating.
    try {
      const nowPageCount = page.context().pages().length;
      if (nowPageCount > pre.pageCount) return { effected: true, signal: 'newtab' };
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
      // Page navigating mid-eval — that itself is an effect.
      return { effected: true, signal: 'url' };
    }
    if (pageResult.signal !== 'none') return { effected: true, signal: pageResult.signal };

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
          const nowDisabled = targetEl.hasAttribute('disabled') || targetEl.getAttribute('aria-disabled') === 'true';
          if (nowDisabled !== prev.targetDisabled) return { signal: 'aria' as const };
        }
        const ae = doc.activeElement as any;
        const aeSig = ae ? `${ae.tagName}#${ae.id || ''}.${(ae.getAttribute('class') || '').slice(0, 30)}` : null;
        if (aeSig !== prev.activeElementSig) return { signal: 'focus' as const };
        return { signal: 'none' as const };
      }, { refSel: safeRef, prev: pre });
    } catch {
      // Frame detached / navigating — count as effect.
      return { effected: true, signal: 'detach' };
    }
    if (elemResult.signal !== 'none') return { effected: true, signal: elemResult.signal };
  }
  return { effected: false, signal: 'none' };
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
  options?: { expectsNavigation?: boolean }
): Promise<{ success: boolean; error?: string; urlChanged: boolean }> {
  const urlBefore = page.url();

  try {
    // Build selector (unless we have a pre-resolved locator from compiled plan)
    const selector = preResolvedLocator ? '' : buildSelector(step, candidate);

    if (!selector && !preResolvedLocator && !['navigate', 'wait', 'scroll', 'press'].includes(step.type)) {
      return { success: false, error: 'No valid selector for element', urlChanged: false };
    }

    // Get context (page or iframe)
    const context = getLocatorContext(page, step);
    const timeout = step.options?.timeout || ACTION_TIMEOUT;

    // V7: Use pre-resolved locator if provided, otherwise build from selector
    const locator = preResolvedLocator || (selector ? (context as Page | FrameLocator).locator(selector) : undefined);

    // Scroll element into viewport before action (fullPage snapshots can resolve off-screen elements)
    // Skip for non-targeting actions that don't need a visible element
    if (locator && !['navigate', 'wait', 'wait_for', 'scroll'].includes(step.type)) {
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
          if (step.options?.replaceContent !== false) {
            await locator.fill('', { timeout });
          }

          // Delay between keystrokes:
          // - If explicitly set, respect it
          // - Else choose a realistic random delay in [50..150] ms
          const delay = Number.isFinite(step.options?.keyPressDelay)
            ? Math.max(0, step.options!.keyPressDelay!)
            : randomIntInclusive(50, 150);

          await locator.pressSequentially(value, { timeout, delay });

          // Sometimes pause after typing (e.g., user thinking / UI debounce)
          await maybeRandomPause(page, 0.35, 80, 220);
        } else if (step.options?.replaceContent === false) {
          // Legacy behavior: append typing (uses keyPressDelay if provided)
          await locator.click({ timeout });
          await locator.pressSequentially(value, { timeout, delay: step.options?.keyPressDelay });
        } else if (value.length <= 50) {
          // Short text (credentials, emails, OTP, validation data): use pressSequentially
          // for full keyboard event chain — frameworks that rely on keydown/keyup won't miss input.
          // Cost: ~20ms × N chars = max 1s for 50 chars — acceptable for reliability.
          await locator.fill('', { timeout }).catch(() => {}); // Clear existing content first
          await locator.click({ timeout });
          await locator.pressSequentially(value, { timeout, delay: 20 });
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
            if (value && postBlurValue.trim() !== value.trim()) {
              logger.info('[EXECUTE_ACTION] fill() value lost after blur — retrying with pressSequentially', {
                expected: value.slice(0, 50),
                actual: postBlurValue.slice(0, 50),
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
        if (options?.expectsNavigation) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: COMMAND_EXECUTOR_CONFIG.clickNavigationTimeoutMs }).catch(() => {}),
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
    logger.warn('[PREVIEW_APPLY] Action execution failed', {
      stepType: step.type,
      candidateRef: candidate.ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Action failed',
      urlChanged: page.url() !== urlBefore,
    };
  }
}

/**
 * Preview Step Apply Service
 */
export class PreviewStepApplyService {
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

    // ── Scratchpad: interpolate {{key}} context variable placeholders ──
    // Resolves cross-step data (OTP codes, stored values, extracted text) before
    // locator resolution. Same mechanism as preview-run.service.ts but for
    // single-step applies (editor "Apply" button).
    try {
      const sessionService = getPreviewSessionService();
      const session = sessionService.getSession(previewSessionId);
      const contextData = session?.contextData;
      if (contextData && Object.keys(contextData).length > 0) {
        const resolve = (s: string): string => {
          if (!s.includes('{{')) return s;
          return s.replace(/\{\{([\w.-]+)\}\}/g, (match, key) => {
            const replacement = contextData[key];
            return typeof replacement === 'string' ? replacement : match;
          });
        };
        const resolved = { ...stepDraft };
        if (resolved.value) resolved.value = resolve(resolved.value);
        if (resolved.assertionText) resolved.assertionText = resolve(resolved.assertionText);
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

      // Handle non-targeting actions (navigate, wait, scroll)
      // Scroll is page-level: uses step.value (deltaY) without targeting a DOM element
      if (['navigate', 'wait', 'scroll'].includes(stepDraft.type)) {
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
          result = await executeAction(page, stepDraft, { label: '', reason: '', confidence: 1 });
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

        return {
          success: result.success,
          error: result.error,
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
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'wait_for failed',
            urlChanged: urlBefore !== page.url(),
            url: page.url(),
            attempts: 1,
          };
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
        
        const result = await executeAction(page, stepDraft, confirmedCandidate, undefined, { expectsNavigation });

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
              compiled = LocatorPlanBuilder.buildCompiledPlan({
                step: stepDraft,
                resolvedNode,
                pageUrl: urlBeforeAction,
                pageTitle: await page.title().catch(() => undefined),
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

      if (
        stepDraft.compiled && stepDraft.compiled.locatorPlan && stepDraft.compiled.locatorPlan.length > 0
        && !params.skipCompiled
        && !compiledUrlStale
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
            const result = await executeAction(page, stepDraft, compiledCandidate, compiledResult.locator, { expectsNavigation });

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
              let urlActuallyChanged = result.urlChanged;
              if (expectedNav && !urlActuallyChanged) {
                await page.waitForTimeout(300).catch(() => {});
                const urlNow = page.url();
                urlActuallyChanged = normalizeUrlForComparison(urlNow) !== normalizeUrlForComparison(currentPageUrl);
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
                if (
                  stepDraft.type === 'click'
                  && !expectedNav
                  && compiledClickPreState
                ) {
                  const effect = await verifyClickHadEffect(page, compiledClickPreState, compiledRef, compiledTargetFrame);
                  if (!effect.effected) {
                    logger.info('[PREVIEW_APPLY] Compiled click had no observable effect', {
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
                    return {
                      success: false,
                      error: '[click-no-effect] Click did not change page state (URL, dialog, ARIA, focus). The element may be obstructed by an overlay, or the click handler did nothing.',
                      attempts: 1,
                      // compiledFailed stays falsy — the locator was correct,
                      // the page just didn't react. Don't disable compiled
                      // shortcut for remaining steps.
                    };
                  }
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
                if (compiledRef) {
                  try {
                    const sess = sessionService.getSession(previewSessionId);
                    const liveNode = sess?.pageState?.domNodes?.find(n => n.ref === compiledRef);
                    if (liveNode) {
                      const candidatePlan = LocatorPlanBuilder.buildCompiledPlan({
                        step: stepDraft,
                        resolvedNode: liveNode,
                        pageUrl: page.url(),
                        pageTitle: await page.title().catch(() => undefined),
                        pageSignature: sess?.lastPageSignature,
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
                }

                // Update step with success evidence
                const updatedStep: IntentStep = {
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

                return {
                  success: true,
                  appliedStep: updatedStep,
                  urlChanged: result.urlChanged,
                  url: page.url(),
                  attempts: 1,
                };
              }
            }
          }

          // Compiled failed or element not found - fallthrough to lint
          compiledWasTried = true;
          logger.debug('[PREVIEW_APPLY] Compiled locator failed, falling back to lint', {
            previewSessionId,
            stepId: stepDraft.id,
            reason: compiledResult.skipReason,
          });
        } catch (compiledError) {
          // Compiled execution threw - fallthrough to lint
          compiledWasTried = true;
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
      });
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
        return {
          success: false,
          error: lintResult.message || 'Please clarify which element to use',
          highlight: lintResult.highlight,
          attempts: 0,
        };
      }

      if (lintResult.status === 'error') {
        return {
          success: false,
          error: lintResult.message || 'Linting failed',
          highlight: [],
          attempts: 0,
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
          return {
            success: false,
            error: 'A popup/modal is currently open and may be blocking the target element. Dismiss it or interact with it first.',
            highlight: modalInfo.boundingBox ? [{
              boundingBox: modalInfo.boundingBox,
              type: 'warning' as const,
            }] : [],
            modalBlocking: modalInfo,
          };
        }

        return {
          success: false,
          error: lintResult.message || 'No matching elements found',
          highlight: [],
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

        try {
          EditorTraceService.get(previewSessionId)?.writeApplyPhaseEntry({
            stepId: stepDraft.id, phase: 'action_execute',
          });
        } catch { /* non-fatal */ }
        let playwrightThrew = false;
        const result = await executeAction(page, stepDraft, candidate, undefined, { expectsNavigation });
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
          if (candidate.node) {
            try {
              // Get pageSignature from session if available
              const session = sessionService.getSession(previewSessionId);
              pageSignature = session?.lastPageSignature;

              compiled = LocatorPlanBuilder.buildCompiledPlan({
                step: stepDraft,
                resolvedNode: candidate.node,
                pageUrl: urlBeforeAction,
                pageTitle: await page.title().catch(() => undefined),
                pageSignature,
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

          // V2: Auto-populate bindingHints from resolved node
          const enrichedBindingHints = candidate.node
            ? { ...stepDraft.bindingHints, ...buildBindingHintsFromNode(candidate.node) }
            : stepDraft.bindingHints;

          // Update step evidence with resolutionMeta and enriched bindingHints
          const updatedStep: IntentStep = {
            ...stepDraft,
            bindingHints: enrichedBindingHints,
            evidence: {
              ...stepDraft.evidence,
              lastSuccessRef: candidate.ref,
              confidence: candidate.confidence,
              resolutionMeta,
              capturedAt: new Date().toISOString(), // V15.6: staleness guard
            },
            compiled, // NEW: compiled execution plan
          };

          // Audit: which element did the resolver actually click? Compare
          // against the recorded fingerprint so a 'pass' on the wrong target
          // (fake-success) becomes diagnosable from logs alone.
          let chosenLabel: string | undefined;
          let chosenTagLive: string | undefined;
          let chosenIdLive: string | null | undefined;
          try {
            if (candidate.node) {
              chosenLabel = candidate.node.labelText
                || candidate.node.ariaLabel
                || candidate.node.text
                || candidate.node.placeholder
                || `<${candidate.node.tag}>`;
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
          const hasGroundTruth =
            stepDraft.type === 'click' &&
            !!stepDraft.recordedFingerprint &&
            (!!stepDraft.recordedFingerprint.elementId ||
             !!stepDraft.recordedFingerprint.testIdAttr ||
             !!stepDraft.recordedFingerprint.name);
          // 'newtab' is treated as weak under mismatch — opening an unrelated
          // tab is the canonical fake-success symptom (recorder captured a
          // settings cog with id="layout-header-setting", LLM clicked a
          // neighbouring "click me!" banner, popup→yuque.com docs, verifier
          // saw newtab and stamped pass). Real navigations land on the same
          // page (url change without popup), which is signal 'url'.
          const weakSignal = clickEffectSignal === 'focus' || clickEffectSignal === 'none' || clickEffectSignal === 'newtab' || clickEffectSignal === undefined;
          if (hasGroundTruth && fingerprintMatch === 'mismatch' && weakSignal) {
            logger.warn('[PREVIEW_APPLY] Rejecting fake-success: fingerprint mismatch with weak click signal', {
              stepId: stepDraft.id,
              candidateRef: candidate.ref,
              chosenLabel,
              chosenIdLive,
              recordedId: stepDraft.recordedFingerprint?.elementId,
              recordedTestId: stepDraft.recordedFingerprint?.testIdAttr,
              clickEffectSignal,
            });
            trace?.writeActionResult({
              stepId: stepDraft.id,
              stepType: stepDraft.type,
              success: false,
              durationMs: actionDur,
              error: 'fingerprint-mismatch-weak-signal',
            });
            return {
              success: false,
              error: `[wrong-element] Resolver clicked "${chosenLabel || candidate.ref}" but the recorded target had id="${stepDraft.recordedFingerprint?.elementId || stepDraft.recordedFingerprint?.testIdAttr}". The click only triggered a ${clickEffectSignal || 'no'} change, not a real navigation/dialog/state update — almost certainly a fake-success. Refine the step description or check that the recorded id still exists on the page.`,
              attempts,
              highlight: [{
                ref: candidate.ref,
                boundingBox: candidate.boundingBox,
                type: 'error' as const,
              }],
              clickEffectSignal,
              chosenRef: candidate.ref,
              chosenLabel,
              chosenBoundingBox: candidate.boundingBox,
              fingerprintMatch,
              resolverPath: lintResult.resolverPath,
            };
          }
          return {
            success: true,
            appliedStep: updatedStep,
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
      return {
        success: false,
        error: lastError || 'All candidates failed',
        highlight: resolvedCandidates.map(c => ({
          ref: c.ref,
          boundingBox: c.boundingBox,
          type: 'error' as const,
        })),
        attempts,
      };
    } catch (error) {
      logger.error('[PREVIEW_APPLY] Apply failed', {
        error: error instanceof Error ? error.message : String(error),
        previewSessionId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Apply failed',
      };
    }
  }
}
