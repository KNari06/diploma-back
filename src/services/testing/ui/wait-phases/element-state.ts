/**
 * Wait phases: visible / editable / attached / focused / actionable
 *
 * All five phases probe a single Locator state. They share the same shape:
 *   • fastCheck = withHardCap(locator.is*(), 200ms)
 *   • execute   = locator.waitFor(state) OR waitForElementEnabled (for actionable)
 *
 * Split by export because the plan table references each by name; combining
 * them here (vs 5 tiny files) keeps the import surface tight without losing
 * individuality in diagnostics.
 *
 * All phases mark requiresLocator=true so the dispatcher short-circuits with
 * knownBlocker='no_locator' if the caller forgot to resolve.
 */

import type { Locator } from 'playwright';
import {
  waitForElementEnabled,
  withHardCap,
} from '../preview/step-readiness.service';
import type { PhaseResult, SmartWaitContext, SubPhase } from '../smart-step-wait.service';

// Playwright state-probe hard cap — mirrors EVALUATE_HARD_CAP_MS (500ms)
// in step-readiness but trimmed to 200ms because these are *fastChecks*
// and the dispatcher already caps them at FAST_CHECK_HARD_CAP_MS internally.
// We still apply our own cap here so a hung CDP call never races past it.
const FAST_PROBE_CAP_MS = 200;

async function probeVisible(locator: Locator): Promise<boolean> {
  return withHardCap(() => locator.isVisible(), FAST_PROBE_CAP_MS, false);
}

async function probeEditable(locator: Locator): Promise<boolean> {
  return withHardCap(() => locator.isEditable(), FAST_PROBE_CAP_MS, false);
}

async function probeAttached(locator: Locator): Promise<boolean> {
  // Playwright doesn't expose isAttached() — use count()>0 instead.
  const count = await withHardCap(() => locator.count(), FAST_PROBE_CAP_MS, -1);
  return count > 0;
}

async function probeEnabled(locator: Locator): Promise<boolean> {
  return withHardCap(() => locator.isEnabled(), FAST_PROBE_CAP_MS, false);
}

async function probeFocused(locator: Locator): Promise<boolean> {
  // Focus check isn't on Locator; evaluate in-page against activeElement.
  return withHardCap(
    () => locator.evaluate((el) => el === el.ownerDocument.activeElement),
    FAST_PROBE_CAP_MS,
    false,
  );
}

// ─── visible ──────────────────────────────────────────────────────────────

export const visiblePhase: SubPhase = {
  name: 'visible',
  requiresLocator: true,
  fastCheck: async (ctx) => (ctx.locator ? probeVisible(ctx.locator) : false),
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    try {
      await ctx.locator!.waitFor({ state: 'visible', timeout: remaining });
      return { name: 'visible', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Playwright phrases detachment errors a few different ways — treat them
      // all as the retry signal recommended in the Playwright best-practice
      // research (re-resolve the locator rather than hard-fail the step).
      const isDetached = /detached|destroyed|closed/i.test(msg);
      return {
        name: 'visible',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        ...(isDetached ? { knownBlocker: 'detached' as const } : {}),
        evidence: { error: msg },
      };
    }
  },
};

// ─── editable ─────────────────────────────────────────────────────────────

export const editablePhase: SubPhase = {
  name: 'editable',
  requiresLocator: true,
  fastCheck: async (ctx) => (ctx.locator ? probeEditable(ctx.locator) : false),
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    // No locator.waitFor({state:'editable'}) exists — poll at 100ms.
    const deadline = Date.now() + remaining;
    while (Date.now() < deadline) {
      if (await probeEditable(ctx.locator!)) {
        return { name: 'editable', ready: true, waitedMs: Date.now() - start, skipped: false };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { name: 'editable', ready: false, waitedMs: Date.now() - start, skipped: false };
  },
};

// ─── attached ─────────────────────────────────────────────────────────────

export const attachedPhase: SubPhase = {
  name: 'attached',
  requiresLocator: true,
  fastCheck: async (ctx) => (ctx.locator ? probeAttached(ctx.locator) : false),
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    try {
      await ctx.locator!.waitFor({ state: 'attached', timeout: remaining });
      return { name: 'attached', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      return {
        name: 'attached',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

// ─── focused ──────────────────────────────────────────────────────────────

export const focusedPhase: SubPhase = {
  name: 'focused',
  requiresLocator: true,
  fastCheck: async (ctx) => (ctx.locator ? probeFocused(ctx.locator) : false),
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const deadline = Date.now() + remaining;
    // Some actions (press) don't auto-focus — poll until the element wins focus.
    while (Date.now() < deadline) {
      if (await probeFocused(ctx.locator!)) {
        return { name: 'focused', ready: true, waitedMs: Date.now() - start, skipped: false };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { name: 'focused', ready: false, waitedMs: Date.now() - start, skipped: false };
  },
};

// ─── actionable ───────────────────────────────────────────────────────────
//
// "actionable" = enabled + visible + attached. We layer the cheap probes
// and fall back to waitForElementEnabled for the blocking wait (which is
// the only one of the three that isn't trivially a Playwright waitFor).

export const actionablePhase: SubPhase = {
  name: 'actionable',
  requiresLocator: true,
  fastCheck: async (ctx) => {
    if (!ctx.locator) return false;
    const [visible, enabled] = await Promise.all([
      probeVisible(ctx.locator),
      probeEnabled(ctx.locator),
    ]);
    return visible && enabled;
  },
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    try {
      // Visibility first (cheaper in most cases), then enabled.
      await ctx.locator!.waitFor({ state: 'visible', timeout: Math.min(remaining, 5_000) });
      const spent = Date.now() - start;
      if (spent >= remaining) {
        return { name: 'actionable', ready: false, waitedMs: spent, skipped: false };
      }
      await waitForElementEnabled(ctx.locator!, remaining - spent);
      return { name: 'actionable', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDetached = /detached|destroyed|closed/i.test(msg);
      return {
        name: 'actionable',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        ...(isDetached ? { knownBlocker: 'detached' as const } : {}),
        evidence: { error: msg },
      };
    }
  },
};
