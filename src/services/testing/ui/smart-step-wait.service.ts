/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SMART STEP WAIT — unified per-action wait dispatcher for web steps
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Single entry point for all "wait around a step" logic used by:
 *   • preview-step-apply.service.ts     (editor Apply / Run)
 *   • command-executor.ts (src/agent)   (background / regression)
 *   • test-executor.ts                  (orchestration)
 *
 * Two phases:
 *   • 'pre'  — before action executes (element actionable, modal cleared, etc.)
 *   • 'post' — after action (only in standalone apply; in run-mode pre(N+1)
 *              subsumes post(N), so don't call post between steps).
 *
 * Each action type has its own wait plan (table at bottom). Every sub-phase
 * inside a plan first runs a cheap fastCheck (≤50ms). If it reports ready,
 * the full wait is skipped — that's the "skip directly to the step" the user
 * asked for.
 *
 * LLM diagnose fallback fires at most ONCE per session, and only when:
 *   • ctx.isStandalone === true (single-step Apply only; run-mode has its
 *     own attemptLLMDiagnosisAndRetry at a higher level)
 *   • no sub-phase already produced a known blocker reason
 *   • remaining budget ≥ DIAGNOSE_MIN_REMAINING_MS
 *
 * What this file DOES NOT do:
 *   • resolve the element (compiled/evidence/LLM waterfall stays in callers)
 *   • execute the Playwright action (stays in callers)
 *   • retry the whole step (stays in preview-run.service.ts)
 *
 * This file is ONLY about "wait for the right conditions before/after action".
 */

import type { Locator, Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import type { IntentActionType, IntentStep } from './preview/preview.types';
// Phase imports deferred to below WAIT_PLANS so the SubPhase interface is
// defined before phase files consume it via `type` import.

// ─── Public types ─────────────────────────────────────────────────────────

export type WaitPhase = 'pre' | 'post';

export interface SmartWaitContext {
  /** Page (or Frame) where the step executes. */
  page: Page;
  /** The step we're waiting around. */
  step: IntentStep;
  /** Resolved locator, if element was already found (optional in post-phase). */
  locator?: Locator;
  /** Phase we're in. */
  phase: WaitPhase;
  /** Previous step (for navigation detection, DOM-settle thresholds). */
  prevStep?: IntentStep;
  /** URL before the previous action (for SPA nav detection). */
  prevUrl?: string;
  /** Total time budget in ms. Defaults to SMART_WAIT_DEFAULT_BUDGET_MS. */
  timeoutBudget?: number;
  /** Caller-wide abort signal. */
  abortSignal?: AbortSignal;
  /**
   * True when this is a single-step Apply (no surrounding run loop).
   * Enables post-phase diagnostics and LLM fallback.
   */
  isStandalone?: boolean;
  /**
   * Session id — used for per-session LLM-diagnose rate limit and tracing.
   * When absent, LLM fallback is disabled.
   */
  sessionId?: string;
}

/**
 * Classified blocker reasons a sub-phase can report. Callers (and the
 * step-level retry layer) branch on these — so keep the set stable and
 * documented instead of free-form strings.
 *
 * - 'modal'     — a blocking modal/dialog intercepts the action
 * - 'overlay'   — a non-modal overlay (toast, tooltip, cookie banner) covers the target
 * - 'captcha'   — challenge page detected (Cloudflare/reCAPTCHA)
 * - 'loading'   — loading indicator still present
 * - 'auth'      — auth wall / login modal redirected the flow
 * - 'detached'  — target element was removed from the DOM mid-wait (React re-render)
 *                 → callers SHOULD retry the whole step (fresh locator resolve),
 *                   not treat as hard failure
 * - 'no_locator'— phase required a locator but ctx.locator was undefined (usage bug)
 * - 'navigation'— navigation happened while we were waiting for element-level state
 */
export type KnownBlocker =
  | 'modal'
  | 'overlay'
  | 'captcha'
  | 'loading'
  | 'auth'
  | 'detached'
  | 'no_locator'
  | 'navigation';

export interface PhaseResult {
  name: string;
  ready: boolean;
  waitedMs: number;
  /** true when the fastCheck made the full wait unnecessary. */
  skipped: boolean;
  /** Reason when the phase produced a classified blocker. */
  knownBlocker?: KnownBlocker;
  /** Free-form evidence for tracing. */
  evidence?: Record<string, unknown>;
}

export interface DiagnoseResult {
  /** High-level blocker class returned by the LLM. */
  blocker: 'modal' | 'overlay' | 'auth' | 'loading' | 'captcha' | 'unknown';
  /** What action the diagnoser suggests. */
  suggestedAction: 'dismiss' | 'wait' | 'click_through' | 'abort';
  /** Optional selector for the suggested action target. */
  selector?: string;
  /** Free-form human-readable explanation. */
  reason: string;
  confidence: number;
  latencyMs: number;
}

export interface SmartWaitResult {
  /** Overall outcome. */
  ready: boolean;
  /** Total ms spent inside smartStepWait. */
  waited: number;
  /** Per sub-phase result (in execution order). */
  phases: PhaseResult[];
  /** Phase names that were skipped due to fast-path. */
  skippedPhases: string[];
  /** When ready === false, why. */
  degradedReason?:
    | 'timeout_budget'
    | 'aborted'
    | 'known_blocker'     // at least one sub-phase surfaced a classified blocker
    | 'unknown_blocker'   // unresolved and diagnose could not explain
    | 'diagnose_no_op';   // diagnose was attempted but returned no useful suggestion
  /** Populated only when the LLM fallback actually ran. */
  diagnosis?: DiagnoseResult;
}

// ─── Config ───────────────────────────────────────────────────────────────

const SMART_WAIT_DEFAULT_BUDGET_MS = 10_000;
const DIAGNOSE_MIN_REMAINING_MS = 3_000;
const FAST_CHECK_HARD_CAP_MS = 200;

// Per-session LLM diagnose rate limit — at most ONE call per sessionId per run.
// We use a timestamped Map so stale entries self-evict after SESSION_TTL_MS;
// otherwise long-lived processes would leak one entry per ever-seen session.
// Callers should ALSO call resetSmartWaitDiagnoseBudget on run start — TTL is
// a safety net, not the primary cleanup path.
const diagnoseFiredForSession = new Map<string, number>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1h — well beyond any realistic run

function pruneSessionMap(now: number): void {
  // Cheap opportunistic GC — only touches entries, O(n) on whatever it finds.
  // Called before each insert, so the map stays bounded by active-session count.
  if (diagnoseFiredForSession.size < 64) return;
  for (const [sid, ts] of diagnoseFiredForSession) {
    if (now - ts > SESSION_TTL_MS) diagnoseFiredForSession.delete(sid);
  }
}

/**
 * Reset the LLM-diagnose rate limit for a session. Callers should invoke this
 * at the start of a new run so the single-shot budget refreshes.
 */
export function resetSmartWaitDiagnoseBudget(sessionId: string): void {
  diagnoseFiredForSession.delete(sessionId);
}

// ─── Sub-phase contract ───────────────────────────────────────────────────

export interface SubPhase {
  name: string;
  /**
   * True when this phase needs a resolved locator (e.g. visibility check,
   * value reflection). When ctx.locator is missing and requiresLocator is
   * true, the phase is skipped with knownBlocker='no_locator'. This avoids
   * the "silent misuse" trap where post-phase is called with no locator and
   * phases rely on it implicitly.
   */
  requiresLocator?: boolean;
  /**
   * Cheap readiness probe (≤ FAST_CHECK_HARD_CAP_MS). Returns true to SKIP
   * the full wait. Never throws — any error → return false (fail-open).
   */
  fastCheck: (ctx: SmartWaitContext) => Promise<boolean>;
  /**
   * Full wait. Phases MUST honour ctx.abortSignal themselves during long
   * operations — the dispatcher only checks between phases. Returns a
   * PhaseResult. Never throws — timeouts come back as ready:false.
   *
   * Phase-author contract (READ BEFORE ADDING A PHASE):
   *
   *   1. Playwright auto-waits for attached+visible+stable+receives-events+
   *      enabled on click/check/tap/dblclick/setChecked/uncheck/fill/select.
   *      Don't re-implement those checks in a phase — trust the action call.
   *
   *   2. Playwright does NOT auto-wait on:
   *        • press / pressSequentially
   *        • dispatchEvent / focus / blur
   *        • setInputFiles
   *      If a phase prepares the ground for one of these, the phase itself
   *      MUST verify visibility + enabled (Locator.isVisible/isEnabled, or
   *      `locator.click({ trial: true, timeout: 50 })` as a 1-call probe).
   *
   *   3. Detached element mid-wait: catch the error, return
   *      { ready: false, knownBlocker: 'detached' }. The step-level retry
   *      layer will re-resolve the locator. Don't translate detachment to
   *      a hard throw — it's the single most common non-bug flake.
   *
   *   4. Use Playwright's `trial: true` flag for click/tap/check/fill when
   *      probing actionability — it runs the full actionability sequence
   *      without executing the action, and returns in one call.
   */
  execute: (ctx: SmartWaitContext, remainingBudgetMs: number) => Promise<PhaseResult>;
}

// Real phase implementations are defined in wait-phases/*.ts and imported
// below. They all honour the SubPhase contract (fastCheck ≤200ms, execute
// never throws, returns PhaseResult).
import { hoverEffectSettlePhase } from './wait-phases/hover-effect-settle';
import {
  actionablePhase,
  attachedPhase,
  editablePhase,
  focusedPhase,
  visiblePhase,
} from './wait-phases/element-state';
import {
  animationDonePhase,
  domSettlePhase,
  loadingClearPhase,
} from './wait-phases/dom-settle';
import {
  challengeClearPhase,
  iframeReadyPhase,
  modalClearPhase,
} from './wait-phases/overlay-modal';
import {
  apiIdlePhase,
  loadStatePhase,
  spaNavDetectPhase,
} from './wait-phases/navigation';
import {
  optionReflectedPhase,
  postConditionMetPhase,
  stateReflectedPhase,
  valueReflectedPhase,
} from './wait-phases/post-action-verify';
import {
  conditionMetPhase,
  dropdownReadyPhase,
  fileSetPhase,
  lazyLoadIdlePhase,
} from './wait-phases/action-specific';

// ─── Wait plans per action × phase ────────────────────────────────────────
//
// Each action type has a PRE plan and a POST plan. Missing entries mean "no
// wait needed for this phase".
//
// PRE plans: element/page must be ready to RECEIVE the action.
// POST plans: effects of the action must have SETTLED before we return.
//
// Universal between-step readiness (challenge detection, SPA nav, API idle,
// loading indicators, DOM settle) is NOT repeated here — callers keep using
// waitForStepReadiness() between steps. smartStepWait is strictly scoped to
// the boundary around a single action.

interface WaitPlan {
  pre: SubPhase[];
  post: SubPhase[];
}

const EMPTY_PLAN: WaitPlan = { pre: [], post: [] };

// Phase naming convention and sourcing (for phase-authors building real
// implementations in wait-phases/*.ts):
//
//   actionable         ← withHardCap(isEnabledOrInert) + waitForElementEnabled
//                        (step-readiness.service.ts)
//   modal-clear        ← isElementObstructed + waitForOverlayClear + session-
//                        level modal verification (preview-step-apply.ts)
//   dom-settle         ← waitForDOMStable + pageSettle + blindSettle
//                        (step-readiness.service.ts)
//   loading-clear      ← hasLoadingIndicators + waitForLoadingIndicatorsClear
//                        (step-readiness.service.ts)
//   animation-done     ← isAnimationRunning (step-readiness.service.ts)
//   iframe-ready       ← waitForIframeContentReady (step-readiness.service.ts)
//                        Conditional: only when step.iframeConfig present.
//   challenge-clear    ← detectChallengePage (step-readiness.service.ts).
//                        Conditional: tagged knownBlocker='captcha' when present.
//   spa-nav-detect     ← detectSpaNavigation (step-readiness.service.ts)
//   api-idle           ← waitForApiIdle (step-readiness.service.ts)
//   load-state         ← page.waitForLoadState('domcontentloaded', {timeout})
//   hover-effect-settle← waitForHoverEffect (preview-step-apply.ts;
//                        DEDUPE: command-executor.ts has a twin — extract once)
//   value-reflected    ← locator.inputValue() polling
//   state-reflected    ← aria-checked/pressed/expanded polling
//   visible/editable/attached/focused ← withHardCap(locator.is*)
//   post-condition-met ← compiled.postconditions check (Playwright
//                        best-practice: verify observable state change
//                        rather than just DOM stability)
//
// Conditional phases (iframe-ready, challenge-clear) remain in every plan
// where they could apply — the phase's own fastCheck returns true when the
// condition doesn't apply, so they're free when irrelevant.

const WAIT_PLANS: Partial<Record<IntentActionType, WaitPlan>> = {
  click: {
    pre: [actionablePhase, modalClearPhase, iframeReadyPhase],
    post: [domSettlePhase, spaNavDetectPhase, loadingClearPhase, postConditionMetPhase, challengeClearPhase],
  },
  dblclick: {
    pre: [actionablePhase, modalClearPhase, iframeReadyPhase],
    post: [domSettlePhase, loadingClearPhase, postConditionMetPhase],
  },
  contextmenu: {
    pre: [actionablePhase, modalClearPhase, iframeReadyPhase],
    post: [domSettlePhase, loadingClearPhase],
  },
  type: {
    pre: [editablePhase, iframeReadyPhase],
    post: [valueReflectedPhase, domSettlePhase, loadingClearPhase],
  },
  press: {
    // 'press' has NO Playwright auto-actionability — phase must verify visibility.
    pre: [visiblePhase, focusedPhase],
    post: [domSettlePhase, spaNavDetectPhase, loadingClearPhase],
  },
  hover: {
    pre: [visiblePhase, iframeReadyPhase],
    post: [hoverEffectSettlePhase, animationDonePhase],
  },
  scroll: {
    pre: [],
    post: [lazyLoadIdlePhase, domSettlePhase],
  },
  select: {
    pre: [visiblePhase, dropdownReadyPhase],
    post: [optionReflectedPhase, domSettlePhase, loadingClearPhase, animationDonePhase],
  },
  check: {
    pre: [actionablePhase],
    post: [stateReflectedPhase, domSettlePhase, animationDonePhase],
  },
  uncheck: {
    pre: [actionablePhase],
    post: [stateReflectedPhase, domSettlePhase, animationDonePhase],
  },
  toggle: {
    pre: [actionablePhase],
    post: [stateReflectedPhase, domSettlePhase, animationDonePhase],
  },
  open: {
    pre: [actionablePhase],
    post: [stateReflectedPhase, domSettlePhase, animationDonePhase],
  },
  close: {
    pre: [actionablePhase],
    post: [stateReflectedPhase, domSettlePhase, animationDonePhase],
  },
  navigate: {
    pre: [],
    post: [loadStatePhase, apiIdlePhase, domSettlePhase, loadingClearPhase, challengeClearPhase],
  },
  upload: {
    // 'upload' uses setInputFiles — NO Playwright auto-actionability, and the
    // input is typically display:none, so only 'attached' is meaningful.
    pre: [attachedPhase],
    post: [fileSetPhase, domSettlePhase],
  },
  drag_and_drop: {
    pre: [visiblePhase],
    post: [domSettlePhase, spaNavDetectPhase, loadingClearPhase, animationDonePhase],
  },
  // 'wait' action is a fixed timer and owns its own wait — no surrounding
  // pre/post phases. Omitted from WAIT_PLANS so getPlan() returns EMPTY_PLAN.
  wait_for: {
    pre: [],
    post: [conditionMetPhase],
  },
  ai_check: {
    pre: [],
    post: [domSettlePhase],
  },
  assert: {
    pre: [],
    post: [domSettlePhase],
  },
};

function getPlan(actionType: IntentActionType): WaitPlan {
  return WAIT_PLANS[actionType] ?? EMPTY_PLAN;
}

// ─── Dispatcher ───────────────────────────────────────────────────────────

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

async function runFastCheckCapped(
  phase: SubPhase,
  ctx: SmartWaitContext,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), FAST_CHECK_HARD_CAP_MS);
    });
    const result = await Promise.race<boolean>([phase.fastCheck(ctx), timeoutPromise]);
    return result === true;
  } catch {
    return false;
  } finally {
    // Clear the timer so it doesn't linger for FAST_CHECK_HARD_CAP_MS after the
    // fastCheck already resolved — at high call rates this would queue up
    // hundreds of idle timers in the event loop.
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build a final SmartWaitResult. Single exit point so we never forget to
 * compute waited/degradedReason consistently across the 4-5 early-returns
 * the dispatcher used to have.
 */
function finalize(
  startMs: number,
  phases: PhaseResult[],
  skippedPhases: string[],
  opts: {
    forceDegraded?: SmartWaitResult['degradedReason'];
    diagnosis?: DiagnoseResult;
  } = {},
): SmartWaitResult {
  const waited = Date.now() - startMs;
  if (opts.forceDegraded) {
    return {
      ready: false,
      waited,
      phases,
      skippedPhases,
      degradedReason: opts.forceDegraded,
      ...(opts.diagnosis ? { diagnosis: opts.diagnosis } : {}),
    };
  }
  const everyReady = phases.every((p) => p.ready);
  if (everyReady) {
    return { ready: true, waited, phases, skippedPhases };
  }
  const hasKnownBlocker = phases.some((p) => !p.ready && !!p.knownBlocker);
  return {
    ready: false,
    waited,
    phases,
    skippedPhases,
    degradedReason: hasKnownBlocker ? 'known_blocker' : 'unknown_blocker',
  };
}

/**
 * Single entry point. See file header for semantics.
 */
export async function smartStepWait(ctx: SmartWaitContext): Promise<SmartWaitResult> {
  const startMs = Date.now();
  // `timeout: 0` in Playwright means "no timeout" — a footgun when reading
  // user configs. Treat 0 or negative as "use default", not "wait forever".
  const rawBudget = ctx.timeoutBudget;
  const totalBudget = typeof rawBudget === 'number' && rawBudget > 0
    ? rawBudget
    : SMART_WAIT_DEFAULT_BUDGET_MS;
  const phases: PhaseResult[] = [];
  const skippedPhases: string[] = [];

  const plan = getPlan(ctx.step.type);
  const subPhases = ctx.phase === 'pre' ? plan.pre : plan.post;

  for (const sub of subPhases) {
    if (isAborted(ctx.abortSignal)) {
      return finalize(startMs, phases, skippedPhases, { forceDegraded: 'aborted' });
    }

    const remaining = totalBudget - (Date.now() - startMs);
    if (remaining <= 0) {
      return finalize(startMs, phases, skippedPhases, { forceDegraded: 'timeout_budget' });
    }

    // Phases that declare requiresLocator get skipped gracefully when no
    // locator is available — surfaced as a knownBlocker so callers (and the
    // trace) see exactly why the phase didn't actually run.
    if (sub.requiresLocator && !ctx.locator) {
      phases.push({
        name: sub.name,
        ready: false,
        waitedMs: 0,
        skipped: false,
        knownBlocker: 'no_locator',
      });
      continue;
    }

    const fast = await runFastCheckCapped(sub, ctx);
    if (fast) {
      skippedPhases.push(sub.name);
      phases.push({ name: sub.name, ready: true, waitedMs: 0, skipped: true });
      continue;
    }

    let result: PhaseResult;
    try {
      result = await sub.execute(ctx, remaining);
    } catch (err) {
      // Contract says phases never throw — but belt-and-suspenders: convert
      // any escape to a non-ready PhaseResult so the loop can continue.
      result = {
        name: sub.name,
        ready: false,
        waitedMs: Date.now() - startMs,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
    phases.push(result);
    // Intentionally DON'T bail on a single non-ready phase — subsequent phases
    // may still surface a knownBlocker the diagnose step can act on.
  }

  if (isAborted(ctx.abortSignal)) {
    return finalize(startMs, phases, skippedPhases, { forceDegraded: 'aborted' });
  }

  const everyPhaseReady = phases.every((p) => p.ready);
  if (everyPhaseReady) {
    return finalize(startMs, phases, skippedPhases);
  }

  const hasKnownBlocker = phases.some((p) => !p.ready && !!p.knownBlocker);
  const remainingAfterPhases = totalBudget - (Date.now() - startMs);

  const sid = ctx.sessionId;
  const shouldDiagnose =
    !hasKnownBlocker &&
    ctx.isStandalone === true &&
    ctx.phase === 'pre' &&
    sid !== undefined &&
    !diagnoseFiredForSession.has(sid) &&
    remainingAfterPhases >= DIAGNOSE_MIN_REMAINING_MS;

  if (shouldDiagnose && sid !== undefined) {
    pruneSessionMap(Date.now());
    diagnoseFiredForSession.set(sid, Date.now());
    const diagnosis = await runDiagnose(ctx).catch((err) => {
      logger.warn('[SMART_WAIT] Diagnose threw', {
        sessionId: sid,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    });
    return finalize(startMs, phases, skippedPhases, {
      forceDegraded: diagnosis ? 'unknown_blocker' : 'diagnose_no_op',
      diagnosis,
    });
  }

  return finalize(startMs, phases, skippedPhases);
}

// ─── LLM diagnose stub ────────────────────────────────────────────────────
//
// Wires to the existing diagnoseStepBlocker() inside preview-run.service.ts
// (or a shared extraction). Kept as a thin stub here so smart-step-wait
// compiles in isolation; full integration happens in the next step where
// we migrate call-sites.

async function runDiagnose(ctx: SmartWaitContext): Promise<DiagnoseResult | undefined> {
  // Intentional no-op until we wire it. Logged so stray calls are visible.
  logger.debug('[SMART_WAIT] Diagnose fallback requested (not yet wired)', {
    sessionId: ctx.sessionId,
    stepType: ctx.step.type,
  });
  return undefined;
}
