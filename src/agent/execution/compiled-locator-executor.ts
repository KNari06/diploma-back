/**
 * Compiled Locator Executor
 * 
 * Executes locators from CompiledStepPlan with fallback chain.
 * Performs pageSignature check before attempting compiled locators.
 * 
 * Flow:
 * 1. Check pageSignature (if present) - mismatch = skip compiled entirely
 * 2. Check soft-expire based on actionType TTL
 * 3. Try each locator in the plan in order
 * 4. Return success with used locator, or failure for fallback
 */

import { logger } from '@/utils/core/logger';
import { Locator, Page } from 'playwright';
import type {
  CompiledStepPlan,
  ConfidenceTier,
  LocatorEntry,
  RuntimeSource,
  StepRuntimeMeta,
} from '@/services/testing/ui/preview/preview.types';
import { isCompiledPlanExpired } from '@/services/testing/ui/preview/preview.types';

/**
 * Result from compiled locator execution attempt
 */
export interface CompiledExecutionResult {
  /** Whether a locator was successfully found */
  success: boolean;
  /** The Playwright locator that worked */
  locator?: Locator;
  /** Which locator strategy was used */
  usedStrategy?: string;
  /** Confidence from the locator entry */
  confidence?: number;
  /** Reason for skipping/failure */
  skipReason?: 'signature_mismatch' | 'expired' | 'no_plan' | 'locator_failed';
  /** Whether compiled plan was expired */
  expired?: boolean;
  /** Whether page signature matched */
  signatureMatched?: boolean;
  /** Runtime source for reporting */
  source: RuntimeSource;
}

/**
 * Get page signature from current page
 * Uses a simple hash of form/input structure for quick comparison
 */
async function getCurrentPageSignature(page: Page): Promise<string> {
  try {
    const signature = await page.evaluate(() => {
      // @ts-expect-error - runs in browser context
      const inputs = document.querySelectorAll('input, select, textarea, button, [role="button"]');
      const elements: string[] = [];
      
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputs.forEach((el: any) => {
        const tag = el.tagName?.toLowerCase() || '';
        const type = el.getAttribute?.('type') || '';
        const name = el.getAttribute?.('name') || '';
        const id = el.id || '';
        const role = el.getAttribute?.('role') || '';
        elements.push(`${tag}:${type}:${name}:${id}:${role}`);
      });
      
      // Simple hash from sorted element signatures
      return elements.sort().join('|').slice(0, 500);
    });
    
    return signature;
  } catch {
    return '';
  }
}

/**
 * Check if page signature matches compiled plan signature
 * Returns true if no signature is stored (backward compatibility)
 */
async function checkPageSignature(
  page: Page,
  compiledSignature?: string
): Promise<{ matched: boolean; currentSignature: string }> {
  if (!compiledSignature) {
    // No signature stored - skip check (backward compatibility)
    return { matched: true, currentSignature: '' };
  }

  const currentSignature = await getCurrentPageSignature(page);
  
  // Signatures don't need to be exact - just similar enough
  // Use simple overlap check (60% match is enough)
  const compiledParts = new Set(compiledSignature.split('|'));
  const currentParts = currentSignature.split('|');
  
  if (compiledParts.size === 0 || currentParts.length === 0) {
    return { matched: true, currentSignature };
  }

  let matchCount = 0;
  for (const part of currentParts) {
    if (compiledParts.has(part)) {
      matchCount++;
    }
  }

  const matchRatio = matchCount / Math.max(compiledParts.size, currentParts.length);
  const matched = matchRatio >= 0.6;

  logger.debug('[COMPILED_EXECUTOR] Page signature check', {
    matched,
    matchRatio: Math.round(matchRatio * 100),
    compiledPartsCount: compiledParts.size,
    currentPartsCount: currentParts.length,
  });

  return { matched, currentSignature };
}

/**
 * Try a single locator entry
 */
async function tryLocatorEntry(
  page: Page,
  entry: LocatorEntry,
  timeout: number
): Promise<{ success: boolean; locator?: Locator; error?: string }> {
  try {
    let locator: Locator;

    switch (entry.strategy) {
      case 'ref':
        // ref is a CSS selector for data-agent-ref
        locator = page.locator(entry.value);
        break;

      case 'css':
        locator = page.locator(entry.value);
        break;

      case 'role':
        if (entry.roleName) {
          // getByRole with name
          locator = page.getByRole(entry.roleName as any, { name: entry.value });
        } else {
          // Fallback to CSS
          locator = page.locator(entry.value);
        }
        break;

      case 'label':
        locator = page.getByLabel(entry.value);
        break;

      case 'testId':
        locator = page.getByTestId(entry.value);
        break;

      case 'placeholder':
        locator = page.getByPlaceholder(entry.value);
        break;

      default:
        return { success: false, error: `Unknown strategy: ${entry.strategy}` };
    }

    // Wait for element to be visible (quick check)
    await locator.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) });
    
    // Verify exactly one match (avoid ambiguity)
    const count = await locator.count();
    if (count === 0) {
      return { success: false, error: 'No elements found' };
    }
    if (count > 1) {
      // Multiple matches - use first but log warning
      logger.warn('[COMPILED_EXECUTOR] Multiple elements matched, using first', {
        strategy: entry.strategy,
        value: entry.value,
        count,
      });
      locator = locator.first();
    }

    return { success: true, locator };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Execute compiled locator plan
 * 
 * @param page Playwright Page
 * @param compiled CompiledStepPlan from IntentStep
 * @param actionType Action type for TTL calculation
 * @param timeout Action timeout
 * @returns Result with success status and locator if found
 */
export async function executeCompiledLocatorPlan(
  page: Page,
  compiled: CompiledStepPlan | undefined,
  actionType: string,
  timeout: number = 30000
): Promise<CompiledExecutionResult> {
  // 1. Check if compiled plan exists
  if (!compiled || !compiled.locatorPlan || compiled.locatorPlan.length === 0) {
    logger.debug('[COMPILED_EXECUTOR] No compiled plan available');
    return {
      success: false,
      skipReason: 'no_plan',
      source: 'resolver',
    };
  }

  // 2. Check soft-expire based on actionType TTL
  const compiledAt = compiled.context?.compiledAt;
  const expired = compiledAt ? isCompiledPlanExpired(compiledAt, actionType) : false;
  if (expired) {
    logger.info('[COMPILED_EXECUTOR] Compiled plan expired, skipping', {
      compiledAt,
      actionType,
    });
    return {
      success: false,
      skipReason: 'expired',
      expired: true,
      source: 'resolver',
    };
  }

  // 3. Check pageSignature (if present)
  const signatureCheck = await checkPageSignature(page, compiled.context?.pageSignature);
  if (!signatureCheck.matched) {
    logger.info('[COMPILED_EXECUTOR] Page signature mismatch, skipping compiled plan', {
      stored: compiled.context?.pageSignature?.slice(0, 50),
      current: signatureCheck.currentSignature.slice(0, 50),
    });
    return {
      success: false,
      skipReason: 'signature_mismatch',
      signatureMatched: false,
      source: 'resolver',
    };
  }

  // 4. Try each locator in order
  for (const entry of compiled.locatorPlan) {
    logger.debug('[COMPILED_EXECUTOR] Trying locator', {
      strategy: entry.strategy,
      value: entry.value.slice(0, 50),
      confidence: entry.confidence,
    });

    const result = await tryLocatorEntry(page, entry, timeout);
    
    if (result.success && result.locator) {
      logger.info('[COMPILED_EXECUTOR] Locator succeeded', {
        strategy: entry.strategy,
        confidence: entry.confidence,
      });
      
      return {
        success: true,
        locator: result.locator,
        usedStrategy: entry.strategy,
        confidence: entry.confidence,
        expired: false,
        signatureMatched: true,
        source: 'compiled',
      };
    }

    logger.debug('[COMPILED_EXECUTOR] Locator failed, trying next', {
      strategy: entry.strategy,
      error: result.error,
    });
  }

  // All locators failed
  logger.warn('[COMPILED_EXECUTOR] All locators in plan failed');
  return {
    success: false,
    skipReason: 'locator_failed',
    expired: false,
    signatureMatched: true,
    source: 'resolver',
  };
}

/**
 * Build StepRuntimeMeta from compiled execution result
 */
export function buildRuntimeMeta(
  result: CompiledExecutionResult,
  executionMs: number,
  healResult?: { success: boolean; confidence?: number }
): StepRuntimeMeta {
  // Determine runtime status
  let runtimeStatus: 'executed' | 'healed' | 'failed' = 'failed';
  let source = result.source;
  let confidenceTier: ConfidenceTier = 'low';
  
  if (result.success) {
    runtimeStatus = 'executed';
    confidenceTier = (result.confidence ?? 0) >= 0.8 ? 'high' : 
                     (result.confidence ?? 0) >= 0.6 ? 'medium' : 'low';
  } else if (healResult?.success) {
    runtimeStatus = 'healed';
    source = 'self_heal';
    confidenceTier = (healResult.confidence ?? 0) >= 0.85 ? 'medium' : 'low';
  }

  const meta: StepRuntimeMeta = {
    runtimeStatus,
    source,
    confidenceTier,
    executionMs,
    usedLocatorStrategy: result.usedStrategy,
    compiledExpired: result.expired,
    pageSignatureMatched: result.signatureMatched,
  };

  // Add failure reason if failed
  if (runtimeStatus === 'failed') {
    switch (result.skipReason) {
      case 'signature_mismatch':
      case 'expired':
      case 'locator_failed':
        meta.failedReason = 'element_not_found';
        break;
      default:
        meta.failedReason = 'unknown';
    }
  }

  // Flag for review if healed with low confidence or compiled failed
  if (runtimeStatus === 'healed' && confidenceTier === 'low') {
    meta.needsReview = true;
    meta.flaky = true;
    meta.healConfidence = healResult?.confidence;
  }

  return meta;
}
