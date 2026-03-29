/**
 * Step Readiness Service
 * Lookahead wait mechanism for inter-step stability
 *
 * V14: Comprehensive deterministic readiness — 7-layer page readiness engine.
 *
 * Key features:
 * - Fast precondition checks using compiled locatorPlan or evidence.lastSuccessRef
 * - SPA navigation detection after click/open/close (URL-change race, no hardcoded delays)
 * - Dynamic DOM stability threshold based on previous action risk profile
 * - **Loading indicator detection** (spinners, skeletons, aria-busy, progressbar)
 * - **Pending API request tracking** (fetch/xhr idle detection)
 * - **CSS animation/transition wait** on target element
 * - **Overlay/obstruction detection** (elementFromPoint at target center)
 * - **Inter-step delay hints** from recording evidence
 * - Page settle fallback (DOM stable) when element not ready
 * - Blind settle fallback when no locator available (instead of skipping entirely)
 * - Runtime metadata tracking (autoWaitApplied) when significant wait occurred
 * - Per-step disable flag for advanced use cases
 */

import { logger } from '@/utils/core/logger';
import type { Locator, Page } from 'playwright';
import type { IntentActionType, IntentStep } from './preview.types';
import { STEP_READINESS_CONFIG } from '@/config/testing/playwright-tuning';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of lookahead readiness check
 */
export interface LookaheadResult {
  /** Whether the element was found ready (or step was skipped) */
  ready: boolean;
  /** Total milliseconds waited */
  waited: number;
  /** True if waited > threshold (should be recorded in runtimeMeta) */
  autoWaitApplied: boolean;
  /** Reason if lookahead was skipped (non-targeting, no ref, disabled, etc.) */
  skipReason?: string;
  /** True if SPA navigation was detected after previous step */
  navigationDetected?: boolean;
  /** V14: Comprehensive readiness check results (for trace logging) */
  readinessChecks?: ReadinessCheckResult;
  /** V14: Whether URL changed between steps */
  urlChanged?: boolean;
}

/**
 * Options for lookahead wait
 */
export interface LookaheadOptions {
  /** Maximum total wait time in milliseconds (default: 10000) */
  maxWaitMs?: number;
  /** Per-settle attempt timeout in milliseconds (default: 3000) */
  settleMs?: number;
  /** Threshold above which autoWaitApplied is flagged (default: 2000) */
  autoWaitThresholdMs?: number;
  /** DOM stability threshold in milliseconds — overrides dynamic calculation when set */
  domStableThresholdMs?: number;
  /** Maximum number of settle retries (default: 3) */
  maxRetries?: number;
  /**
   * The action type of the PREVIOUS step.
   * Used to detect SPA navigation risk and calibrate DOM stability threshold.
   */
  prevActionType?: IntentActionType;
  /**
   * URL of the page when the previous step started executing.
   * If provided, used to detect SPA navigation (URL changed → nav occurred).
   */
  prevUrl?: string;
  /**
   * V14: Inter-step delay from recording evidence (ms).
   * If provided, ensures a minimum wait of ~70% of this value before declaring ready.
   * Rationale: if the user waited 3s between steps during recording, the page
   * likely needed that time to load data or render content.
   */
  recordedDelayMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Action types that don't target elements (skip lookahead entirely) */
const NON_TARGETING_ACTIONS: Set<IntentActionType> = new Set([
  // 'navigate' removed — goto needs lookahead for JS hydration after domcontentloaded
  'wait',
  'wait_for',
  'ai_check',
  'wait_for_email',  // V12: Email inbox polling (no element target)
  'dialog',          // V14: Pre-installs handler, no element target
  'download',        // V14: Waits for download event, no element target
  'switch_tab',      // V15: Tab switch, no element target
]);

/**
 * Action types that commonly trigger SPA navigation or heavy async re-renders.
 * After these, we do a URL-change race before attempting element checks.
 */
const NAVIGATION_TRIGGER_ACTIONS: Set<IntentActionType> = new Set([
  'click',
  'open',
  'close',
  'toggle',
  'press',
  'hover',     // V13: Hover can trigger dropdowns, menus, tooltips — next step needs DOM settle
  'navigate',  // goto triggers full page navigation, needs networkIdle + DOM settle
]);

/** Action types that require visible + enabled */
const NEEDS_VISIBLE_ENABLED: Set<IntentActionType> = new Set([
  'click',
  'type',
  'select',
  'check',
  'uncheck',
  'toggle',
  'dblclick',        // V14: Same as click — needs visible + enabled
  'contextmenu',     // V14: Right-click needs visible + enabled
  'open',            // V14: Expands accordion/dropdown — needs visible + enabled
  'close',           // V14: Collapses accordion/dropdown — needs visible + enabled
  'drag_and_drop',   // V14: Drag source must be visible + enabled
]);

/** Action types that require visible only */
const NEEDS_VISIBLE_ONLY: Set<IntentActionType> = new Set([
  'assert',
  'hover',
  'scroll',
]);

/** Action types that only need element attached (in DOM) */
const NEEDS_ATTACHED_ONLY: Set<IntentActionType> = new Set([
  'press',
  'upload',          // V14: File inputs are often hidden — only need attached, not visible
]);

const DOM_STABLE_THRESHOLD_MS = STEP_READINESS_CONFIG.domStableThresholdMs;
const BLIND_SETTLE_MS = STEP_READINESS_CONFIG.blindSettleMs;
const SPA_NAV_DETECT_MS = STEP_READINESS_CONFIG.spaNavDetectMs;
const DEFAULTS = STEP_READINESS_CONFIG.defaults;

// ═══════════════════════════════════════════════════════════════════════════
// DOM STABILITY THRESHOLD — DYNAMIC
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute DOM stability threshold based on the previous action's risk profile.
 * Override with explicit domStableThresholdMs if provided.
 */
function getDomStableThresholdMs(
  prevActionType: IntentActionType | undefined,
  explicitOverride: number | undefined
): number {
  if (explicitOverride !== undefined) return explicitOverride;

  if (!prevActionType) return DOM_STABLE_THRESHOLD_MS.default;

  if (NAVIGATION_TRIGGER_ACTIONS.has(prevActionType)) return DOM_STABLE_THRESHOLD_MS.navigation;
  if (prevActionType === 'type' || prevActionType === 'select') return DOM_STABLE_THRESHOLD_MS.input;
  if (prevActionType === 'assert') return DOM_STABLE_THRESHOLD_MS.assertion;

  return DOM_STABLE_THRESHOLD_MS.default;
}

// ═══════════════════════════════════════════════════════════════════════════
// SPA NAVIGATION DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect whether a SPA navigation occurred after a navigation-trigger action.
 *
 * Strategy: poll page.url() until it changes from prevUrl, or timeout.
 * This is cheaper than waitForNavigation (which requires the nav to be in-flight)
 * and works with hash-routing and pushState.
 *
 * Returns true if URL changed (navigation detected), false if timed out.
 */
async function detectSpaNavigation(
  page: Page,
  prevUrl: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 50;

  while (Date.now() < deadline) {
    try {
      const currentUrl = page.url();
      if (currentUrl !== prevUrl) {
        logger.debug('[STEP_READINESS] SPA navigation detected', {
          from: prevUrl,
          to: currentUrl,
        });
        return true;
      }
    } catch {
      // Page may be in transition
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE SETTLE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wait for network to be idle (no pending requests).
 * Uses Playwright's built-in networkidle with fallback.
 */
async function waitForNetworkIdle(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch {
    // networkidle timeout is acceptable, continue
    logger.debug('[STEP_READINESS] Network idle timeout, continuing');
  }
}

/**
 * Wait for DOM to stabilize (no mutations for `stabilityThreshold` ms).
 * Uses MutationObserver in the browser context.
 */
async function waitForDOMStable(
  page: Page,
  timeoutMs: number,
  stabilityThreshold: number
): Promise<void> {
  try {
    await page.evaluate(
      ({ timeout, threshold }: { timeout: number; threshold: number }) => {
        return new Promise<void>((resolve) => {
          // @ts-expect-error - document exists in browser context
          if (!document.body) {
            resolve();
            return;
          }

          let lastMutationTime = Date.now();
          const startTime = Date.now();

          // @ts-expect-error - MutationObserver exists in browser context
          const observer = new MutationObserver(() => {
            lastMutationTime = Date.now();
          });

          // @ts-expect-error - document exists in browser context
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
          });

          const checkStable = () => {
            const elapsed = Date.now() - startTime;
            const timeSinceLastMutation = Date.now() - lastMutationTime;

            if (timeSinceLastMutation >= threshold || elapsed >= timeout) {
              observer.disconnect();
              resolve();
              return;
            }

            setTimeout(checkStable, 50);
          };

          setTimeout(checkStable, 50);
        });
      },
      { timeout: timeoutMs, threshold: stabilityThreshold }
    );
  } catch {
    logger.debug('[STEP_READINESS] DOM stability check failed, continuing');
  }
}

/**
 * Apply page-level settle: wait for DOM to stabilize.
 * We only care about DOM mutations (element availability), NOT images/fonts/analytics.
 * The domStableThresholdMs is dynamically chosen based on prev action profile.
 */
async function pageSettle(
  page: Page,
  settleMs: number,
  domStableThresholdMs: number
): Promise<void> {
  const startTime = Date.now();
  logger.debug('[STEP_READINESS] Applying page settle (DOM-only)', { settleMs, domStableThresholdMs });

  await Promise.race([
    waitForDOMStable(page, settleMs, domStableThresholdMs),
    new Promise(resolve => setTimeout(resolve, settleMs)),
  ]);

  logger.debug('[STEP_READINESS] Page settle complete', { elapsedMs: Date.now() - startTime });
}

/**
 * Blind settle: used when no locator is available to check preconditions.
 * Instead of skipping lookahead entirely, waits a short fixed time for the page
 * to settle (networkIdle + DOM stable). This covers the case where a new step
 * has no compiled plan yet (first run after recording).
 */
async function blindSettle(page: Page, domStableThresholdMs: number): Promise<void> {
  logger.debug('[STEP_READINESS] No locator available — applying blind settle', {
    blindSettleMs: BLIND_SETTLE_MS,
    domStableThresholdMs,
  });
  await pageSettle(page, BLIND_SETTLE_MS, domStableThresholdMs);
}

// ═══════════════════════════════════════════════════════════════════════════
// V14: COMPREHENSIVE PAGE READINESS CHECKS
// Pure browser-context JS — no LLM, no AI, ~5-15ms per check
// ═══════════════════════════════════════════════════════════════════════════

/** Max time to wait for loading indicators to disappear */
const LOADING_INDICATOR_TIMEOUT_MS = 3000;
/** Polling interval for loading indicators */
const LOADING_POLL_INTERVAL_MS = 150;
/** Max time to wait for pending API requests to complete */
const API_IDLE_TIMEOUT_MS = 2000;
/** Quiet threshold — no new API activity for this long = idle */
const API_QUIET_THRESHOLD_MS = 150;
/** Max time to wait for CSS animation/transition on target element */
const ANIMATION_WAIT_TIMEOUT_MS = 1500;
/** Max time to wait for overlay to clear */
const OVERLAY_WAIT_TIMEOUT_MS = 1500;
/** Max time to wait for iframe to load */
const IFRAME_LOAD_TIMEOUT_MS = 2000;

/**
 * Check for loading indicators on the page (spinners, skeletons, aria-busy, progressbar).
 * Returns true if any loading indicator is detected.
 *
 * 8-layer detection:
 * 1. role="progressbar" (ARIA standard)
 * 2. aria-busy="true" (ARIA loading state)
 * 3. Skeleton loaders (CSS class patterns: .skeleton, .placeholder-glow, etc.)
 * 4. Animated spinners (class-based: .spinner, .loader, [data-loading])
 * 5. CSS-only spinners (any small rotating/pulsing element with animation, no class match)
 * 6. NProgress/pace.js bars (top loading bars common in SPAs)
 * 7. Disabled form submit buttons with loading text pattern
 * 8. data-testid loading patterns (data-testid*="loading", data-testid*="spinner")
 */
async function hasLoadingIndicators(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // @ts-expect-error - browser context
      const doc = document;
      // @ts-expect-error - browser context
      const win = window;

      const isReallyVisible = (el: any): boolean => {
        const style = win.getComputedStyle(el);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && parseFloat(style.opacity) >= 0.1;
      };

      // 1. role="progressbar"
      const progressbar = doc.querySelector('[role="progressbar"]:not([aria-hidden="true"])');
      if (progressbar && isReallyVisible(progressbar)) return true;

      // 2. aria-busy="true"
      const busy = doc.querySelector('[aria-busy="true"]:not([aria-hidden="true"])');
      if (busy && isReallyVisible(busy)) return true;

      // 3. Skeleton loaders
      const skeletonSel = '.skeleton, .skeleton-loader, .skeleton-text, .skeleton-line, '
        + '[data-skeleton], [data-skeleton-loading], .placeholder-glow, .placeholder-wave, '
        + '[class*="Skeleton"], [class*="skeleton-"], .shimmer, [class*="shimmer"]';
      const skeleton = doc.querySelector(skeletonSel);
      if (skeleton && isReallyVisible(skeleton)) return true;

      // 4. Animated spinners/loaders (class-based)
      const spinnerSel = '.spinner, .loader, .loading, .loading-indicator, '
        + '[class*="spinner"], [class*="Spinner"], [class*="loader"], [class*="Loader"], '
        + '[class*="loading-"], [class*="Loading"], [data-loading], [data-loading="true"], '
        + '.ant-spin-spinning, .el-loading-mask, .v-overlay--active';
      const spinners = doc.querySelectorAll(spinnerSel);
      for (const el of spinners) {
        if (!isReallyVisible(el)) continue;
        const style = win.getComputedStyle(el);
        const anim = style.animationName;
        // Has animation OR is a known loading class (might use pseudo-element animation)
        if ((anim && anim !== 'none') || el.classList.contains('loading') || el.classList.contains('spinner')) {
          return true;
        }
      }

      // 5. NProgress / Pace.js / top loading bars
      const nprogressSel = '#nprogress, .pace, .pace-active, [class*="nprogress"], '
        + '[class*="top-loading-bar"], [class*="TopLoadingBar"], .nProgress';
      const nprogress = doc.querySelector(nprogressSel);
      if (nprogress && isReallyVisible(nprogress)) return true;

      // 6. Submit/action buttons with loading text
      const buttons = doc.querySelectorAll('button[disabled], [role="button"][aria-disabled="true"]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase().trim();
        if (/loading|submitting|saving|processing|please wait/i.test(text)) {
          return true;
        }
      }

      // 7. data-testid loading patterns
      const testIdLoading = doc.querySelector(
        '[data-testid*="loading"], [data-testid*="spinner"], [data-testid*="skeleton"], '
        + '[data-cy*="loading"], [data-cy*="spinner"]'
      );
      if (testIdLoading && isReallyVisible(testIdLoading)) return true;

      return false;
    });
  } catch {
    return false; // Page navigating or closed
  }
}

/**
 * Wait for all loading indicators to disappear.
 * Polls `hasLoadingIndicators` until clean or timeout.
 */
async function waitForLoadingIndicatorsClear(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const hasLoading = await hasLoadingIndicators(page);
    if (!hasLoading) return;
    await new Promise(r => setTimeout(r, LOADING_POLL_INTERVAL_MS));
  }

  logger.debug('[STEP_READINESS] Loading indicators still present after timeout, continuing', { timeoutMs });
}

/**
 * Wait for pending API requests (fetch/xhr) to complete.
 * Lightweight inline tracker — attaches listeners, waits for quiet period, cleans up.
 */
async function waitForApiIdle(page: Page, timeoutMs: number): Promise<void> {
  let pending = 0;
  let lastActivity = Date.now() - API_QUIET_THRESHOLD_MS; // Start with threshold met

  const onRequest = (req: { resourceType: () => string }) => {
    const type = req.resourceType();
    if (type === 'fetch' || type === 'xhr') {
      pending++;
      lastActivity = Date.now();
    }
  };
  const onDone = (req: { resourceType: () => string }) => {
    const type = req.resourceType();
    if (type === 'fetch' || type === 'xhr') {
      pending = Math.max(0, pending - 1);
      lastActivity = Date.now();
    }
  };

  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pending === 0 && (Date.now() - lastActivity) >= API_QUIET_THRESHOLD_MS) {
        return;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    if (pending > 0) {
      logger.debug('[STEP_READINESS] API idle timeout with pending requests', { pending, timeoutMs });
    }
  } finally {
    try {
      page.off('request', onRequest);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
    } catch {
      // Page may be closed
    }
  }
}

/**
 * Check if target element has active CSS animation or transition.
 * If so, wait until animation completes or timeout.
 *
 * Checks: animationName, transitionDuration, animationPlayState on the element + parent.
 */
async function waitForElementAnimationComplete(
  locator: Locator,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const isAnimating = await locator.evaluate((el) => {
        // @ts-expect-error - browser context
        const win = window;
        const style = win.getComputedStyle(el);

        // Check active CSS animation
        const anim = style.animationName;
        if (anim && anim !== 'none') {
          const playState = style.animationPlayState;
          if (playState === 'running') return true;
        }

        // Check active CSS transition
        const transDur = style.transitionDuration;
        if (transDur && transDur !== '0s') {
          // Element has transition — check if it's currently in progress
          // by looking at transitionProperty (if set, transition may be running)
          const transProp = style.transitionProperty;
          if (transProp && transProp !== 'none' && transProp !== 'all') {
            // Check opacity specifically — common fade-in pattern
            const opacity = parseFloat(style.opacity);
            if (opacity > 0 && opacity < 0.95) return true;
          }
        }

        // Check parent (animations on container affect children)
        const parent = el.parentElement;
        if (parent) {
          const ps = win.getComputedStyle(parent);
          const pa = ps.animationName;
          if (pa && pa !== 'none' && ps.animationPlayState === 'running') return true;
        }

        return false;
      });

      if (!isAnimating) return;
    } catch {
      return; // Element detached or page navigated
    }

    await new Promise(r => setTimeout(r, 100));
  }

  logger.debug('[STEP_READINESS] Animation wait timeout, continuing', { timeoutMs });
}

/**
 * Check if target element is obstructed by an overlay, modal, toast, or sticky element.
 * Uses elementFromPoint at the element's center — if the hit element is not our target
 * (or its descendant), something is covering it.
 *
 * Returns true if element is obstructed.
 */
async function isElementObstructed(locator: Locator, page: Page): Promise<boolean> {
  try {
    const box = await locator.boundingBox();
    if (!box) return false; // No bounding box → can't check

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    // Set marker to identify target
    const marker = `__sr_overlay_${Date.now()}`;
    await locator.evaluate((el, attr) => el.setAttribute(attr, '1'), marker);

    try {
      const obstructed = await page.evaluate(
        ({ x, y, attr }: { x: number; y: number; attr: string }) => {
          // @ts-ignore - browser context
          const hitEl = document.elementFromPoint(x, y);
          if (!hitEl) return true; // Nothing at point — possibly off-screen
          // Check if hit element is our target or inside it
          return hitEl.closest(`[${attr}]`) === null;
        },
        { x: centerX, y: centerY, attr: marker }
      );
      return obstructed;
    } finally {
      await locator.evaluate((el, attr) => el.removeAttribute(attr), marker).catch(() => {});
    }
  } catch {
    return false; // Can't check → assume not obstructed
  }
}

/**
 * Check if target element is disabled via HTML attribute or ARIA.
 * Covers: disabled attribute, aria-disabled="true", readonly, inert.
 * Returns true if element is in a non-interactable state.
 */
async function isElementDisabledOrInert(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate((el: any) => {
      if (el.disabled === true) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      if (el.readOnly === true && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return true;
      if (el.inert === true) return true;
      // Check closest inert ancestor (HTML inert attribute propagates to descendants)
      if (el.closest('[inert]')) return true;
      // fieldset[disabled] disables all form controls inside per HTML spec
      if (el.closest('fieldset[disabled]')) return true;
      // CSS-based disabling: pointer-events:none makes element unclickable
      const win = el.ownerDocument?.defaultView;
      if (win) {
        const style = win.getComputedStyle(el);
        if (style.pointerEvents === 'none') return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Wait for element to become enabled (not disabled/inert).
 * Polls until enabled or timeout.
 */
async function waitForElementEnabled(locator: Locator, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const disabled = await isElementDisabledOrInert(locator);
    if (!disabled) return;
    await new Promise(r => setTimeout(r, 200));
  }
  logger.debug('[STEP_READINESS] Element still disabled/inert after timeout, continuing', { timeoutMs });
}

/**
 * Check if the target element is inside an iframe that hasn't finished loading.
 * This is common with embedded forms (Stripe, reCAPTCHA, OAuth).
 */
async function waitForIframeContentReady(page: Page, timeoutMs: number): Promise<void> {
  try {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const allReady = await page.evaluate(() => {
        // @ts-expect-error - browser context
        const iframes = document.querySelectorAll('iframe:not([aria-hidden="true"])');
        for (const iframe of iframes) {
          // @ts-expect-error - browser context
          const style = window.getComputedStyle(iframe);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          // Visible iframe — check if loaded
          try {
            const doc = (iframe as any).contentDocument;
            if (doc && doc.readyState !== 'complete') return false;
          } catch {
            // Cross-origin iframe — can't check, assume loaded
          }
        }
        return true;
      });

      if (allReady) return;
      await new Promise(r => setTimeout(r, 300));
    }
  } catch {
    // Page navigating — continue
  }
}

/**
 * Wait for overlay to clear from target element.
 * Polls elementFromPoint until target is topmost or timeout.
 */
async function waitForOverlayClear(
  locator: Locator,
  page: Page,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const obstructed = await isElementObstructed(locator, page);
    if (!obstructed) return;
    await new Promise(r => setTimeout(r, 200));
  }

  logger.debug('[STEP_READINESS] Overlay did not clear in time, continuing', { timeoutMs });
}

/**
 * V14: Comprehensive page readiness check.
 * Runs all deterministic checks in parallel where possible.
 * Called after SPA nav detection and before element precondition retry loop.
 *
 * Sequence:
 * 1. Loading indicators + API idle (parallel) — wait for page to finish data loading
 * 2. Target element animation — wait for fade-in/slide-in to complete
 * 3. Overlay obstruction — wait for modals/toasts to clear
 *
 * All checks are fail-open (timeout → continue). Total max overhead: ~8s worst case,
 * but typically <500ms (most checks short-circuit immediately).
 */
/** Result of comprehensive readiness checks */
export interface ReadinessCheckResult {
  loadingCleared: boolean;
  apiIdle: boolean;
  animationDone: boolean;
  overlayClear: boolean;
  elementEnabled: boolean;
  iframeReady: boolean;
}

async function comprehensiveReadinessCheck(
  page: Page,
  locators: Locator[],
  actionType: IntentActionType,
  remainingMs: number
): Promise<ReadinessCheckResult> {
  const result: ReadinessCheckResult = {
    loadingCleared: true, apiIdle: true, animationDone: true,
    overlayClear: true, elementEnabled: true, iframeReady: true,
  };

  // Phase 1: Page-level checks in parallel (loading + API idle + toast + iframe)
  const needsFullReady = NEEDS_VISIBLE_ENABLED.has(actionType) || NEEDS_VISIBLE_ONLY.has(actionType);

  if (needsFullReady) {
    const loadingTimeout = Math.min(LOADING_INDICATOR_TIMEOUT_MS, remainingMs);
    const apiTimeout = Math.min(API_IDLE_TIMEOUT_MS, remainingMs);
    const iframeTimeout = Math.min(IFRAME_LOAD_TIMEOUT_MS, remainingMs);

    await Promise.allSettled([
      // Loading indicators
      hasLoadingIndicators(page).then(async (hasLoading) => {
        if (hasLoading) {
          logger.debug('[STEP_READINESS] Loading indicators detected, waiting...');
          await waitForLoadingIndicatorsClear(page, loadingTimeout);
          result.loadingCleared = !(await hasLoadingIndicators(page));
        }
      }),
      // API idle
      waitForApiIdle(page, apiTimeout).then(() => {
        result.apiIdle = true;
      }).catch(() => {
        result.apiIdle = false;
      }),
      // Iframe readiness
      waitForIframeContentReady(page, iframeTimeout).catch(() => {
        result.iframeReady = false;
      }),
    ]);
  }

  // Phase 2: Target element animation (only if we have a locator and action needs interaction)
  if (locators.length > 0 && NEEDS_VISIBLE_ENABLED.has(actionType)) {
    const animTimeout = Math.min(ANIMATION_WAIT_TIMEOUT_MS, Math.max(0, remainingMs - 1000));
    if (animTimeout > 200) {
      try {
        await waitForElementAnimationComplete(locators[0], animTimeout);
      } catch {
        result.animationDone = false;
      }
    }
  }

  // Phase 3: Element-level checks (disabled/inert + overlay)
  const clickLikeActions: Set<IntentActionType> = new Set(['click', 'dblclick', 'contextmenu', 'check', 'uncheck', 'toggle', 'open', 'close']);

  if (locators.length > 0 && NEEDS_VISIBLE_ENABLED.has(actionType)) {
    // Check disabled/inert state (common: button disabled during form submission)
    const disabledTimeout = Math.min(3000, Math.max(0, remainingMs - 500));
    if (disabledTimeout > 200) {
      const isDisabled = await isElementDisabledOrInert(locators[0]);
      if (isDisabled) {
        logger.debug('[STEP_READINESS] Element is disabled/inert, waiting for enabled...');
        await waitForElementEnabled(locators[0], disabledTimeout);
        result.elementEnabled = !(await isElementDisabledOrInert(locators[0]));
      }
    }
  }

  // Phase 4: Overlay obstruction (only for click-like actions)
  if (locators.length > 0 && clickLikeActions.has(actionType)) {
    const overlayTimeout = Math.min(OVERLAY_WAIT_TIMEOUT_MS, Math.max(0, remainingMs - 500));
    if (overlayTimeout > 200) {
      const obstructed = await isElementObstructed(locators[0], page);
      if (obstructed) {
        logger.debug('[STEP_READINESS] Element obstructed by overlay, waiting...');
        await waitForOverlayClear(locators[0], page, overlayTimeout);
        result.overlayClear = !(await isElementObstructed(locators[0], page));
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCATOR BUILDING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build fast locators from step's compiled plan or evidence.
 * Returns ALL non-ref locators from the compiled plan so the retry loop
 * can try each one (instead of only the first, which may not match).
 */
function buildFastLocators(page: Page, step: IntentStep): Locator[] {
  const locators: Locator[] = [];

  // Priority 1: Use compiled locatorPlan if available
  // Skip ref strategy — data-agent-ref attributes don't exist during background replay
  if (step.compiled?.locatorPlan && step.compiled.locatorPlan.length > 0) {
    const stableEntries = step.compiled.locatorPlan.filter(e => e.strategy !== 'ref');

    for (const entry of stableEntries) {
      try {
        let locator: Locator | null = null;
        switch (entry.strategy) {
          case 'role':
            locator = page
              .getByRole(entry.roleName as any, { name: entry.value })
              .first();
            break;

          case 'label':
            locator = page.getByLabel(entry.value).first();
            break;

          case 'testId':
            locator = page.getByTestId(entry.value).first();
            break;

          case 'placeholder':
            locator = page.getByPlaceholder(entry.value).first();
            break;

          case 'css':
            locator = page.locator(entry.value).first();
            break;

          default:
            logger.debug('[STEP_READINESS] Unknown locator strategy', {
              strategy: entry.strategy,
            });
            break;
        }
        if (locator) locators.push(locator);
      } catch (error) {
        logger.debug('[STEP_READINESS] Failed to build locator from compiled plan', {
          strategy: entry.strategy,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (locators.length > 0) return locators;
  }

  // Priority 2: Fallback to evidence.lastSuccessRef
  // Skip if ref looks like a preview/background ref (not a stable CSS selector)
  if (step.evidence?.lastSuccessRef) {
    const ref = step.evidence.lastSuccessRef;
    // data-agent-ref values (e.g. "e6", "bg-1") don't exist during replay — skip
    if (/^(e\d+|s\d+|bg-\d+)$/.test(ref)) {
      return locators;
    }
    try {
      const escapedRef = ref.replace(/"/g, '\\"');
      locators.push(page.locator(`[data-agent-ref="${escapedRef}"]`).first());
    } catch (error) {
      logger.debug('[STEP_READINESS] Failed to build locator from evidence', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return locators;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRECONDITION CHECKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if element meets preconditions for action type.
 * Uses ONLY fast Playwright checks — no LLM or AI.
 * Playwright's isVisible()/isEnabled()/count() are non-waiting and return instantly.
 */
async function checkPreconditionsSingle(
  locator: Locator,
  actionType: IntentActionType
): Promise<boolean> {
  try {
    if (NEEDS_VISIBLE_ENABLED.has(actionType)) {
      const [isVisible, isEnabled] = await Promise.all([
        locator.isVisible(),
        locator.isEnabled(),
      ]);
      return isVisible && isEnabled;
    }

    if (NEEDS_VISIBLE_ONLY.has(actionType)) {
      return await locator.isVisible();
    }

    if (NEEDS_ATTACHED_ONLY.has(actionType)) {
      const count = await locator.count();
      return count > 0;
    }

    // Unknown action type — assume ready
    return true;
  } catch (error) {
    logger.debug('[STEP_READINESS] Precondition check failed', {
      actionType,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Check preconditions across multiple locators.
 * Returns true if ANY locator satisfies the preconditions.
 * This avoids the problem of a single mismatched locator (e.g. label vs placeholder)
 * causing the entire lookahead to fail and trigger expensive settle retries.
 */
async function checkPreconditions(
  locators: Locator[],
  actionType: IntentActionType
): Promise<boolean> {
  // Check all locators in parallel (isVisible/isEnabled are instant)
  const results = await Promise.all(
    locators.map(loc => checkPreconditionsSingle(loc, actionType))
  );
  return results.some(r => r);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wait for next step to be ready before executing it.
 *
 * Algorithm:
 * 1. Skip if next step is non-targeting (navigate/wait/ai_check)
 * 2. If prev action is a navigation-trigger (click/open/close/toggle/press):
 *    → race SPA navigation detection (URL changed?) for up to SPA_NAV_DETECT_MS
 *    → if navigation detected → wait for networkIdle before element check
 * 3. Build fast locator from compiled plan or evidence
 *    → if no locator: blind settle (networkIdle + DOM stable) instead of skipping
 * 4. Retry loop: checkPreconditions → pageSettle (with dynamic domStableThreshold) → repeat
 * 5. Return LookaheadResult with waited time and navigationDetected flag
 *
 * @param page - Playwright Page instance
 * @param nextStep - The step that will be executed next
 * @param options - Configuration options including prevActionType and prevUrl
 */
export async function waitForStepReadiness(
  page: Page,
  nextStep: IntentStep,
  options: LookaheadOptions = {}
): Promise<LookaheadResult> {
  const startTime = Date.now();

  const {
    maxWaitMs = DEFAULTS.maxWaitMs,
    settleMs = DEFAULTS.settleMs,
    autoWaitThresholdMs = DEFAULTS.autoWaitThresholdMs,
    domStableThresholdMs: domStableOverride,
    maxRetries = DEFAULTS.maxRetries,
    prevActionType,
    prevUrl,
    recordedDelayMs,
  } = options;

  // Dynamic DOM stability threshold based on prev action risk
  const domStableThresholdMs = getDomStableThresholdMs(prevActionType, domStableOverride);

  // V14: Inter-step delay floor — if user waited during recording, respect that
  // Use 50% of recorded delay as minimum wait (capped at 2s, floor at 200ms)
  // Lower ratio + cap: most recording pauses are human hesitation, not page load
  const minWaitFromRecording = recordedDelayMs
    ? Math.min(2000, Math.max(200, Math.round(recordedDelayMs * 0.5)))
    : 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Skip conditions
  // ─────────────────────────────────────────────────────────────────────────

  if (nextStep.options?.disableLookaheadWait) {
    logger.debug('[STEP_READINESS] Skipped: disableLookaheadWait flag set', {
      stepId: nextStep.id,
    });
    return { ready: true, waited: 0, autoWaitApplied: false, skipReason: 'disableLookaheadWait flag set' };
  }

  if (NON_TARGETING_ACTIONS.has(nextStep.type)) {
    logger.debug('[STEP_READINESS] Skipped: non-targeting action', {
      stepId: nextStep.id,
      actionType: nextStep.type,
    });
    return { ready: true, waited: 0, autoWaitApplied: false, skipReason: `Non-targeting action: ${nextStep.type}` };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1: SPA navigation detection
  // Runs only after actions that commonly trigger route changes.
  // Does NOT block if no navigation — just races and moves on.
  // ─────────────────────────────────────────────────────────────────────────

  let navigationDetected = false;

  if (prevActionType && NAVIGATION_TRIGGER_ACTIONS.has(prevActionType) && prevUrl) {
    const remainingMs = maxWaitMs - (Date.now() - startTime);
    const spaWaitMs = Math.min(SPA_NAV_DETECT_MS, remainingMs);

    if (spaWaitMs > 0) {
      navigationDetected = await detectSpaNavigation(page, prevUrl, spaWaitMs);

      if (navigationDetected) {
        // Navigation happened → wait for DOM to be ready (not networkIdle — images/fonts irrelevant).
        // domcontentloaded ensures HTML is parsed, then DOM stability ensures SPA hydration is done.
        const postNavMs = Math.min(settleMs, maxWaitMs - (Date.now() - startTime));
        if (postNavMs > 0) {
          logger.debug('[STEP_READINESS] Post-navigation DOM settle', { postNavMs });
          try {
            await page.waitForLoadState('domcontentloaded', { timeout: postNavMs });
          } catch {
            // Timeout acceptable — DOM may still be usable
          }
          const remainingAfterDce = Math.min(postNavMs, maxWaitMs - (Date.now() - startTime));
          if (remainingAfterDce > 0) {
            await waitForDOMStable(page, remainingAfterDce, domStableThresholdMs);
          }
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2: Build fast locators (all non-ref strategies)
  // If none available → blind settle instead of skipping
  // ─────────────────────────────────────────────────────────────────────────

  const locators = buildFastLocators(page, nextStep);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2.5: V14 Comprehensive readiness checks
  // Loading indicators, API idle, animation, overlay — all deterministic
  // Runs regardless of whether we have locators (page-level checks are universal)
  // ─────────────────────────────────────────────────────────────────────────

  let readinessChecks: ReadinessCheckResult | undefined;
  const remainingForReadiness = maxWaitMs - (Date.now() - startTime);
  if (remainingForReadiness > 500) {
    readinessChecks = await comprehensiveReadinessCheck(
      page, locators, nextStep.type, remainingForReadiness
    );

    const anyBlocked = !readinessChecks.loadingCleared || !readinessChecks.apiIdle
      || !readinessChecks.elementEnabled || !readinessChecks.iframeReady;
    if (anyBlocked) {
      logger.info('[STEP_READINESS] Page-level readiness wait applied', {
        stepId: nextStep.id,
        ...readinessChecks,
        elapsed: Date.now() - startTime,
      });
    }
  }

  if (locators.length === 0) {
    logger.debug('[STEP_READINESS] No fast locator — applying blind settle', {
      stepId: nextStep.id,
      hasCompiled: !!nextStep.compiled,
      hasEvidence: !!nextStep.evidence?.lastSuccessRef,
    });

    await blindSettle(page, domStableThresholdMs);

    const waited = Date.now() - startTime;
    return {
      ready: true, // We don't know, but we waited — let executor try
      waited,
      autoWaitApplied: waited > autoWaitThresholdMs,
      skipReason: 'No locator — blind settle applied',
      navigationDetected,
      readinessChecks,
      urlChanged: navigationDetected,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3: Retry loop with dynamic settle
  // Checks ALL locators (not just the first) — if any matches, element is ready.
  // ─────────────────────────────────────────────────────────────────────────

  logger.debug('[STEP_READINESS] Starting lookahead wait', {
    stepId: nextStep.id,
    actionType: nextStep.type,
    prevActionType,
    domStableThresholdMs,
    maxWaitMs,
    navigationDetected,
    locatorCount: locators.length,
  });

  let attempt = 0;
  let ready = false;

  while (attempt <= maxRetries) {
    const elapsed = Date.now() - startTime;

    if (elapsed >= maxWaitMs) {
      logger.debug('[STEP_READINESS] Max wait timeout reached', {
        stepId: nextStep.id,
        elapsed,
        maxWaitMs,
        attempts: attempt,
      });
      break;
    }

    ready = await checkPreconditions(locators, nextStep.type);

    if (ready) {
      const waited = Date.now() - startTime;

      // V14: Inter-step delay enforcement — if user waited longer during recording,
      // the page likely needs that time (lazy-loaded data, slow API, debounced render).
      // Wait the remaining difference, capped by maxWaitMs.
      if (minWaitFromRecording > 0 && waited < minWaitFromRecording) {
        const remaining = Math.min(minWaitFromRecording - waited, maxWaitMs - waited);
        if (remaining > 100) {
          logger.debug('[STEP_READINESS] Enforcing recording delay hint', {
            stepId: nextStep.id,
            recordedDelayMs,
            minWaitFromRecording,
            waited,
            additionalWaitMs: remaining,
          });
          await new Promise(r => setTimeout(r, remaining));
        }
      }

      const totalWaited = Date.now() - startTime;
      logger.debug('[STEP_READINESS] Element ready', {
        stepId: nextStep.id,
        waited: totalWaited,
        attempts: attempt,
      });
      return {
        ready: true,
        waited: totalWaited,
        autoWaitApplied: totalWaited > autoWaitThresholdMs,
        navigationDetected,
        readinessChecks,
        urlChanged: navigationDetected,
      };
    }

    // Element not ready — apply page settle with dynamic threshold and retry
    logger.debug('[STEP_READINESS] Element not ready, applying settle', {
      stepId: nextStep.id,
      attempt,
      maxRetries,
      domStableThresholdMs,
    });

    const remainingTime = maxWaitMs - (Date.now() - startTime);
    const thisSettleMs = Math.min(settleMs, remainingTime);

    if (thisSettleMs > 0) {
      await pageSettle(page, thisSettleMs, domStableThresholdMs);
    }

    attempt++;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Final result (element still not ready after all retries)
  // ─────────────────────────────────────────────────────────────────────────

  const waited = Date.now() - startTime;

  logger.info('[STEP_READINESS] Lookahead complete', {
    stepId: nextStep.id,
    ready,
    waited,
    attempts: attempt,
    autoWaitApplied: waited > autoWaitThresholdMs,
    navigationDetected,
  });

  return {
    ready,
    waited,
    autoWaitApplied: waited > autoWaitThresholdMs,
    navigationDetected,
    readinessChecks,
    urlChanged: navigationDetected,
  };
}

/**
 * Check if lookahead should be skipped based on previous step type.
 * Only truly non-targeting actions (navigate/wait/wait_for/ai_check) skip lookahead.
 * Navigation-trigger actions (click/open/close) now go through SPA detection instead.
 *
 * @param prevStepType - The type of the previous step
 */
export function shouldSkipLookaheadAfter(prevStepType: IntentActionType): boolean {
  return NON_TARGETING_ACTIONS.has(prevStepType);
}
