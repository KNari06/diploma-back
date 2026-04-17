/**
 * Wait phase: hover-effect-settle
 *
 * Shared implementation for "wait for tooltip/menu/popover that appeared after
 * a hover to become stable". Previously duplicated in two places:
 *   • preview-step-apply.service.ts:1008  (editor/preview Apply pipeline)
 *   • command-executor.ts:94              (background/regression pipeline)
 *
 * Both callers now import from here so there is ONE source of truth for
 * hover-effect detection selectors, phase sequence, and timing. The SubPhase
 * wrapper at the bottom lets smart-step-wait dispatch it as a normal phase.
 */

import type { Page } from 'playwright';
import { STEP_READINESS_CONFIG } from '@/config/testing/playwright-tuning';
import type { PhaseResult, SmartWaitContext, SubPhase } from '../smart-step-wait.service';

// Selectors for elements commonly created by hover (tooltips, menus, popovers).
// Keep this list in sync across future design-system additions — this is the
// single place where "things that appear on hover" is defined.
const HOVER_EFFECT_SELECTOR = [
  '[role="tooltip"]:visible',
  '[role="menu"]:visible',
  '[role="listbox"]:visible',
  '[role="dialog"]:visible',
  '[data-radix-popper-content-wrapper]:visible',
  '[class*="tooltip"]:visible',
  '[class*="popover"]:visible',
  '[class*="dropdown"]:visible',
  '.tippy-box:visible',
  '.MuiTooltip-tooltip:visible',
  '.MuiMenu-list:visible',
  '.ant-tooltip:visible',
  '.ant-dropdown:visible',
].join(', ');

/**
 * Wait for a hover-triggered effect (tooltip/menu/popover) to appear and then
 * stabilise. Used both directly by legacy callers (until they're migrated)
 * and wrapped as a SubPhase for smart-step-wait.
 *
 * Strategy:
 *  1. Race a selector-appear check against a minimum wait — avoids 0ms exit
 *     on hovers that don't produce DOM effects.
 *  2. If effect appeared, run a MutationObserver-based idle loop until
 *     `stableMs` of no mutations, or we run out of the maxWaitMs budget.
 *
 * Returns elapsed ms. Never throws — timeouts fall through and return.
 */
export async function waitForHoverEffect(
  page: Page,
  maxWaitMs = 2000,
  stableMs = 150,
): Promise<number> {
  const start = Date.now();

  // Phase 1: Did hover produce any visible effect?
  const minWaitMs = STEP_READINESS_CONFIG.domStableThresholdMs.assertion; // 150ms
  try {
    await Promise.race([
      page.waitForSelector(HOVER_EFFECT_SELECTOR, { state: 'visible', timeout: maxWaitMs }),
      page.waitForTimeout(minWaitMs),
    ]);
  } catch {
    // No effect found within maxWaitMs — hover probably doesn't trigger
    // visible DOM changes on this element. Return the probe cost.
    return Date.now() - start;
  }

  // Phase 2: MutationObserver-based idle detection. Catches CSS transitions
  // that add/remove classes without changing child count.
  const remainingMs = maxWaitMs - (Date.now() - start);
  if (remainingMs > stableMs) {
    try {
      await page.evaluate(
        ({ stableMs: stMs, timeoutMs }) =>
          new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const reset = () => {
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => {
                observer.disconnect();
                resolve();
              }, stMs);
            };
            const MO = (globalThis as any).MutationObserver;
            const observer = new MO(() => reset());
            observer.observe((globalThis as any).document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['class', 'style', 'aria-hidden', 'hidden', 'data-state'],
            });
            // Safety cap so we always resolve.
            setTimeout(() => {
              observer.disconnect();
              if (timer) clearTimeout(timer);
              resolve();
            }, timeoutMs);
            // Kick off the idle timer immediately.
            reset();
          }),
        { stableMs, timeoutMs: Math.min(remainingMs, maxWaitMs) },
      );
    } catch {
      // page.evaluate can fail if the page navigated mid-call — fall through.
    }
  }

  return Date.now() - start;
}

// ─── SubPhase wrapper for smart-step-wait ────────────────────────────────

/**
 * SubPhase: hover-effect-settle
 *
 * Post-phase for hover actions. Fast-check is a no-op (we can't cheaply tell
 * whether a hover effect is pending without the full probe), so it always
 * runs the full wait — but the wait itself exits quickly if no effect
 * appears within minWaitMs.
 */
export const hoverEffectSettlePhase: SubPhase = {
  name: 'hover-effect-settle',
  fastCheck: async () => false,
  execute: async (ctx: SmartWaitContext, remainingBudgetMs: number): Promise<PhaseResult> => {
    const start = Date.now();
    // Cap at caller's remaining budget but don't exceed historical default (2s)
    // — longer hover waits almost always mean the site just doesn't react to
    // hover, and polling longer is pure latency tax.
    const maxWaitMs = Math.min(remainingBudgetMs, 2000);
    try {
      await waitForHoverEffect(ctx.page, maxWaitMs, 150);
      return { name: 'hover-effect-settle', ready: true, waitedMs: Date.now() - start, skipped: false };
    } catch (err) {
      return {
        name: 'hover-effect-settle',
        ready: false,
        waitedMs: Date.now() - start,
        skipped: false,
        evidence: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};
