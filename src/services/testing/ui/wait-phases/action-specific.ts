/**
 * Wait phases: dropdown-ready / lazy-load-idle / condition-met / file-set
 *
 * Action-specific phases that don't fit general categories. All are kept
 * intentionally permissive — they fastCheck as ready when irrelevant so
 * they add zero latency on flows that don't need them.
 */

import type { Locator } from 'playwright';
import { waitForApiIdle, withHardCap } from '../preview/step-readiness.service';
import type { PhaseResult, SmartWaitContext, SubPhase } from '../smart-step-wait.service';

// ─── dropdown-ready ───────────────────────────────────────────────────────
//
// Pre-phase for `select`. Native <select> doesn't need this — Playwright's
// selectOption handles it. But custom comboboxes (Radix, Ant, Material)
// animate open and have per-option virtual scrolling; we wait for the
// listbox to be present before issuing the selection action.
//
// Heuristic: element with role=combobox or aria-haspopup='listbox' that's
// already aria-expanded='true' → ready. Otherwise poll briefly; if nothing
// opens we fall through with ready=true (native selects, or selects that
// open on click in executeAction rather than pre-open).

const DROPDOWN_READY_CAP_MS = 800;

async function probeDropdownReady(locator: Locator): Promise<boolean> {
  try {
    const isOpen = await withHardCap(
      () =>
        locator.evaluate((el) => {
          const e = el as any;
          const expanded = e.getAttribute('aria-expanded');
          if (expanded === null) return true; // native <select> — assume ready
          return expanded === 'true';
        }),
      150,
      true,
    );
    return isOpen;
  } catch {
    return true;
  }
}

export const dropdownReadyPhase: SubPhase = {
  name: 'dropdown-ready',
  requiresLocator: true,
  fastCheck: async (ctx) => (ctx.locator ? probeDropdownReady(ctx.locator) : false),
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    if (!ctx.locator) {
      return { name: 'dropdown-ready', ready: true, waitedMs: 0, skipped: false };
    }
    const deadline = Date.now() + Math.min(remaining, DROPDOWN_READY_CAP_MS);
    while (Date.now() < deadline) {
      if (await probeDropdownReady(ctx.locator)) {
        return { name: 'dropdown-ready', ready: true, waitedMs: Date.now() - start, skipped: false };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Not ready but don't block — selectOption/click will do its own wait.
    return { name: 'dropdown-ready', ready: true, waitedMs: Date.now() - start, skipped: false };
  },
};

// ─── lazy-load-idle ───────────────────────────────────────────────────────
//
// Post-phase for `scroll`. Infinite-scroll pages fire a flurry of API calls
// right after the scroll event; we wait a SHORT window for those to drain
// so the next step sees the newly-appended items.
//
// Shorter budget than generic api-idle — scrolls shouldn't block long.

const LAZY_LOAD_CAP_MS = 800;

export const lazyLoadIdlePhase: SubPhase = {
  name: 'lazy-load-idle',
  fastCheck: async () => false, // same reasoning as api-idle
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const budget = Math.min(remaining, LAZY_LOAD_CAP_MS);
    try {
      await waitForApiIdle(ctx.page, budget);
      return { name: 'lazy-load-idle', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      return {
        name: 'lazy-load-idle',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

// ─── condition-met ────────────────────────────────────────────────────────
//
// Post-phase for `wait_for`. The `wait_for` action itself evaluates its
// condition (URL matcher, selector, etc.) — this phase just confirms the
// condition is stable (didn't flip back) for a brief dwell time.
//
// We intentionally don't re-evaluate the matcher here: the step-apply layer
// owns that. Our job is only to give the page a moment to settle after the
// matcher resolved. 150ms is the assertion DOM-stable threshold — same
// budget as an `assert` step.

const CONDITION_DWELL_MS = 150;

export const conditionMetPhase: SubPhase = {
  name: 'condition-met',
  fastCheck: async () => false,
  execute: async (_ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const dwell = Math.min(remaining, CONDITION_DWELL_MS);
    await new Promise((r) => setTimeout(r, dwell));
    return { name: 'condition-met', ready: true, waitedMs: Date.now() - start, skipped: false };
  },
};

// ─── file-set ─────────────────────────────────────────────────────────────
//
// Post-phase for `upload`. Confirms the hidden <input type=file> actually
// received files via the step (some frameworks use synthetic drag-drop and
// swallow setInputFiles; we catch those cases here).

const FILE_SET_CAP_MS = 1_500;

async function probeFilesSet(locator: Locator): Promise<boolean> {
  try {
    return await withHardCap(
      () =>
        locator.evaluate((el) => {
          const input = el as any;
          const files = input.files;
          return !!(files && files.length > 0);
        }),
      200,
      false,
    );
  } catch {
    return false;
  }
}

export const fileSetPhase: SubPhase = {
  name: 'file-set',
  requiresLocator: true,
  fastCheck: async (ctx) => (ctx.locator ? probeFilesSet(ctx.locator) : false),
  execute: async (ctx: SmartWaitContext, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    if (!ctx.locator) {
      return { name: 'file-set', ready: true, waitedMs: 0, skipped: false };
    }
    const deadline = Date.now() + Math.min(remaining, FILE_SET_CAP_MS);
    while (Date.now() < deadline) {
      if (await probeFilesSet(ctx.locator)) {
        return { name: 'file-set', ready: true, waitedMs: Date.now() - start, skipped: false };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      name: 'file-set',
      ready: false,
      waitedMs: Date.now() - start,
      skipped: false,
    };
  },
};
