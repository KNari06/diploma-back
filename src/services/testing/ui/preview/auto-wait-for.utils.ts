/**
 * Auto Wait For Utils (V5)
 * Smart auto-insertion of wait_for steps between navigating actions
 * 
 * This module provides utilities for:
 * 1. Detecting implicit navigation between steps (via compiled.context.pageUrl or evidence.pageUrl diff)
 * 2. Injecting wait_for steps to ensure stability during background runs and first-run Apply All
 * 3. URL normalization for comparison
 */

import { v4 as uuid } from 'uuid';
import { logger } from '@/utils/core/logger';
import type { IntentActionType, IntentStep } from './preview.types';

/**
 * Normalize URL for comparison.
 * Strips query params, hash, and trailing slash to detect meaningful page changes.
 * 
 * @param url - URL to normalize
 * @returns Normalized URL (origin + pathname without trailing slash)
 */
export function normalizeUrlForComparison(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch {
    // Invalid URL - return as-is for string comparison
    return url;
  }
}

/**
 * Action types that should NOT trigger auto-insert of wait_for after them.
 * These are either:
 * - Already waiting actions (wait, wait_for)
 * - Actions that already handle navigation (navigate uses networkidle)
 * - Non-targeting actions (ai_check doesn't interact with page)
 */
const SKIP_INJECT_AFTER_TYPES: Set<IntentActionType> = new Set([
  'navigate',
  'wait',
  'wait_for',
  'ai_check',
  'wait_for_email',  // V12: Already a waiting action
]);

/**
 * Check if a wait_for step should be injected between two adjacent steps.
 * 
 * Injection criteria:
 * 1. Both steps have compiled.context.pageUrl
 * 2. Normalized URLs differ (navigation occurred)
 * 3. Previous step is a targeting action (not in SKIP_INJECT_AFTER_TYPES)
 * 4. Next step is NOT already a wait_for (avoid duplicates)
 * 
 * @param prevStep - Previous step in sequence
 * @param nextStep - Next step in sequence
 * @returns true if wait_for should be injected between them
 */
function shouldInjectWaitFor(prevStep: IntentStep, nextStep: IntentStep): boolean {
  // Get URLs from compiled context, fallback to evidence.pageUrl (captured during recording)
  // This fallback is critical for first-run: steps have evidence but no compiled plans yet
  const prevUrl = prevStep.compiled?.context?.pageUrl || prevStep.evidence?.pageUrl;
  const nextUrl = nextStep.compiled?.context?.pageUrl || nextStep.evidence?.pageUrl;

  // Skip if either URL is missing
  if (!prevUrl || !nextUrl) {
    return false;
  }

  // Skip if URLs are the same (no navigation)
  if (normalizeUrlForComparison(prevUrl) === normalizeUrlForComparison(nextUrl)) {
    return false;
  }

  // Skip if previous step is a non-targeting action
  if (SKIP_INJECT_AFTER_TYPES.has(prevStep.type)) {
    return false;
  }

  // Skip if next step is already wait_for (avoid duplicates)
  if (nextStep.type === 'wait_for') {
    return false;
  }

  return true;
}

/**
 * Create a new wait_for step for auto-insertion.
 * Uses changedFrom matcher to wait for any URL change from the previous URL.
 * 
 * @param prevUrl - Previous page URL (wait until URL != this)
 * @returns New IntentStep for wait_for
 */
function createAutoWaitForStep(prevUrl: string): IntentStep {
  return {
    id: uuid(),
    type: 'wait_for',
    description: 'Auto: wait for URL change',
    isAutoInjected: true,
    options: {
      urlMatcher: {
        changedFrom: prevUrl,
        timeoutMs: 5000,
      },
    },
  };
}

/**
 * Auto-inject wait_for steps between steps where navigation occurred.
 * 
 * Detection: adjacent steps have different compiled.context.pageUrl.
 * Injection is conservative: only after targeting actions, not after navigate/wait/ai_check.
 * 
 * This function is PURE - it returns a new array without modifying the input.
 * 
 * @param steps - Array of IntentSteps from the test case
 * @returns New array with auto-inserted wait_for steps
 */
export function injectAutoWaitForSteps(steps: IntentStep[]): IntentStep[] {
  if (!steps || steps.length < 2) {
    return steps;
  }

  const result: IntentStep[] = [];
  let injectedCount = 0;

  for (let i = 0; i < steps.length; i++) {
    const currentStep = steps[i];
    result.push(currentStep);

    // Check if we need to inject after this step
    if (i < steps.length - 1) {
      const nextStep = steps[i + 1];

      if (shouldInjectWaitFor(currentStep, nextStep)) {
        const prevUrl = (currentStep.compiled?.context?.pageUrl || currentStep.evidence?.pageUrl)!;
        const autoStep = createAutoWaitForStep(prevUrl);
        result.push(autoStep);
        injectedCount++;

        const nextUrl = nextStep.compiled?.context?.pageUrl || nextStep.evidence?.pageUrl || '';
        logger.debug('[AUTO_WAIT_FOR] Injected wait_for step', {
          afterStepId: currentStep.id,
          afterStepType: currentStep.type,
          prevUrl: normalizeUrlForComparison(prevUrl),
          nextUrl: normalizeUrlForComparison(nextUrl),
          autoStepId: autoStep.id,
        });
      }
    }
  }

  if (injectedCount > 0) {
    logger.info('[AUTO_WAIT_FOR] Auto-inserted wait_for steps', {
      originalCount: steps.length,
      resultCount: result.length,
      injectedCount,
    });
  }

  return result;
}
