/**
 * Wait phases: modal-clear / challenge-clear / iframe-ready
 *
 * Environmental blockers that aren't about the target element itself but
 * about page-level obstructions (overlays covering the target, challenge
 * pages intercepting interaction, iframes that haven't finished loading).
 *
 * All three surface classified knownBlockers so the caller (step-level retry
 * or LLM-diagnose fallback) can branch on the reason instead of re-probing.
 */

import {
  detectChallengePage,
  isElementObstructed,
  waitForIframeContentReady,
  waitForOverlayClear,
} from '../preview/step-readiness.service';
import type { PhaseResult, SubPhase } from '../smart-step-wait.service';

// ─── modal-clear ──────────────────────────────────────────────────────────
//
// Pre-phase for actions that target a specific element. Checks whether the
// target is covered by an overlay (modal, toast, cookie banner, etc.) via
// elementFromPoint hit-testing at the target's center + 4 inset points.
//
// If obstructed, polls waitForOverlayClear (200ms intervals) until the
// overlay goes away or budget runs out. Surfaces knownBlocker='modal' on
// timeout so the step-level retry layer can decide:
//   • dismiss via page.addLocatorHandler (if set up)
//   • fall back to force:true click (if configured)
//   • escalate to LLM diagnose
//
// Skipped (requiresLocator=true) when there's no resolved locator yet —
// overlay detection needs a point to hit-test against.

const MODAL_CLEAR_CAP_MS = 2_000;

export const modalClearPhase: SubPhase = {
  name: 'modal-clear',
  requiresLocator: true,
  fastCheck: async (ctx) => {
    if (!ctx.locator) return false;
    try {
      const obstructed = await isElementObstructed(ctx.locator, ctx.page);
      return !obstructed;
    } catch {
      // fail-open — if the probe breaks (detached, navigated), let the
      // action itself surface the real reason rather than blocking here.
      return true;
    }
  },
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const budget = Math.min(remaining, MODAL_CLEAR_CAP_MS);
    try {
      await waitForOverlayClear(ctx.locator!, ctx.page, budget);
      // waitForOverlayClear resolves either way — re-probe to classify.
      const stillObstructed = await isElementObstructed(ctx.locator!, ctx.page);
      if (stillObstructed) {
        return {
          name: 'modal-clear',
          ready: false,
          waitedMs: Date.now() - start,
          skipped: false,
          knownBlocker: 'modal',
        };
      }
      return { name: 'modal-clear', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDetached = /detached|destroyed|closed/i.test(msg);
      return {
        name: 'modal-clear',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        ...(isDetached ? { knownBlocker: 'detached' as const } : {}),
        evidence: { error: msg },
      };
    }
  },
};

// ─── challenge-clear ──────────────────────────────────────────────────────
//
// Post-phase after click/navigate. A Cloudflare/reCAPTCHA/Vercel interstitial
// may appear as a consequence of the action. We DON'T wait for it to clear —
// automated dismiss isn't safe or even possible — we just surface the
// knownBlocker so the caller can surface a human-readable error or fall
// through to manual handling.
//
// fastCheck returns true (phase irrelevant) when no challenge is detected,
// making this phase effectively free on the happy path.

export const challengeClearPhase: SubPhase = {
  name: 'challenge-clear',
  fastCheck: async (ctx) => {
    try {
      const info = await detectChallengePage(ctx.page);
      return !info.detected;
    } catch {
      return true;
    }
  },
  execute: async (ctx): Promise<PhaseResult> => {
    const start = Date.now();
    // If we got here, fastCheck said challenge IS present. We don't try to
    // dismiss — return immediately with knownBlocker='captcha'. Caller
    // decides (LLM diagnose, user clarification, abort).
    let kind = 'unknown';
    try {
      const info = await detectChallengePage(ctx.page);
      kind = info.kind || 'unknown';
    } catch {
      // fall through
    }
    return {
      name: 'challenge-clear',
      ready: false,
      waitedMs: Date.now() - start,
      skipped: false,
      knownBlocker: 'captcha',
      evidence: { kind },
    };
  },
};

// ─── iframe-ready ─────────────────────────────────────────────────────────
//
// Pre-phase: wait for any iframes on the page to report readyState=complete.
// Reuses waitForIframeContentReady which polls contentDocument.readyState
// with a 300ms interval. This is specifically for flows that target OAuth /
// Stripe / reCAPTCHA iframes — most flows don't care, so the fastCheck
// makes it cheap when irrelevant.

const IFRAME_READY_CAP_MS = 2_000;

export const iframeReadyPhase: SubPhase = {
  name: 'iframe-ready',
  fastCheck: async (ctx) => {
    // Only relevant when the step explicitly targets an iframe. We can't
    // cheaply tell "is my target in an iframe?" without walking the tree,
    // so we gate on the step's iframeConfig presence — everyone else skips.
    const iframeCfg = (ctx.step as unknown as { iframeConfig?: unknown }).iframeConfig;
    if (!iframeCfg) return true; // phase irrelevant → fastCheck says "ready"
    return false;
  },
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const budget = Math.min(remaining, IFRAME_READY_CAP_MS);
    try {
      await waitForIframeContentReady(ctx.page, budget);
      return { name: 'iframe-ready', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      return {
        name: 'iframe-ready',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};
