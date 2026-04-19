/**
 * Auto-dismiss overlays via Playwright's addLocatorHandler
 *
 * Playwright runs the registered handlers BEFORE every actionability check
 * (click / fill / hover / etc). This is the official mechanism for
 * "something keeps popping up and intercepting clicks":
 *   • onboarding tours (react-joyride, intro.js, shepherd, driver.js)
 *   • cookie consent banners (GDPR/CCPA)
 *   • newsletter / promo modals
 *   • third-party chat widgets (Intercom, Tidio, Drift)
 *
 * Per Playwright docs:
 *   - Handler runs inline with the action timeout — keep fast (< ~500ms)
 *   - Handler MUST NOT depend on focus/mouse state left by previous actions;
 *     use self-contained `locator.click` / `page.keyboard.press`
 *   - Registered once per page lifetime (survives navigations)
 *
 * We register a single "remove-then-click-close-button" handler per overlay
 * pattern. On a clean page (no overlays) the handlers NEVER fire, so there's
 * zero cost to the happy path.
 *
 * Re-mount protection: the handler fires at most DISMISS_TIMES_CAP times per
 * page lifetime. Tour libraries whose parent component stays mounted will
 * re-render the portal after every remove(), producing an infinite
 * addLocatorHandler loop. The cap prevents that; after the cap is hit
 * Playwright's own actionability errors take over and the agent either
 * retries via the resolver or surfaces the failure to the user.
 *
 * NOTE: there is no per-step "disable auto-dismiss" escape hatch. A previous
 * iteration of this module documented one but nothing ever consumed
 * step.options.disableAutoDismiss, so the claim was removed. Tests that
 * legitimately target a tour overlay should delete the overlay pattern from
 * OVERLAY_PATTERNS (or guard the registration call) before running.
 */

import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';

/**
 * Maximum times a single handler fires per page lifetime.
 *
 * Why cap: React tour components (`<Joyride run={true} />`, `Shepherd.js`
 * hooks, etc.) keep their host React component mounted and re-render the
 * portal on every state change. `dismissViaRemove` takes the portal out of
 * the DOM, React's reconciler puts it back on the next commit, Playwright's
 * next actionability check matches again, handler fires again, infinite
 * loop until the action's 10s timeout. Five fires is enough to progress
 * through a typical multi-step tour and small enough to prevent loops.
 */
const DISMISS_TIMES_CAP = 5;

// ─── Overlay registry ─────────────────────────────────────────────────────
//
// Each entry: a Playwright selector for the overlay, and a dismiss action.
// We try dismiss actions in order (ESC first — cheapest and safest), fall
// through on failure, and log silently. The goal is best-effort: if we can't
// dismiss, Playwright's own actionability retry still has a chance.

interface OverlayPattern {
  name: string;
  /** CSS / XPath / role selector that matches the overlay. */
  selector: string;
  /**
   * Attempts to dismiss the overlay. Ordered most-to-least preferred. Each
   * returns true on apparent success (element vanished), false otherwise.
   * Must be fast (<500ms each) — Playwright enforces the action timeout.
   */
  dismiss: Array<(page: Page) => Promise<boolean>>;
}

/**
 * Click any Close/Skip/Dismiss button inside the overlay subtree. Matches
 * on common accessible names + known framework patterns. Caps the click
 * at 300ms so a slow DOM can't hold up the main action.
 */
const dismissViaCloseButton = (rootSelector: string) =>
  async (page: Page): Promise<boolean> => {
    const closeSelectors = [
      `${rootSelector} button[aria-label*="close" i]`,
      `${rootSelector} button[aria-label*="dismiss" i]`,
      `${rootSelector} button[aria-label*="skip" i]`,
      `${rootSelector} button:has-text("Skip")`,
      `${rootSelector} button:has-text("Close")`,
      `${rootSelector} button:has-text("×")`,
      `${rootSelector} [data-action="skip"]`,
      `${rootSelector} [data-action="close"]`,
    ];
    for (const sel of closeSelectors) {
      try {
        const loc = page.locator(sel).first();
        await loc.click({ timeout: 300, noWaitAfter: true });
        return true;
      } catch {
        // next selector
      }
    }
    return false;
  };

/**
 * Last-resort: remove the overlay node from the DOM. Loud but reliable.
 * We only use this when every other dismiss attempt fails, because it
 * bypasses the app's own cleanup (state, focus restoration, etc.).
 */
const dismissViaRemove = (rootSelector: string) =>
  async (page: Page): Promise<boolean> => {
    try {
      return await page.evaluate(
        (sel) => {
          // @ts-expect-error — browser context
          const nodes = document.querySelectorAll(sel);
          if (nodes.length === 0) return false;
          nodes.forEach((n: { remove(): void }) => n.remove());
          return true;
        },
        rootSelector,
      );
    } catch {
      return false;
    }
  };

// ─── Known overlay patterns ──────────────────────────────────────────────

// Ordering rationale (applies to every pattern):
//   1. dismissViaRemove FIRST — surgical, zero side effects: touches only
//      the tour library's own DOM subtree.
//   2. dismissViaCloseButton — also scoped to the tour library.
//   3. dismissViaEscape has been REMOVED from every pattern. Rationale:
//      `page.keyboard.press('Escape')` is a page-wide keyboard event,
//      not a tour-library action. It closes every overlay listening for
//      Escape — which includes every Radix/Headless/shadcn Dialog (the
//      whole "Купить урок" modal family). A repro: on Repetino the
//      tutors page ships a dormant joyride portal; when the user opens
//      the purchase modal on top and the agent tries a click, the
//      joyride addLocatorHandler fires, Escape closes the PURCHASE
//      modal, refs detach, click times out 10s waiting for stale
//      `[data-agent-ref="e217"]`. See terminal log
//      2026-04-19 17:16:06–17:16:23. dismissViaRemove would have worked
//      on joyride alone and never touched the purchase modal.
const OVERLAY_PATTERNS: OverlayPattern[] = [
  // react-joyride (product tour library). "spotlight" overlay tricks
  // elementFromPoint into returning the target, but edges still intercept
  // clicks — addLocatorHandler catches it cleanly.
  //
  // Selector covers: the dim layer (`.react-joyride__overlay`), any
  // descendant of the portal node (`#react-joyride-portal > *`), the
  // spotlight cutout (`.react-joyride__spotlight`), and the floater
  // popper wrapper (`.__floater__` — used by react-joyride v2+ to
  // position the tooltip; often the actual click-intercepting element).
  // Removing the portal wipes all of them in one operation.
  {
    name: 'react-joyride',
    selector: [
      '.react-joyride__overlay',
      '.react-joyride__spotlight',
      '[data-test-id="overlay"].react-joyride__overlay',
      '#react-joyride-portal > *',
      '.__floater__',
    ].join(', '),
    dismiss: [
      dismissViaRemove('#react-joyride-portal, .__floater__'),
      dismissViaCloseButton('.react-joyride__tooltip'),
    ],
  },
  // intro.js — similar tour library.
  {
    name: 'intro-js',
    selector: '.introjs-overlay, .introjs-tooltipReferenceLayer',
    dismiss: [
      dismissViaRemove('.introjs-overlay,.introjs-tooltipReferenceLayer'),
      dismissViaCloseButton('.introjs-tooltip'),
    ],
  },
  // shepherd.js — yet another tour library, used by GitLab among others.
  {
    name: 'shepherd',
    selector: '.shepherd-modal-overlay-container, .shepherd-element',
    dismiss: [
      dismissViaRemove('.shepherd-modal-overlay-container,.shepherd-element'),
      dismissViaCloseButton('.shepherd-element'),
    ],
  },
  // driver.js — yet another. Covers the long tail of tour-style overlays.
  {
    name: 'driver-js',
    selector: '#driver-page-overlay, .driver-popover',
    dismiss: [
      dismissViaRemove('#driver-page-overlay,.driver-popover'),
      dismissViaCloseButton('.driver-popover'),
    ],
  },
];

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Register all known overlay auto-dismiss handlers on a page.
 *
 * Playwright's addLocatorHandler fires the callback ONLY when the matched
 * locator is visible. Handlers are page-scoped; no need to re-register on
 * navigation. Safe to call multiple times — duplicate registrations on the
 * same selector/handler pair are a no-op per Playwright source.
 *
 * Non-fatal: any registration failure is logged and swallowed. Preview
 * should work without the overlay dismisser — it's purely an enhancement.
 */
export async function registerOverlayAutoDismiss(page: Page): Promise<void> {
  for (const pattern of OVERLAY_PATTERNS) {
    try {
      await page.addLocatorHandler(
        page.locator(pattern.selector).first(),
        async () => {
          // Try dismiss strategies in order until one reports success.
          for (const strategy of pattern.dismiss) {
            try {
              const ok = await strategy(page);
              if (ok) {
                logger.debug('[AUTO_DISMISS] Overlay dismissed', {
                  overlay: pattern.name,
                  strategy: strategy.name || 'anonymous',
                });
                return;
              }
            } catch (err) {
              // Strategy itself threw — keep trying the next one.
              logger.debug('[AUTO_DISMISS] Dismiss strategy errored', {
                overlay: pattern.name,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // All strategies failed — log once so operators can see it in traces.
          logger.debug('[AUTO_DISMISS] All strategies failed', {
            overlay: pattern.name,
          });
        },
        // `times: DISMISS_TIMES_CAP` → run at most N times per page to
        // prevent an infinite handler loop when the host React component
        // immediately re-mounts a removed portal (see DISMISS_TIMES_CAP
        // docstring). `noWaitAfter: true` → don't wait for the overlay
        // to become hidden after the handler runs; paired with the cap,
        // this is the right knob — waiting would give a re-mount-loop
        // library another chance to pump handler invocations.
        { noWaitAfter: true, times: DISMISS_TIMES_CAP },
      );
    } catch (err) {
      // Usually happens when the page is already closed / browser crashed.
      // Non-fatal — registration is best-effort.
      logger.debug('[AUTO_DISMISS] Failed to register handler', {
        overlay: pattern.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
