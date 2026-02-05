/**
 * Auto Wait For URL Utils (V5)
 * Smart auto-insertion of wait_for_url steps between navigating actions
 * 
 * This module provides utilities for:
 * 1. Detecting implicit navigation between steps (via compiled.context.pageUrl diff)
 * 2. Injecting wait_for_url steps to ensure stability during background runs
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
 * Action types that should NOT trigger auto-insert of wait_for_url after them.
 * These are either:
 * - Already waiting actions (wait, wait_for_url)
 * - Actions that already handle navigation (navigate uses networkidle)
 * - Non-targeting actions (ai_check doesn't interact with page)
 */
const SKIP_INJECT_AFTER_TYPES: Set<IntentActionType> = new Set([
  'navigate',
  'wait',
  'wait_for_url',
  'ai_check',
]);

/**
 * Check if a wait_for_url step should be injected between two adjacent steps.
 * 
 * Injection criteria:
 * 1. Both steps have compiled.context.pageUrl
 * 2. Normalized URLs differ (navigation occurred)
 * 3. Previous step is a targeting action (not in SKIP_INJECT_AFTER_TYPES)
 * 4. Next step is NOT already a wait_for_url (avoid duplicates)
 * 
 * @param prevStep - Previous step in sequence
 * @param nextStep - Next step in sequence
 * @returns true if wait_for_url should be injected between them
 */
function shouldInjectWaitForUrl(prevStep: IntentStep, nextStep: IntentStep): boolean {
  // Get URLs from compiled context
  const prevUrl = prevStep.compiled?.context?.pageUrl;
  const nextUrl = nextStep.compiled?.context?.pageUrl;

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

  // Skip if next step is already wait_for_url (avoid duplicates)
  if (nextStep.type === 'wait_for_url') {
    return false;
  }

  return true;
}

/**
 * Create a new wait_for_url step for auto-insertion.
 * Uses changedFrom matcher to wait for any URL change from the previous URL.
 * 
 * @param prevUrl - Previous page URL (wait until URL != this)
 * @returns New IntentStep for wait_for_url
 */
function createAutoWaitForUrlStep(prevUrl: string): IntentStep {
  return {
    id: uuid(),
    type: 'wait_for_url',
    description: 'Auto: wait for URL change',
    options: {
      urlMatcher: {
        changedFrom: prevUrl,
        timeoutMs: 15000,
      },
    },
  };
}

/**
 * Auto-inject wait_for_url steps between steps where navigation occurred.
 * 
 * Detection: adjacent steps have different compiled.context.pageUrl.
 * Injection is conservative: only after targeting actions, not after navigate/wait/ai_check.
 * 
 * This function is PURE - it returns a new array without modifying the input.
 * 
 * @param steps - Array of IntentSteps from the test case
 * @returns New array with auto-inserted wait_for_url steps
 */
export function injectAutoWaitForUrlSteps(steps: IntentStep[]): IntentStep[] {
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

      if (shouldInjectWaitForUrl(currentStep, nextStep)) {
        const prevUrl = currentStep.compiled?.context?.pageUrl!;
        const autoStep = createAutoWaitForUrlStep(prevUrl);
        result.push(autoStep);
        injectedCount++;

        logger.debug('[AUTO_WAIT_FOR_URL] Injected wait_for_url step', {
          afterStepId: currentStep.id,
          afterStepType: currentStep.type,
          prevUrl: normalizeUrlForComparison(prevUrl),
          nextUrl: normalizeUrlForComparison(nextStep.compiled?.context?.pageUrl || ''),
          autoStepId: autoStep.id,
        });
      }
    }
  }

  if (injectedCount > 0) {
    logger.info('[AUTO_WAIT_FOR_URL] Auto-inserted wait_for_url steps', {
      originalCount: steps.length,
      resultCount: result.length,
      injectedCount,
    });
  }

  return result;
}
