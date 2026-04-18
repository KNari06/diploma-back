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
 * We register a single "best-effort ESC + click-close-buttons" handler per
 * overlay pattern. On a clean page (no overlays) the handlers NEVER fire, so
 * there's zero cost to the happy path.
 *
 * Opt-out: steps that legitimately target an overlay (e.g. a test for the
 * cookie banner itself) should set step.options.disableAutoDismiss — enforced
 * at the caller level, NOT here, because Playwright's addLocatorHandler is
 * page-scoped and can't read per-step flags.
 */

import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';

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

/** Press Escape. Works for most modal-style dialogs and tour steps. */
const dismissViaEscape = async (page: Page): Promise<boolean> => {
  try {
    await page.keyboard.press('Escape', { delay: 0 });
    return true;
  } catch {
    return false;
  }
};

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

const OVERLAY_PATTERNS: OverlayPattern[] = [
  // react-joyride (product tour library). "spotlight" overlay tricks
  // elementFromPoint into returning the target, but edges still intercept
  // clicks — addLocatorHandler catches it cleanly.
  {
    name: 'react-joyride',
    selector: '.react-joyride__overlay, [data-test-id="overlay"].react-joyride__overlay, #react-joyride-portal > *',
    dismiss: [
      dismissViaEscape,
      dismissViaCloseButton('.react-joyride__tooltip'),
      dismissViaRemove('#react-joyride-portal'),
    ],
  },
  // intro.js — similar tour library.
  {
    name: 'intro-js',
    selector: '.introjs-overlay, .introjs-tooltipReferenceLayer',
    dismiss: [
      dismissViaEscape,
      dismissViaCloseButton('.introjs-tooltip'),
      dismissViaRemove('.introjs-overlay,.introjs-tooltipReferenceLayer'),
    ],
  },
  // shepherd.js — yet another tour library, used by GitLab among others.
  {
    name: 'shepherd',
    selector: '.shepherd-modal-overlay-container, .shepherd-element',
    dismiss: [
      dismissViaEscape,
      dismissViaCloseButton('.shepherd-element'),
      dismissViaRemove('.shepherd-modal-overlay-container,.shepherd-element'),
    ],
  },
  // driver.js — yet another. Covers the long tail of tour-style overlays.
  {
    name: 'driver-js',
    selector: '#driver-page-overlay, .driver-popover',
    dismiss: [
      dismissViaEscape,
      dismissViaCloseButton('.driver-popover'),
      dismissViaRemove('#driver-page-overlay,.driver-popover'),
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
        // `times: undefined` → run for every action until the handler is
        // removed. `noWaitAfter: true` → don't wait for animations after
        // dismiss, so we don't eat into the action timeout budget.
        { noWaitAfter: true },
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
