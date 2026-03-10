/**
 * Step Readiness Service
 * Lookahead wait mechanism for inter-step stability
 *
 * Provides fast Playwright-based element readiness checks before executing next step.
 * Uses ONLY fast DOM checks (isVisible, isEnabled, count) - NO LLM or AI resolution.
 *
 * Key features:
 * - Fast precondition checks using compiled locatorPlan or evidence.lastSuccessRef
 * - SPA navigation detection after click/open/close (URL-change race, no hardcoded delays)
 * - Dynamic DOM stability threshold based on previous action risk profile
 * - Page settle fallback (network idle + DOM stable) when element not ready
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
  'navigate', // goto triggers full page navigation, needs networkIdle + DOM settle
]);

/** Action types that require visible + enabled */
const NEEDS_VISIBLE_ENABLED: Set<IntentActionType> = new Set([
  'click',
  'type',
  'select',
  'check',
  'uncheck',
  'toggle',
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
  if (prevActionType === 'assert' || prevActionType === 'hover') return DOM_STABLE_THRESHOLD_MS.assertion;

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
 * Apply page-level settle: networkIdle + DOM stable in parallel.
 * The domStableThresholdMs is dynamically chosen based on prev action profile.
 */
async function pageSettle(
  page: Page,
  settleMs: number,
  domStableThresholdMs: number
): Promise<void> {
  const startTime = Date.now();
  logger.debug('[STEP_READINESS] Applying page settle', { settleMs, domStableThresholdMs });

  await Promise.race([
    Promise.all([
      waitForNetworkIdle(page, settleMs),
      waitForDOMStable(page, settleMs, domStableThresholdMs),
    ]),
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
  } = options;

  // Dynamic DOM stability threshold based on prev action risk
  const domStableThresholdMs = getDomStableThresholdMs(prevActionType, domStableOverride);

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
        // Navigation happened → wait for networkIdle so the new page is ready
        const postNavMs = Math.min(settleMs, maxWaitMs - (Date.now() - startTime));
        if (postNavMs > 0) {
          logger.debug('[STEP_READINESS] Post-navigation networkIdle wait', { postNavMs });
          await waitForNetworkIdle(page, postNavMs);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2: Build fast locators (all non-ref strategies)
  // If none available → blind settle instead of skipping
  // ─────────────────────────────────────────────────────────────────────────

  const locators = buildFastLocators(page, nextStep);

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
      logger.debug('[STEP_READINESS] Element ready', {
        stepId: nextStep.id,
        waited,
        attempts: attempt,
      });
      return {
        ready: true,
        waited,
        autoWaitApplied: waited > autoWaitThresholdMs,
        navigationDetected,
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
