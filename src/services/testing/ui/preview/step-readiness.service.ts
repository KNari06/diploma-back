/**
 * Step Readiness Service
 * Lookahead wait mechanism for inter-step stability
 *
 * Provides fast Playwright-based element readiness checks before executing next step.
 * Uses ONLY fast DOM checks (isVisible, isEnabled, count) - NO embeddings or AI resolution.
 *
 * Key features:
 * - Fast precondition checks using compiled locatorPlan or evidence.lastSuccessRef
 * - Page settle fallback (network idle + DOM stable) when element not ready
 * - Runtime metadata tracking (autoWaitApplied) when significant wait occurred
 * - Per-step disable flag for advanced use cases
 */

import { logger } from '@/utils/core/logger';
import type { Locator, Page } from 'playwright';
import type { IntentActionType, IntentStep } from './preview.types';

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
  /** DOM stability threshold in milliseconds (default: 300) */
  domStableThresholdMs?: number;
  /** Maximum number of settle retries (default: 3) */
  maxRetries?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Action types that don't target elements (skip lookahead) */
const NON_TARGETING_ACTIONS: Set<IntentActionType> = new Set([
  'navigate',
  'wait',
  'wait_for',
  'ai_check',
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

/** Default configuration values */
const DEFAULTS = {
  maxWaitMs: 10000,
  settleMs: 3000,
  autoWaitThresholdMs: 2000,
  domStableThresholdMs: 300,
  maxRetries: 3,
};

// ═══════════════════════════════════════════════════════════════════════════
// PAGE SETTLE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wait for network to be idle (no pending requests)
 * Uses Playwright's built-in networkidle with fallback
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
 * Wait for DOM to stabilize (no mutations for threshold period)
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
    // DOM stability check failed, continue
    logger.debug('[STEP_READINESS] DOM stability check failed, continuing');
  }
}

/**
 * Apply page-level settle (network idle + DOM stable)
 * Used when element is not ready yet
 */
async function pageSettle(
  page: Page,
  settleMs: number,
  domStableThresholdMs: number
): Promise<void> {
  const startTime = Date.now();

  logger.debug('[STEP_READINESS] Applying page settle', { settleMs, domStableThresholdMs });

  // Run network idle and DOM stable in parallel, with overall timeout
  await Promise.race([
    Promise.all([
      waitForNetworkIdle(page, settleMs),
      waitForDOMStable(page, settleMs, domStableThresholdMs),
    ]),
    new Promise((resolve) => setTimeout(resolve, settleMs)),
  ]);

  const elapsed = Date.now() - startTime;
  logger.debug('[STEP_READINESS] Page settle complete', { elapsedMs: elapsed });
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCATOR BUILDING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a fast locator from step's compiled plan or evidence
 * Returns null if no fast locator can be built (should skip lookahead)
 */
function buildFastLocator(page: Page, step: IntentStep): Locator | null {
  // Priority 1: Use compiled locatorPlan if available
  if (step.compiled?.locatorPlan && step.compiled.locatorPlan.length > 0) {
    const primary = step.compiled.locatorPlan[0];

    try {
      switch (primary.strategy) {
        case 'ref':
          // CSS selector for data-agent-ref
          return page.locator(primary.value).first();

        case 'role':
          // getByRole with accessible name
          return page
            .getByRole(primary.roleName as any, { name: primary.value })
            .first();

        case 'label':
          return page.getByLabel(primary.value).first();

        case 'testId':
          return page.getByTestId(primary.value).first();

        case 'placeholder':
          return page.getByPlaceholder(primary.value).first();

        case 'css':
          return page.locator(primary.value).first();

        default:
          logger.debug('[STEP_READINESS] Unknown locator strategy', {
            strategy: primary.strategy,
          });
          return null;
      }
    } catch (error) {
      logger.debug('[STEP_READINESS] Failed to build locator from compiled plan', {
        strategy: primary.strategy,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Priority 2: Fallback to evidence.lastSuccessRef
  if (step.evidence?.lastSuccessRef) {
    try {
      const ref = step.evidence.lastSuccessRef;
      // Escape special characters in ref for CSS selector
      const escapedRef = ref.replace(/"/g, '\\"');
      return page.locator(`[data-agent-ref="${escapedRef}"]`).first();
    } catch (error) {
      logger.debug('[STEP_READINESS] Failed to build locator from evidence', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // No fast locator available
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRECONDITION CHECKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if element meets preconditions for action type
 * Uses ONLY fast Playwright checks - no embeddings
 */
async function checkPreconditions(
  locator: Locator,
  actionType: IntentActionType
): Promise<boolean> {
  try {
    if (NEEDS_VISIBLE_ENABLED.has(actionType)) {
      // Must be visible AND enabled
      const [isVisible, isEnabled] = await Promise.all([
        locator.isVisible(),
        locator.isEnabled(),
      ]);
      return isVisible && isEnabled;
    }

    if (NEEDS_VISIBLE_ONLY.has(actionType)) {
      // Must be visible
      return await locator.isVisible();
    }

    if (NEEDS_ATTACHED_ONLY.has(actionType)) {
      // Must be attached (count > 0)
      const count = await locator.count();
      return count > 0;
    }

    // Unknown action type - assume ready
    return true;
  } catch (error) {
    // Element not found or check failed
    logger.debug('[STEP_READINESS] Precondition check failed', {
      actionType,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wait for next step to be ready before executing it
 *
 * Uses fast Playwright checks only (no embeddings/AI).
 * If element not ready, applies page settle and retries.
 *
 * @param page - Playwright Page instance
 * @param nextStep - The step that will be executed next
 * @param options - Configuration options
 * @returns LookaheadResult with readiness status and wait metrics
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
    domStableThresholdMs = DEFAULTS.domStableThresholdMs,
    maxRetries = DEFAULTS.maxRetries,
  } = options;

  // ─────────────────────────────────────────────────────────────────────────
  // Skip conditions
  // ─────────────────────────────────────────────────────────────────────────

  // Check per-step disable flag
  if (nextStep.options?.disableLookaheadWait) {
    logger.debug('[STEP_READINESS] Skipped: disableLookaheadWait flag set', {
      stepId: nextStep.id,
    });
    return {
      ready: true,
      waited: 0,
      autoWaitApplied: false,
      skipReason: 'disableLookaheadWait flag set',
    };
  }

  // Check if action type targets an element
  if (NON_TARGETING_ACTIONS.has(nextStep.type)) {
    logger.debug('[STEP_READINESS] Skipped: non-targeting action', {
      stepId: nextStep.id,
      actionType: nextStep.type,
    });
    return {
      ready: true,
      waited: 0,
      autoWaitApplied: false,
      skipReason: `Non-targeting action: ${nextStep.type}`,
    };
  }

  // Build fast locator
  const locator = buildFastLocator(page, nextStep);
  if (!locator) {
    logger.debug('[STEP_READINESS] Skipped: no fast locator available', {
      stepId: nextStep.id,
      hasCompiled: !!nextStep.compiled,
      hasEvidence: !!nextStep.evidence?.lastSuccessRef,
    });
    return {
      ready: true,
      waited: 0,
      autoWaitApplied: false,
      skipReason: 'No fast locator available (no compiled plan or evidence)',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Retry loop with settle
  // ─────────────────────────────────────────────────────────────────────────

  logger.debug('[STEP_READINESS] Starting lookahead wait', {
    stepId: nextStep.id,
    actionType: nextStep.type,
    maxWaitMs,
    settleMs,
  });

  let attempt = 0;
  let ready = false;

  while (attempt <= maxRetries) {
    const elapsed = Date.now() - startTime;

    // Check timeout
    if (elapsed >= maxWaitMs) {
      logger.debug('[STEP_READINESS] Max wait timeout reached', {
        stepId: nextStep.id,
        elapsed,
        maxWaitMs,
        attempts: attempt,
      });
      break;
    }

    // Check preconditions
    ready = await checkPreconditions(locator, nextStep.type);

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
      };
    }

    // Element not ready - apply page settle and retry
    logger.debug('[STEP_READINESS] Element not ready, applying settle', {
      stepId: nextStep.id,
      attempt,
      maxRetries,
    });

    const remainingTime = maxWaitMs - (Date.now() - startTime);
    const thisSettleMs = Math.min(settleMs, remainingTime);

    if (thisSettleMs > 0) {
      await pageSettle(page, thisSettleMs, domStableThresholdMs);
    }

    attempt++;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Final result
  // ─────────────────────────────────────────────────────────────────────────

  const waited = Date.now() - startTime;

  logger.info('[STEP_READINESS] Lookahead complete', {
    stepId: nextStep.id,
    ready,
    waited,
    attempts: attempt,
    autoWaitApplied: waited > autoWaitThresholdMs,
  });

  return {
    ready,
    waited,
    autoWaitApplied: waited > autoWaitThresholdMs,
  };
}

/**
 * Check if lookahead should be skipped based on previous step type
 * Call this before waitForStepReadiness if you have context about prev step
 *
 * @param prevStepType - The type of the previous step
 * @returns true if lookahead should be skipped
 */
export function shouldSkipLookaheadAfter(prevStepType: IntentActionType): boolean {
  // These actions already handle waiting or don't trigger async changes
  return NON_TARGETING_ACTIONS.has(prevStepType);
}
