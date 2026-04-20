/**
 * Wait phases: spa-nav-detect / load-state / api-idle
 *
 * Navigation-side settle phases. All three wrap existing helpers, adapted
 * to the SubPhase contract.
 */

import {
  detectSpaNavigation,
  waitForApiIdle,
} from '../preview/step-readiness.service';
import type { PhaseResult, SubPhase } from '../smart-step-wait.service';

// ─── spa-nav-detect ───────────────────────────────────────────────────────
//
// Post-phase for actions that may trigger a client-side navigation (click,
// press, drag_and_drop). Polls page.url() with framenavigated hybrid — if
// the URL changes, we mark ready=true with knownBlocker='navigation' so the
// caller knows the next step will run in a fresh document.
//
// If NO navigation happens within the budget, phase returns ready=true
// (silent success) — not navigating is the common case and isn't a blocker.

const SPA_NAV_CAP_MS = 1_500;

export const spaNavDetectPhase: SubPhase = {
  name: 'spa-nav-detect',
  fastCheck: async (ctx) => {
    // Only run when we know the previous URL — without a baseline we can't
    // detect change. Missing prevUrl → skip (treated as "no nav").
    if (!ctx.prevUrl) return true;
    try {
      return ctx.page.url() === ctx.prevUrl;
    } catch {
      return true;
    }
  },
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    if (!ctx.prevUrl) {
      return { name: 'spa-nav-detect', ready: true, waitedMs: 0, skipped: false };
    }
    const budget = Math.min(remaining, SPA_NAV_CAP_MS);
    try {
      const navigated = await detectSpaNavigation(ctx.page, ctx.prevUrl, budget);
      if (navigated) {
        // Navigation IS a valid outcome — mark as ready but flag the blocker
        // so the caller can bump the post-nav settle budget.
        return {
          name: 'spa-nav-detect',
          ready: true,
          waitedMs: Date.now() - start,
          skipped: false,
          knownBlocker: 'navigation',
          evidence: { navigated: true, fromUrl: ctx.prevUrl, toUrl: ctx.page.url() },
        };
      }
      return { name: 'spa-nav-detect', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      return {
        name: 'spa-nav-detect',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

// ─── load-state ───────────────────────────────────────────────────────────
//
// Post-phase after a navigate step. Wraps page.waitForLoadState. We stop at
// 'domcontentloaded' rather than 'load' — the latter blocks on every image
// and third-party tracker, and the remaining page work is covered by
// api-idle + dom-settle phases that run after this one.
//
// NOTE: networkidle is intentionally NOT used — Playwright's docs
// explicitly warn against it for SPAs (long-polling, websockets, analytics
// beacons keep it from ever firing).

const LOAD_STATE_CAP_MS = 5_000;

export const loadStatePhase: SubPhase = {
  name: 'load-state',
  fastCheck: async () => false, // cheap to just call the real wait
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const budget = Math.min(remaining, LOAD_STATE_CAP_MS);
    try {
      await ctx.page.waitForLoadState('domcontentloaded', { timeout: budget });
      return { name: 'load-state', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      // waitForLoadState throws on timeout — treat as non-fatal, the outer
      // dom-settle and api-idle phases will catch up.
      return {
        name: 'load-state',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

// ─── api-idle ─────────────────────────────────────────────────────────────
//
// Post-phase: wait for pending fetch/xhr requests (filtered to first-party +
// non-long-polling) to drain. The underlying waitForApiIdle uses 150ms of
// quiet time as the idle threshold.
//
// Bounded to API_IDLE_CAP_MS — on a chatty page (analytics, polling, websocket
// keepalives that somehow escape the filter), we'd rather hand back to the
// caller than wait forever.

const API_IDLE_CAP_MS = 2_000;

export const apiIdlePhase: SubPhase = {
  name: 'api-idle',
  // We can't cheaply tell "are there pending requests right now?" — that's
  // the whole point of waitForApiIdle's internal counter. So fastCheck is
  // always false and we let execute handle it.
  fastCheck: async () => false,
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const budget = Math.min(remaining, API_IDLE_CAP_MS);
    try {
      await waitForApiIdle(ctx.page, budget);
      return { name: 'api-idle', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      return {
        name: 'api-idle',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};
