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

import type {
  CompiledStepPlan,
  ConfidenceTier,
  LocatorEntry,
  RuntimeSource,
  StepRuntimeMeta,
  TargetFingerprint,
} from '@/services/testing/ui/preview/preview.types';
import { isCompiledPlanExpired } from '@/services/testing/ui/preview/preview.types';
import { logger } from '@/utils/core/logger';
import { Frame, Locator, Page } from 'playwright';

/**
 * Playwright "page-like" context that supports locator + evaluate APIs.
 * We use this to run compiled locator plans either on the main Page or inside an iframe Frame.
 */
type PageLike = Page | Frame;

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
  skipReason?: 'signature_mismatch' | 'expired' | 'no_plan' | 'locator_failed' | 'ambiguous';
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
async function getCurrentPageSignature(page: PageLike): Promise<string> {
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
  page: PageLike,
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
 * Quick fingerprint check to validate found element matches expected attributes
 * Returns match score 0-1 (1 = perfect match)
 */
async function quickFingerprintCheck(
  page: PageLike,
  locator: Locator,
  fingerprint: TargetFingerprint
): Promise<number> {
  try {
    const element = await locator.evaluate((el: any) => ({
      tag: el?.tagName?.toLowerCase(),
      role: el?.getAttribute?.('role'),
      ariaLabel: el?.getAttribute?.('aria-label'),
      placeholder: el?.getAttribute?.('placeholder'),
    }));

    let matches = 0;
    let total = 0;

    // Compare tag
    if (fingerprint.tag) {
      total++;
      if (element.tag === fingerprint.tag.toLowerCase()) matches++;
    }

    // Compare role
    if (fingerprint.role) {
      total++;
      if (element.role === fingerprint.role) matches++;
    }

    // Compare ariaLabel
    if (fingerprint.ariaLabel) {
      total++;
      if (element.ariaLabel === fingerprint.ariaLabel) matches++;
    }

    // Compare placeholder
    if (fingerprint.placeholder) {
      total++;
      if (element.placeholder === fingerprint.placeholder) matches++;
    }

    // If no fingerprint attributes, return 1 (no validation needed)
    if (total === 0) return 1;

    const score = matches / total;
    return score;
  } catch {
    // If fingerprint check fails, assume element is ok (best effort)
    return 1;
  }
}

/**
 * Try a single locator entry
 */
async function tryLocatorEntry(
  page: PageLike,
  entry: LocatorEntry,
  timeout: number
): Promise<{
  success: boolean;
  locator?: Locator;
  error?: string;
  failureKind?: 'ambiguous' | 'not_found' | 'error';
}> {
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
      return { success: false, error: 'No elements found', failureKind: 'not_found' };
    }
    if (count > 1) {
      // Multiple matches - treat as ambiguity for CI/background runs
      // This forces fallback to resolver/self-heal instead of blindly clicking first
      logger.warn('[COMPILED_EXECUTOR] Multiple elements matched - treating as ambiguous', {
        strategy: entry.strategy,
        value: entry.value,
        count,
      });
      return { success: false, error: `Ambiguous: ${count} elements matched`, failureKind: 'ambiguous' };
    }

    return { success: true, locator };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage, failureKind: 'error' };
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
  page: PageLike,
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
  let sawAmbiguous = false;
  for (const entry of compiled.locatorPlan) {
    logger.debug('[COMPILED_EXECUTOR] Trying locator', {
      strategy: entry.strategy,
      value: entry.value.slice(0, 50),
      confidence: entry.confidence,
    });

    const result = await tryLocatorEntry(page, entry, timeout);

    if (result.success && result.locator) {
      // Validate fingerprint if available
      if (compiled.targetFingerprint) {
        const matchScore = await quickFingerprintCheck(page, result.locator, compiled.targetFingerprint);
        
        if (matchScore < 0.3) {
          logger.warn('[COMPILED_EXECUTOR] Fingerprint mismatch - element found but may be wrong', {
            strategy: entry.strategy,
            matchScore: Math.round(matchScore * 100) / 100,
            fingerprint: {
              tag: compiled.targetFingerprint.tag,
              role: compiled.targetFingerprint.role,
              ariaLabel: compiled.targetFingerprint.ariaLabel,
              placeholder: compiled.targetFingerprint.placeholder,
            },
          });
          // Skip this locator, try next one
          continue;
        }

        logger.debug('[COMPILED_EXECUTOR] Fingerprint validated', {
          strategy: entry.strategy,
          matchScore: Math.round(matchScore * 100) / 100,
        });
      }

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

    if (result.failureKind === 'ambiguous') {
      sawAmbiguous = true;
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
    skipReason: sawAmbiguous ? 'ambiguous' : 'locator_failed',
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
  let resolutionPath: 'compiled' | 'self_heal' | undefined;

  if (result.success) {
    runtimeStatus = 'executed';
    confidenceTier = (result.confidence ?? 0) >= 0.8 ? 'high' :
                     (result.confidence ?? 0) >= 0.6 ? 'medium' : 'low';
    resolutionPath = 'compiled';
  } else if (healResult?.success) {
    runtimeStatus = 'healed';
    source = 'self_heal';
    confidenceTier = (healResult.confidence ?? 0) >= 0.85 ? 'medium' : 'low';
    resolutionPath = 'self_heal';
  }

  const meta: StepRuntimeMeta = {
    runtimeStatus,
    source,
    confidenceTier,
    executionMs,
    usedLocatorStrategy: result.usedStrategy,
    compiledExpired: result.expired,
    pageSignatureMatched: result.signatureMatched,
    resolutionPath,
  };

  // Add failure reason and explanation if failed
  if (runtimeStatus === 'failed') {
    switch (result.skipReason) {
      case 'signature_mismatch':
        meta.failedReason = 'element_not_found';
        meta.failureExplanation = 'Page structure changed significantly since step was created. Element locators no longer match current page.';
        break;
      case 'expired':
        meta.failedReason = 'element_not_found';
        meta.failureExplanation = 'Compiled locator plan expired (too old). Re-linting recommended.';
        break;
      case 'locator_failed':
        meta.failedReason = 'element_not_found';
        meta.failureExplanation = 'All compiled locators failed to find element. Element may have been removed or changed.';
        break;
      case 'ambiguous':
        meta.failedReason = 'element_not_found';
        meta.failureExplanation = 'Multiple elements matched the locator. Cannot determine which element to interact with without user clarification.';
        break;
      default:
        meta.failedReason = 'unknown';
        meta.failureExplanation = 'Unknown failure reason.';
    }
  }

  // Flag for review if healed with low confidence or compiled failed
  if (runtimeStatus === 'healed' && confidenceTier === 'low') {
    meta.needsReview = true;
    meta.flaky = true;
    meta.healConfidence = healResult?.confidence;
    meta.failureExplanation = `Self-healing succeeded but with low confidence (${Math.round((healResult?.confidence ?? 0) * 100)}%). Manual review recommended.`;
  }

  return meta;
}
