/**
 * Wait phases: dom-settle / loading-clear / animation-done
 *
 * Page-level settle phases that don't need a specific locator. All three
 * wrap existing helpers in step-readiness.service.ts — no new logic, just
 * adaptation to the SubPhase contract.
 */

import {
  getDomStableThresholdMs,
  hasLoadingIndicators,
  pageSettle,
  waitForElementAnimationComplete,
  waitForLoadingIndicatorsClear,
} from '../preview/step-readiness.service';
import type { PhaseResult, SmartWaitContext, SubPhase } from '../smart-step-wait.service';

// ─── dom-settle ───────────────────────────────────────────────────────────
//
// Wait for DOM mutations to settle into baseline rate. Uses pageSettle which
// races waitForDOMStable + a soft networkIdle, and picks the threshold based
// on the PREVIOUS action type (navigation = 500ms, input = 300ms, assertion
// = 150ms, default = 150ms).

const DOM_SETTLE_BUDGET_CAP_MS = 2_500;

export const domSettlePhase: SubPhase = {
  name: 'dom-settle',
  // No cheap fastCheck — pageSettle itself exits fast when DOM is already
  // quiet (its internal race resolves on first idle window). Running it as a
  // fastCheck would just duplicate the execute path.
  fastCheck: async () => false,
  execute: async (ctx: SmartWaitContext, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    // Budget = min(remaining, cap). The cap exists because long dom-settle
    // waits on a busy page are almost never productive — we'd rather hand
    // back to the caller and let a higher level decide.
    const settleMs = Math.min(remaining, DOM_SETTLE_BUDGET_CAP_MS);
    const threshold = getDomStableThresholdMs(ctx.prevStep?.type, undefined);
    try {
      await pageSettle(ctx.page, settleMs, threshold);
      return { name: 'dom-settle', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      return {
        name: 'dom-settle',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

// ─── loading-clear ────────────────────────────────────────────────────────
//
// Post-action: a click/type/navigate may trigger an in-page spinner,
// skeleton, or progress bar. hasLoadingIndicators() runs an 8-layer probe;
// if positive we block (up to LOADING_CAP_MS) for waitForLoadingIndicatorsClear.
//
// If the indicators never clear, we surface knownBlocker='loading' so the
// step-level retry layer can distinguish "still loading" from other failures.

const LOADING_CAP_MS = 3_000;

export const loadingClearPhase: SubPhase = {
  name: 'loading-clear',
  fastCheck: async (ctx) => !(await hasLoadingIndicators(ctx.page)),
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const budget = Math.min(remaining, LOADING_CAP_MS);
    try {
      await waitForLoadingIndicatorsClear(ctx.page, budget);
      // waitForLoadingIndicatorsClear resolves either way (timeout-safe).
      // Probe once more to classify the outcome — if indicators still show,
      // flag as a known blocker rather than claim success.
      const stillLoading = await hasLoadingIndicators(ctx.page);
      if (stillLoading) {
        return {
          name: 'loading-clear',
          ready: false,
          waitedMs: Date.now() - start,
          skipped: false,
          knownBlocker: 'loading',
        };
      }
      return { name: 'loading-clear', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      return {
        name: 'loading-clear',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

// ─── animation-done ───────────────────────────────────────────────────────
//
// Wait for CSS animations/transitions on the TARGET element to finish.
// Relies on waitForElementAnimationComplete which samples animation-name
// + animationPlayState until all stop running.
//
// Only meaningful when the step has a resolved locator — otherwise skipped
// via requiresLocator. Also no-ops quickly on pages that aren't animating.

const ANIMATION_CAP_MS = 1_500;

export const animationDonePhase: SubPhase = {
  name: 'animation-done',
  requiresLocator: true,
  fastCheck: async () => false, // the "done" probe is the execute path itself
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const budget = Math.min(remaining, ANIMATION_CAP_MS);
    try {
      await waitForElementAnimationComplete(ctx.locator!, budget);
      return {
        name: 'animation-done',
        ready: true,
        waitedMs: Date.now() - start,
        skipped: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Animation probe errors are usually "element detached mid-animation"
      // — which is exactly the retry signal we want.
      const isDetached = /detached|destroyed|closed/i.test(msg);
      return {
        name: 'animation-done',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        ...(isDetached ? { knownBlocker: 'detached' as const } : {}),
        evidence: { error: msg },
      };
    }
  },
};
