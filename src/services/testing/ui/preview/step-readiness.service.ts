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
  /**
   * V15: Optional tracer for lookahead phase observability. When provided, each
   * phase boundary emits a structured event — this is what lets operators answer
   * "where did those 15 seconds go?" from the trace alone instead of combing
   * through stdout. Callback shape matches EditorTraceService.writeLookahead* but
   * we keep it structural here to avoid a circular import.
   */
  tracer?: LookaheadTracer;
}

/**
 * V15: Lookahead tracer contract. Implement this (or pass the matching
 * EditorTraceService methods) to get structured visibility into the
 * inter-step wait. All methods are fire-and-forget — never throw.
 */
export interface LookaheadTracer {
  start(data: {
    nextStepId: string;
    nextActionType: string;
    prevActionType?: string;
    prevUrl?: string;
    maxWaitMs: number;
    settleMs: number;
    recordedDelayMs?: number;
    plannedLocatorStrategies?: string[];
  }): void;
  phase(data: {
    phase: string;
    durationMs: number;
    details?: Record<string, any>;
    hardCapHit?: boolean;
  }): void;
  end(data: {
    nextStepId: string;
    ready: boolean;
    totalDurationMs: number;
    autoWaitApplied: boolean;
    skipReason?: string;
    navigationDetected?: boolean;
    urlChanged?: boolean;
    xhrInflightAtHandoff?: { count: number; urls: string[] };
  }): void;
  /** V15.1: Per-attempt diagnostic inside the retry loop. Optional (old callers compile). */
  retryAttempt?(data: {
    nextStepId: string;
    attempt: number;
    locatorCount: number;
    perLocator: Array<{
      index: number;
      strategy?: string;
      value?: string;
      isVisible?: boolean;
      isVisibleMs?: number;
      isEnabled?: boolean;
      isEnabledMs?: number;
      count?: number;
      countMs?: number;
      hardCapHit?: boolean;
      ready: boolean;
    }>;
    totalMs: number;
    ready: boolean;
  }): void;
  /** V15.1: `pageSettle` timing between retry attempts. Optional. */
  pageSettle?(data: {
    context: 'retry_loop' | 'blind_settle' | 'post_nav';
    budgetMs: number;
    actualMs: number;
    domStableThresholdMs: number;
    budgetExhausted: boolean;
  }): void;
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

          // Attribute names that indicate CSS animation/transition (not structural change)
          const animationAttrs = new Set(['class', 'style', 'aria-hidden', 'data-state', 'data-active']);

          // @ts-expect-error - MutationObserver exists in browser context
          const observer = new MutationObserver((mutations: any[]) => {
            // Only count structural mutations (node add/remove) and meaningful attribute changes.
            // Ignore CSS animation noise (class/style toggling, aria-hidden transitions).
            for (const m of mutations) {
              if (m.type === 'childList') {
                // Structural: node added or removed — always counts
                lastMutationTime = Date.now();
                return;
              }
              if (m.type === 'attributes' && !animationAttrs.has(m.attributeName)) {
                // Meaningful attribute change (e.g. value, src, href, disabled)
                lastMutationTime = Date.now();
                return;
              }
            }
          });

          // @ts-expect-error - document exists in browser context
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: undefined, // Observe all, filter in callback
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
 * V15: Hard cap on a single locator.evaluate() / page.evaluate() inside the readiness
 * pipeline. Playwright's default actionTimeout (30s) can fire twice in a row
 * (animationComplete + isDisabledOrInert) when a compiled-plan locator does not
 * match after SPA navigation — producing the observed 60s stall between steps.
 * This cap guarantees the readiness check itself never exceeds its own budget,
 * regardless of global actionTimeout settings.
 */
const EVALUATE_HARD_CAP_MS = 500;

/**
 * V15: Race any async operation against a short deadline. Used to cap
 * locator.evaluate() / page.evaluate() inside the readiness check so a
 * non-matching locator can never monopolize the inter-step budget.
 * On timeout, resolves with the provided `onTimeout` value (fail-open).
 */
async function withHardCap<T>(
  op: () => Promise<T>,
  capMs: number,
  onTimeout: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(onTimeout), capMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * V15: Quick "is this locator actually in the DOM right now?" check.
 * Uses locator.count() which is non-waiting in Playwright. Wrapped in a hard cap
 * because count() can still block during CDP roundtrips on a busy page.
 * Returns false on any failure — callers use this as a skip gate, not a signal.
 */
async function isLocatorAttachedFast(locator: Locator): Promise<boolean> {
  try {
    const count = await withHardCap(() => locator.count(), 250, -1);
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * V15: Shadow DOM diagnostic.
 * Called when the compiled locator is NOT attached. Playwright's user-facing locators
 * (getByLabel / getByRole / getByPlaceholder / getByTestId / getByText) automatically
 * pierce OPEN shadow roots — so if the locator miss is due to shadow DOM, it's usually
 * either (a) a CSS locator that didn't opt in, or (b) a CLOSED shadow root (rare).
 *
 * We don't try to auto-recover — Playwright already handles the common case. Instead
 * we surface a diagnostic so operators can see the page is shadow-heavy and the
 * compiled plan may need a `getBy*` strategy instead of raw CSS.
 *
 * Returns { present, customTags, count } — all numbers bounded. Fail-open empty.
 */
interface ShadowDomInfo {
  present: boolean;
  /** Custom-element tags seen on the page (indicates web-component usage). Max 5 samples. */
  customTags: string[];
  /** Open shadow roots counted via tree-walk. Bounded at 50 to avoid runaway. */
  openRoots: number;
  /** Host elements whose shadowRoot is null (likely closed, or native like <details>). */
  nullRootsOnCustom: number;
}
async function probeShadowDom(page: Page): Promise<ShadowDomInfo> {
  const empty: ShadowDomInfo = { present: false, customTags: [], openRoots: 0, nullRootsOnCustom: 0 };
  try {
    return await withHardCap(() => page.evaluate(() => {
      // @ts-expect-error - browser context
      const doc = document;
      const customTagsSet = new Set<string>();
      let openRoots = 0;
      let nullRootsOnCustom = 0;
      const MAX_SCAN = 50; // bound the walk
      // Breadth-first scan through the light DOM + any open shadow roots we find
      const stack: any[] = [doc.body];
      let scanned = 0;
      while (stack.length && scanned < MAX_SCAN) {
        const node: any = stack.shift();
        if (!node) continue;
        scanned++;
        const children = node.children as ArrayLike<any> | undefined;
        if (!children) continue;
        for (let i = 0; i < children.length; i++) {
          const el: any = children[i];
          const tag: string = (el.tagName || '').toLowerCase();
          if (tag.includes('-')) customTagsSet.add(tag);
          const sr = el.shadowRoot;
          if (sr) { openRoots++; stack.push(sr); }
          else if (tag.includes('-')) { nullRootsOnCustom++; }
          stack.push(el);
        }
      }
      return {
        present: openRoots > 0 || customTagsSet.size > 0,
        customTags: Array.from(customTagsSet).slice(0, 5),
        openRoots: Math.min(openRoots, MAX_SCAN),
        nullRootsOnCustom: Math.min(nullRootsOnCustom, MAX_SCAN),
      };
    }), 400, empty);
  } catch {
    return empty;
  }
}

/**
 * V15: Challenge-page detector (Cloudflare, reCAPTCHA interstitial, Vercel "just a moment").
 * Called before the main readiness pipeline. On match, callers should widen the URL-change
 * budget instead of waiting for elements on the challenge page — the challenge will redirect
 * when done, and the target page's DOM will only exist after the redirect.
 *
 * Detection is structural (URL patterns + well-known selectors) — fail-open empty on any
 * error so a probe failure never breaks a normal run.
 */
interface ChallengePageInfo {
  detected: boolean;
  /** Human-readable tag for logs. 'cloudflare' | 'recaptcha' | 'vercel' | 'generic-interstitial' */
  kind?: string;
}
async function detectChallengePage(page: Page): Promise<ChallengePageInfo> {
  const none: ChallengePageInfo = { detected: false };
  try {
    const url = page.url();
    // URL-based early exit (no DOM roundtrip needed)
    if (/\/cdn-cgi\/(challenge-platform|trace)/i.test(url)) return { detected: true, kind: 'cloudflare' };
    if (/^https?:\/\/challenges\.cloudflare\.com\//i.test(url)) return { detected: true, kind: 'cloudflare' };

    // DOM probe — cheap, capped at 400ms
    return await withHardCap(() => page.evaluate(() => {
      // @ts-expect-error - browser context
      const doc = document;
      // Cloudflare: challenge-running hook, cf-browser-verification, or turnstile wrapper
      if (doc.querySelector('#cf-challenge-running, .cf-browser-verification, #challenge-form, [id*="cf-turnstile"]')) {
        return { detected: true, kind: 'cloudflare' };
      }
      // reCAPTCHA full-page interstitial (not inline widget — those are fine)
      const recapFrames = doc.querySelectorAll('iframe[src*="recaptcha"]');
      if (recapFrames.length > 0) {
        // Heuristic: interstitial = recaptcha iframe covers >50% viewport
        for (let i = 0; i < recapFrames.length; i++) {
          const f: any = recapFrames[i];
          const r = f.getBoundingClientRect();
          // @ts-expect-error - window in browser context
          const vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
          if (r.width * r.height > vw * vh * 0.5) return { detected: true, kind: 'recaptcha' };
        }
      }
      // Vercel "Just a moment" / generic verification wall
      const text = (doc.body?.innerText || '').toLowerCase();
      if (/checking your browser|just a moment|verifying you are human|please wait while we verify/i.test(text)) {
        return { detected: true, kind: 'generic-interstitial' };
      }
      return { detected: false };
    }), 400, none);
  } catch {
    return none;
  }
}

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
    // V15: Hard-cap — page.evaluate can stall during SPA bootstrap/hydration
    // when Angular/React has not yet yielded the main thread. Fail-open = "no loader".
    return await withHardCap(() => page.evaluate(() => {
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
    }), EVALUATE_HARD_CAP_MS, false);
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
 *
 * Filters out third-party requests (analytics, tracking, monitoring) to prevent
 * endless waits caused by Google Analytics, Intercom, Sentry, etc.
 * Reuses THIRD_PARTY_DOMAINS from third-party-blocker for consistency.
 */
export async function waitForApiIdle(page: Page, timeoutMs: number): Promise<void> {
  // Lazy-load to avoid circular dependency
  let thirdPartyDomains: readonly string[] = [];
  try {
    const { THIRD_PARTY_DOMAINS } = await import('@/agent/playwright/execution/third-party-blocker');
    thirdPartyDomains = THIRD_PARTY_DOMAINS;
  } catch { /* non-critical — proceed without filter */ }

  // Get page origin for same-origin check
  let pageOrigin = '';
  try { pageOrigin = new URL(page.url()).origin; } catch { /* proceed without origin filter */ }

  let pending = 0;
  let lastActivity = Date.now() - API_QUIET_THRESHOLD_MS; // Start with threshold met

  /** Check if request URL is a third-party domain (analytics, tracking, etc.) */
  const isThirdPartyRequest = (url: string): boolean => {
    try {
      const hostname = new URL(url).hostname;
      return thirdPartyDomains.some(domain => hostname.includes(domain));
    } catch { return false; }
  };

  /** Check if request URL is same-origin as the page being tested */
  const isSameOrigin = (url: string): boolean => {
    if (!pageOrigin) return true; // No origin = can't filter, count all
    try { return new URL(url).origin === pageOrigin; } catch { return false; }
  };

  // Track which requests we're actually waiting for (by URL) to avoid counter leaks.
  // Only relevant requests get tracked; their completion always decrements pending.
  const trackedRequests = new Set<string>();

  /** Check base eligibility: fetch/xhr + same-origin + not third-party */
  const isEligibleRequest = (req: { resourceType: () => string; url: () => string }): boolean => {
    const type = req.resourceType();
    if (type !== 'fetch' && type !== 'xhr') return false;
    const url = req.url();
    if (isThirdPartyRequest(url)) return false;
    if (!isSameOrigin(url)) return false;
    return true;
  };

  const onRequest = (req: { resourceType: () => string; url: () => string; method?: () => string }) => {
    if (!isEligibleRequest(req)) return;
    const method = typeof req.method === 'function' ? req.method() : 'GET';
    // Always track mutating requests — step likely triggered them
    // For GET: only track if it's not a known polling pattern (same URL seen before)
    const url = req.url();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) || !trackedRequests.has(url)) {
      trackedRequests.add(url);
      pending++;
      lastActivity = Date.now();
    }
  };
  const onDone = (req: { resourceType: () => string; url: () => string }) => {
    const url = req.url();
    if (trackedRequests.has(url)) {
      trackedRequests.delete(url);
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
      // V15: Hard-cap locator.evaluate — Playwright's default actionTimeout (30s)
      // kicks in when the locator doesn't match, which alone is longer than this
      // function's entire budget. Fail-open on timeout = "assume not animating".
      const isAnimating = await withHardCap(() => locator.evaluate((el) => {
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
      }), EVALUATE_HARD_CAP_MS, false);

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
    // V15: boundingBox() waits for locator to be visible (up to default actionTimeout).
    // Hard-cap it so a stale ref can't eat 30s. Null return = no bbox = skip check.
    const box = await withHardCap(() => locator.boundingBox(), EVALUATE_HARD_CAP_MS, null);
    if (!box) return false; // No bounding box → can't check

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    // Set marker to identify target
    const marker = `__sr_overlay_${Date.now()}`;
    const attrSet = await withHardCap(
      () => locator.evaluate((el, attr) => el.setAttribute(attr, '1'), marker).then(() => true),
      EVALUATE_HARD_CAP_MS,
      false,
    );
    if (!attrSet) return false; // Can't tag element → skip obstruction check

    try {
      const obstructed = await withHardCap(() => page.evaluate(
        ({ x, y, attr }: { x: number; y: number; attr: string }) => {
          // @ts-ignore - browser context
          const hitEl = document.elementFromPoint(x, y);
          if (!hitEl) return true; // Nothing at point — possibly off-screen
          // Check if hit element is our target or inside it
          return hitEl.closest(`[${attr}]`) === null;
        },
        { x: centerX, y: centerY, attr: marker }
      ), EVALUATE_HARD_CAP_MS, false);
      return obstructed;
    } finally {
      // Best-effort cleanup — don't block on it
      withHardCap(
        () => locator.evaluate((el, attr) => el.removeAttribute(attr), marker),
        EVALUATE_HARD_CAP_MS,
        undefined,
      ).catch(() => {});
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
    // V15: Hard-cap the evaluate. If the locator doesn't match (stale ref, compiled
    // plan miss, SPA mid-hydration), Playwright would otherwise wait 30s for it to
    // appear — blowing the whole readiness budget. Fail-open on timeout = "assume enabled".
    return await withHardCap(() => locator.evaluate((el: any) => {
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
    }), EVALUATE_HARD_CAP_MS, false);
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
      // V15: Hard-cap — same reasoning as hasLoadingIndicators. Fail-open = "ready"
      // so the outer loop exits and the caller continues.
      const allReady = await withHardCap(() => page.evaluate(() => {
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
      }), EVALUATE_HARD_CAP_MS, true);

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

  // Phase 1: Page-level checks in parallel (visible loaders + iframe)
  const needsFullReady = NEEDS_VISIBLE_ENABLED.has(actionType) || NEEDS_VISIBLE_ONLY.has(actionType);

  // V15: Passive XHR observer — counts in-flight fetch/xhr for diagnostics only.
  // NOT a blocker. Rationale: waiting for API idle proved to be redundant in practice:
  //   - visible loaders / skeletons are caught by hasLoadingIndicators
  //   - disabled forms are caught by isElementDisabledOrInert
  //   - elements not yet rendered are caught by the Phase 3 retry loop (isVisible/isEnabled)
  //   - Playwright's own .fill()/.click() actionability is the final safety net
  // API-idle additionally has blind spots (cross-origin APIs, WebSocket, SSE) and false
  // "immediately idle" states when the XHR fires *after* our check starts. We log what
  // was in flight so regressions can be diagnosed, but do not wait on it.
  const inflight = new Set<string>();
  let pageOrigin = '';
  try { pageOrigin = new URL(page.url()).origin; } catch { /* non-critical */ }
  const onReq = (req: { resourceType: () => string; url: () => string }) => {
    const type = req.resourceType();
    if (type !== 'fetch' && type !== 'xhr') return;
    const url = req.url();
    // Same-origin only for signal — cross-origin observers add noise
    if (pageOrigin) {
      try { if (new URL(url).origin !== pageOrigin) return; } catch { return; }
    }
    inflight.add(url);
  };
  const onDone = (req: { url: () => string }) => { inflight.delete(req.url()); };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  try {
  if (needsFullReady) {
    const loadingTimeout = Math.min(LOADING_INDICATOR_TIMEOUT_MS, remainingMs);
    const iframeTimeout = Math.min(IFRAME_LOAD_TIMEOUT_MS, remainingMs);

    await Promise.allSettled([
      // Visible loading indicators (spinners, skeletons, aria-busy, progressbar).
      // This is the real signal that the page is still loading data — much more
      // reliable than raw XHR counting, because it reflects UX state.
      hasLoadingIndicators(page).then(async (hasLoading) => {
        if (hasLoading) {
          logger.debug('[STEP_READINESS] Loading indicators detected, waiting...');
          await waitForLoadingIndicatorsClear(page, loadingTimeout);
          result.loadingCleared = !(await hasLoadingIndicators(page));
        }
      }),
      // Iframe readiness (Stripe, reCAPTCHA, OAuth popups)
      waitForIframeContentReady(page, iframeTimeout).catch(() => {
        result.iframeReady = false;
      }),
    ]);
  }

  // V15: Pre-check — is the target locator actually in the DOM right now?
  // Compiled-plan label/placeholder locators often miss on a freshly navigated SPA
  // page (Angular mid-hydration). If the locator isn't attached, animation/disabled/
  // overlay checks on it would each pay Playwright's 30s action timeout, blowing
  // the entire readiness budget. Skip element-level checks in that case — the outer
  // retry loop in waitForStepReadiness will handle waiting for the element itself.
  const targetAttached = locators.length > 0
    ? await isLocatorAttachedFast(locators[0])
    : false;

  // V15: Shadow DOM diagnostic — when the locator isn't attached, check if the page
  // uses web components. Playwright's getByLabel/getByRole/etc. auto-pierce OPEN shadow
  // roots, so a miss usually means either: (a) closed shadow root, or (b) the compiled
  // plan uses raw CSS that didn't opt in. We don't auto-recover — just log the signal
  // so operators can see shadow-heavy pages and tune locator strategy if needed.
  if (locators.length > 0 && !targetAttached) {
    const shadow = await probeShadowDom(page);
    if (shadow.present) {
      logger.info('[STEP_READINESS] Locator not attached on shadow-DOM page', {
        openRoots: shadow.openRoots,
        customTags: shadow.customTags,
        nullRootsOnCustom: shadow.nullRootsOnCustom,
        hint: 'If the next step fails to find the element, prefer getByRole/getByLabel/getByPlaceholder over raw CSS — they auto-pierce open shadow roots.',
      });
    }
  }

  // Phase 2: Target element animation (only if we have a locator and action needs interaction)
  if (targetAttached && NEEDS_VISIBLE_ENABLED.has(actionType)) {
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

  if (targetAttached && NEEDS_VISIBLE_ENABLED.has(actionType)) {
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
  if (targetAttached && clickLikeActions.has(actionType)) {
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
  } finally {
    // V15: Diagnostic log only — we do NOT wait on these. Surfaces slow APIs
    // so regressions can be traced without blocking the step pipeline.
    if (inflight.size > 0) {
      logger.debug('[STEP_READINESS] XHR still in flight (not blocking)', {
        count: inflight.size,
        urls: Array.from(inflight).slice(0, 5),
      });
    }
    try {
      page.off('request', onReq);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
    } catch { /* page may be closed */ }
  }
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
/**
 * V15.1: Diagnostic payload for a single locator's precondition check. Exposed
 * so the retry loop can emit per-locator events into the trace.
 */
interface PreconditionDiag {
  ready: boolean;
  isVisible?: boolean;
  isVisibleMs?: number;
  isEnabled?: boolean;
  isEnabledMs?: number;
  count?: number;
  countMs?: number;
  hardCapHit?: boolean;
}

async function checkPreconditionsSingle(
  locator: Locator,
  actionType: IntentActionType,
  diag?: PreconditionDiag,
): Promise<boolean> {
  // V15 CRITICAL FIX: Playwright's Locator.isVisible() / isEnabled() are NOT
  // non-waiting when the locator doesn't match. They run actionability checks
  // (including state polling) with the default actionTimeout (30s). A stale or
  // mis-recorded compiled locator (e.g. getByLabel("Логин") on an Angular page
  // where the label isn't wired to the input) will block here for a full 30s
  // PER CALL — that's exactly the "retry_loop: 30011ms, attempts: 1" symptom
  // we observed in the trace.
  //
  // Hard-cap every locator check at 500ms. Fail-open = "not ready" so the
  // outer loop either retries (under budget) or exits cleanly (over budget).
  // V15.1: Populate the `diag` object so callers can emit per-locator trace
  // events (they measure ms so we can see which subcheck hit the cap).
  const CHECK_CAP_MS = 500;
  try {
    if (NEEDS_VISIBLE_ENABLED.has(actionType)) {
      const visStart = Date.now();
      const enStart = Date.now();
      const [isVisible, isEnabled] = await Promise.all([
        withHardCap(() => locator.isVisible(), CHECK_CAP_MS, false),
        withHardCap(() => locator.isEnabled(), CHECK_CAP_MS, false),
      ]);
      const visMs = Date.now() - visStart;
      const enMs = Date.now() - enStart;
      if (diag) {
        diag.isVisible = isVisible;
        diag.isVisibleMs = visMs;
        diag.isEnabled = isEnabled;
        diag.isEnabledMs = enMs;
        // Heuristic: if either check pinned near the cap AND returned false,
        // that's almost certainly a fail-open — a genuine false is instant.
        diag.hardCapHit = (visMs >= CHECK_CAP_MS - 50 && !isVisible)
          || (enMs >= CHECK_CAP_MS - 50 && !isEnabled);
      }
      const ready = isVisible && isEnabled;
      if (diag) diag.ready = ready;
      return ready;
    }

    if (NEEDS_VISIBLE_ONLY.has(actionType)) {
      const visStart = Date.now();
      const isVisible = await withHardCap(() => locator.isVisible(), CHECK_CAP_MS, false);
      const visMs = Date.now() - visStart;
      if (diag) {
        diag.isVisible = isVisible;
        diag.isVisibleMs = visMs;
        diag.hardCapHit = visMs >= CHECK_CAP_MS - 50 && !isVisible;
        diag.ready = isVisible;
      }
      return isVisible;
    }

    if (NEEDS_ATTACHED_ONLY.has(actionType)) {
      const countStart = Date.now();
      const count = await withHardCap(() => locator.count(), CHECK_CAP_MS, 0);
      const countMs = Date.now() - countStart;
      const ready = count > 0;
      if (diag) {
        diag.count = count;
        diag.countMs = countMs;
        diag.hardCapHit = countMs >= CHECK_CAP_MS - 50 && count === 0;
        diag.ready = ready;
      }
      return ready;
    }

    // Unknown action type — assume ready
    if (diag) diag.ready = true;
    return true;
  } catch (error) {
    logger.debug('[STEP_READINESS] Precondition check failed', {
      actionType,
      error: error instanceof Error ? error.message : String(error),
    });
    if (diag) diag.ready = false;
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
  actionType: IntentActionType,
  /** V15.1: Optional per-locator diagnostic buckets (same order as `locators`). */
  diagBuckets?: PreconditionDiag[],
): Promise<boolean> {
  // Check all locators in parallel (each call internally hard-capped at 500ms).
  const results = await Promise.all(
    locators.map((loc, i) => checkPreconditionsSingle(loc, actionType, diagBuckets?.[i]))
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
    tracer,
  } = options;

  // V15: All tracer calls go through this safe wrapper — a broken tracer must
  // never take down the step pipeline.
  const trace = {
    start: (data: Parameters<LookaheadTracer['start']>[0]) => {
      try { tracer?.start(data); } catch { /* non-fatal */ }
    },
    phase: (data: Parameters<LookaheadTracer['phase']>[0]) => {
      try { tracer?.phase(data); } catch { /* non-fatal */ }
    },
    end: (data: Parameters<LookaheadTracer['end']>[0]) => {
      try { tracer?.end(data); } catch { /* non-fatal */ }
    },
    // V15.1: Extra-detailed events. Guarded with `?.` because old callers may
    // implement only the original 3 methods.
    retryAttempt: (data: NonNullable<Parameters<NonNullable<LookaheadTracer['retryAttempt']>>[0]>) => {
      try { tracer?.retryAttempt?.(data); } catch { /* non-fatal */ }
    },
    pageSettle: (data: NonNullable<Parameters<NonNullable<LookaheadTracer['pageSettle']>>[0]>) => {
      try { tracer?.pageSettle?.(data); } catch { /* non-fatal */ }
    },
  };

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

  // V15: tracer start — emits structured lookahead opening so all subsequent
  // phase events can be correlated to this step.
  const plannedStrategies = (nextStep.compiled?.locatorPlan ?? [])
    .map(e => e.strategy);
  trace.start({
    nextStepId: nextStep.id,
    nextActionType: nextStep.type,
    prevActionType,
    prevUrl,
    maxWaitMs,
    settleMs,
    recordedDelayMs,
    plannedLocatorStrategies: plannedStrategies.length ? plannedStrategies : undefined,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // V15 Phase 0: Challenge / interstitial detection (Cloudflare, reCAPTCHA, etc.)
  // If we're currently on a challenge page, waiting for the next step's elements
  // is pointless — those elements only exist AFTER the challenge redirects us.
  // Instead, widen the URL-change watcher and return once we land on a new URL.
  // Budget: up to 7s (challenges typically take 3-5s).
  // ─────────────────────────────────────────────────────────────────────────

  const challengeStart = Date.now();
  const challenge = await detectChallengePage(page);
  trace.phase({
    phase: 'challenge_detection',
    durationMs: Date.now() - challengeStart,
    details: { detected: challenge.detected, kind: challenge.kind },
  });
  if (challenge.detected) {
    const challengeUrl = page.url();
    const challengeBudget = Math.min(7000, maxWaitMs - (Date.now() - startTime));
    logger.info('[STEP_READINESS] Challenge/interstitial detected — widening URL-change watch', {
      stepId: nextStep.id,
      kind: challenge.kind,
      challengeUrl,
      budget: challengeBudget,
    });
    if (challengeBudget > 300) {
      const waitStart = Date.now();
      const redirected = await detectSpaNavigation(page, challengeUrl, challengeBudget);
      if (redirected) {
        // Landed on a new URL — give DOM a brief settle, then let Phase 3 / the
        // step's own locator strategy handle the real target.
        try {
          await page.waitForLoadState('domcontentloaded', { timeout: 1500 });
        } catch { /* non-fatal */ }
      }
      trace.phase({
        phase: 'challenge_wait',
        durationMs: Date.now() - waitStart,
        details: { kind: challenge.kind, redirected, newUrl: page.url() },
      });
      const waited = Date.now() - startTime;
      if (redirected) {
        logger.info('[STEP_READINESS] Challenge cleared — proceeding to next step', {
          stepId: nextStep.id,
          newUrl: page.url(),
          waited,
        });
      } else {
        logger.warn('[STEP_READINESS] Challenge did not clear within budget', {
          stepId: nextStep.id,
          kind: challenge.kind,
          waited,
        });
      }
      const result = {
        ready: redirected,
        waited,
        autoWaitApplied: waited > autoWaitThresholdMs,
        navigationDetected: redirected,
        urlChanged: redirected,
        skipReason: redirected ? undefined : `Challenge page (${challenge.kind}) did not clear`,
      };
      trace.end({
        nextStepId: nextStep.id,
        ready: result.ready,
        totalDurationMs: waited,
        autoWaitApplied: result.autoWaitApplied,
        skipReason: result.skipReason,
        navigationDetected: result.navigationDetected,
        urlChanged: result.urlChanged,
      });
      return result;
    }
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
      const spaStart = Date.now();
      navigationDetected = await detectSpaNavigation(page, prevUrl, spaWaitMs);
      trace.phase({
        phase: 'spa_nav_detection',
        durationMs: Date.now() - spaStart,
        details: { budgetMs: spaWaitMs, detected: navigationDetected, prevUrl },
      });

      if (navigationDetected) {
        // Navigation happened → wait for DOM to be ready (not networkIdle — images/fonts irrelevant).
        // domcontentloaded ensures HTML is parsed, then DOM stability ensures SPA hydration is done.
        const postNavMs = Math.min(settleMs, maxWaitMs - (Date.now() - startTime));
        if (postNavMs > 0) {
          logger.debug('[STEP_READINESS] Post-navigation DOM settle', { postNavMs });
          const settleStart = Date.now();
          let dceFired = true;
          try {
            await page.waitForLoadState('domcontentloaded', { timeout: postNavMs });
          } catch {
            dceFired = false; // Timeout acceptable — DOM may still be usable
          }
          const remainingAfterDce = Math.min(postNavMs, maxWaitMs - (Date.now() - startTime));
          if (remainingAfterDce > 0) {
            await waitForDOMStable(page, remainingAfterDce, domStableThresholdMs);
          }
          trace.phase({
            phase: 'post_nav_settle',
            durationMs: Date.now() - settleStart,
            details: { budgetMs: postNavMs, domcontentloadedFired: dceFired },
          });
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
    const checkStart = Date.now();
    readinessChecks = await comprehensiveReadinessCheck(
      page, locators, nextStep.type, remainingForReadiness
    );
    trace.phase({
      phase: 'page_readiness',
      durationMs: Date.now() - checkStart,
      details: {
        loadingCleared: readinessChecks.loadingCleared,
        iframeReady: readinessChecks.iframeReady,
        animationDone: readinessChecks.animationDone,
        elementEnabled: readinessChecks.elementEnabled,
        overlayClear: readinessChecks.overlayClear,
      },
    });

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

    const blindStart = Date.now();
    await blindSettle(page, domStableThresholdMs);
    trace.phase({
      phase: 'blind_settle',
      durationMs: Date.now() - blindStart,
      details: { hasCompiled: !!nextStep.compiled, hasEvidence: !!nextStep.evidence?.lastSuccessRef },
    });

    const waited = Date.now() - startTime;
    const result = {
      ready: true, // We don't know, but we waited — let executor try
      waited,
      autoWaitApplied: waited > autoWaitThresholdMs,
      skipReason: 'No locator — blind settle applied',
      navigationDetected,
      readinessChecks,
      urlChanged: navigationDetected,
    };
    trace.end({
      nextStepId: nextStep.id,
      ready: result.ready,
      totalDurationMs: waited,
      autoWaitApplied: result.autoWaitApplied,
      skipReason: result.skipReason,
      navigationDetected: result.navigationDetected,
      urlChanged: result.urlChanged,
    });
    return result;
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
  const retryLoopStart = Date.now();

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

    const attemptStart = Date.now();
    // V15.1: Collect per-locator diagnostics so the trace shows WHICH locator
    // and WHICH sub-check (visible/enabled) burned the time. Without this the
    // retry_loop event shows only `attempts: 1, durationMs: 30011` and we have
    // no way to know if it was locator[0] or locator[1] that stalled.
    const diagBuckets: PreconditionDiag[] = locators.map(() => ({ ready: false }));
    ready = await checkPreconditions(locators, nextStep.type, diagBuckets);
    const attemptDur = Date.now() - attemptStart;

    // Emit per-attempt diagnostic. Reference the compiled plan entries (if any)
    // so the consumer can correlate "locator index 0 / strategy=label" — this is
    // what makes it obvious a stale `getByLabel("Логин")` was the 30s culprit.
    //
    // V15.1: Cap perLocator array at 5 entries. On steps with large compiled
    // plans (10+ locators × 3-5 retry attempts = 30-50 perLocator arrays per
    // step) the trace would bloat unnecessarily — the first few locators
    // dominate the timing signal, slow ones show up in the hardCapHit flag.
    const PER_LOCATOR_CAP = 5;
    const planEntries = (nextStep.compiled?.locatorPlan ?? []).filter(e => e.strategy !== 'ref');
    const perLocator = diagBuckets.slice(0, PER_LOCATOR_CAP).map((d, i) => ({
      index: i,
      strategy: planEntries[i]?.strategy,
      value: planEntries[i]?.value?.slice(0, 80),
      ...d,
    }));
    trace.retryAttempt({
      nextStepId: nextStep.id,
      attempt: attempt + 1,
      locatorCount: locators.length,
      perLocator,
      totalMs: attemptDur,
      ready,
    });

    if (ready) {
      const waited = Date.now() - startTime;

      trace.phase({
        phase: 'retry_loop',
        durationMs: Date.now() - retryLoopStart,
        details: { attempts: attempt + 1, finalState: 'ready', lastAttemptMs: attemptDur },
      });

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
          trace.phase({
            phase: 'recording_delay_enforced',
            durationMs: remaining,
            details: { recordedDelayMs, minWaitFromRecording },
          });
        }
      }

      const totalWaited = Date.now() - startTime;
      logger.debug('[STEP_READINESS] Element ready', {
        stepId: nextStep.id,
        waited: totalWaited,
        attempts: attempt,
      });
      const result = {
        ready: true,
        waited: totalWaited,
        autoWaitApplied: totalWaited > autoWaitThresholdMs,
        navigationDetected,
        readinessChecks,
        urlChanged: navigationDetected,
      };
      trace.end({
        nextStepId: nextStep.id,
        ready: result.ready,
        totalDurationMs: totalWaited,
        autoWaitApplied: result.autoWaitApplied,
        navigationDetected: result.navigationDetected,
        urlChanged: result.urlChanged,
      });
      return result;
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
      // V15.1: Measure the settle so a runaway-mutating SPA (never goes quiet)
      // can be spotted. `budgetExhausted` = we hit the cap without the observer
      // reporting DOM-quiet, meaning the page kept mutating.
      const settleStart = Date.now();
      await pageSettle(page, thisSettleMs, domStableThresholdMs);
      const settleActual = Date.now() - settleStart;
      trace.pageSettle({
        context: 'retry_loop',
        budgetMs: thisSettleMs,
        actualMs: settleActual,
        domStableThresholdMs,
        // Settle returns when quiet is observed OR budget expires. If we used
        // ≥90% of budget, the observer never saw quiet.
        budgetExhausted: settleActual >= thisSettleMs * 0.9,
      });
    }

    attempt++;
  }

  trace.phase({
    phase: 'retry_loop',
    durationMs: Date.now() - retryLoopStart,
    details: { attempts: attempt, finalState: ready ? 'ready' : 'timeout' },
  });

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

  const result = {
    ready,
    waited,
    autoWaitApplied: waited > autoWaitThresholdMs,
    navigationDetected,
    readinessChecks,
    urlChanged: navigationDetected,
  };
  trace.end({
    nextStepId: nextStep.id,
    ready: result.ready,
    totalDurationMs: waited,
    autoWaitApplied: result.autoWaitApplied,
    navigationDetected: result.navigationDetected,
    urlChanged: result.urlChanged,
  });
  return result;
}

/**
 * Actions after which lookahead should be SKIPPED for the next step.
 * Separated from NON_TARGETING_ACTIONS (used for "skip readiness check FOR this step type").
 *
 * V18: switch_tab intentionally NOT here — it changes the active page context,
 * so the next step needs full readiness checking (loading indicators, DOM stable,
 * element visible/enabled) on the new tab's page. Without this, steps after
 * switch_tab fail with element_not_found because the popup page hasn't loaded yet.
 */
const SKIP_LOOKAHEAD_AFTER: Set<IntentActionType> = new Set([
  'wait',
  'wait_for',
  'ai_check',
  'wait_for_email',
  'dialog',
  'download',
]);

/**
 * Check if lookahead should be skipped based on previous step type.
 * switch_tab is NOT skipped — the next step needs readiness checks on the new page.
 *
 * @param prevStepType - The type of the previous step
 */
export function shouldSkipLookaheadAfter(prevStepType: IntentActionType): boolean {
  return SKIP_LOOKAHEAD_AFTER.has(prevStepType);
}
