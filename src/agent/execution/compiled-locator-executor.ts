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
  /** Ambiguity details — which strategies hit multiple elements and how many */
  ambiguityDetails?: Array<{ strategy: string; matchCount: number }>;
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
 *
 * Note: Recording (preview-session) stores a base64-encoded signature
 * (url|nodeCount|refs), while replay computes tag:type:name:id:role strings.
 * When formats are incompatible, we return matched=true to avoid false negatives
 * — the locator plan itself (with fingerprint validation) is the real guard.
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

  // Detect format mismatch: recording stores base64 (no ':' inside parts),
  // replay computes "tag:type:name:id:role" (always contains ':'). If the compiled
  // signature has no ':' in any split part, it's base64-encoded from recording —
  // comparison is meaningless, treat as matched and let fingerprint validation guard.
  const compiledParts = compiledSignature.split('|');
  const isBase64Signature = compiledParts.length <= 1 || compiledParts.every(p => !p.includes(':'));

  if (isBase64Signature) {
    logger.debug('[COMPILED_EXECUTOR] Compiled signature is base64 format (from recording), skipping comparison', {
      compiledSignaturePreview: compiledSignature.slice(0, 30),
    });
    return { matched: true, currentSignature };
  }

  // Both signatures use the same tag:type:name:id:role format — compare overlap
  const compiledSet = new Set(compiledParts);
  const currentParts = currentSignature.split('|');

  if (compiledSet.size === 0 || currentParts.length === 0) {
    return { matched: true, currentSignature };
  }

  let matchCount = 0;
  for (const part of currentParts) {
    if (compiledSet.has(part)) {
      matchCount++;
    }
  }

  const matchRatio = matchCount / Math.max(compiledSet.size, currentParts.length);
  const matched = matchRatio >= 0.6;

  logger.debug('[COMPILED_EXECUTOR] Page signature check', {
    matched,
    matchRatio: Math.round(matchRatio * 100),
    compiledPartsCount: compiledSet.size,
    currentPartsCount: currentParts.length,
  });

  return { matched, currentSignature };
}

/**
 * Quick fingerprint check to validate found element matches expected attributes.
 * Returns match score 0-1 (1 = perfect match).
 *
 * ── BUG FIX: Now checks ALL 8 fingerprint attributes ──
 * Previously only 4 were checked (tag, role, ariaLabel, placeholder).
 * Now also checks: labelText, testIdAttr, containerTitles, boundingBox.
 * This catches cases like two "Submit" buttons in different forms
 * (same tag/role but different containers/labels).
 */
async function quickFingerprintCheck(
  page: PageLike,
  locator: Locator,
  fingerprint: TargetFingerprint
): Promise<number> {
  try {
    const element = await locator.evaluate((el: any) => {
      // Extract associated label text
      let labelText: string | null = null;
      const doc = el.ownerDocument;
      if (el.id && doc) {
        const label = doc.querySelector(`label[for="${el.id}"]`);
        if (label) labelText = label.textContent?.trim() || null;
      }
      if (!labelText && el.closest?.('label')) {
        labelText = el.closest('label').textContent?.trim() || null;
      }

      // Extract container titles (nearest semantic containers)
      const containerTitles: string[] = [];
      let parent = el.parentElement;
      let depth = 0;
      while (parent && depth < 5) {
        const tag = parent.tagName?.toLowerCase();
        if (['fieldset', 'form', 'section', 'article', 'nav', 'dialog'].includes(tag)) {
          const legend = parent.querySelector(':scope > legend');
          const heading = parent.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
          const title = legend?.textContent?.trim() || heading?.textContent?.trim() || parent.getAttribute('aria-label') || '';
          if (title) containerTitles.push(title);
        } else if (parent.getAttribute('role') === 'group' || parent.getAttribute('role') === 'region') {
          const title = parent.getAttribute('aria-label') || '';
          if (title) containerTitles.push(title);
        }
        parent = parent.parentElement;
        depth++;
      }

      return {
        tag: el?.tagName?.toLowerCase(),
        role: el?.getAttribute?.('role'),
        ariaLabel: el?.getAttribute?.('aria-label'),
        placeholder: el?.getAttribute?.('placeholder'),
        labelText,
        testIdAttr: el?.getAttribute?.('data-testid'),
        containerTitles,
        boundingBox: el?.getBoundingClientRect ? (() => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })() : null,
      };
    });

    let matches = 0;
    let total = 0;

    // ── Core attributes (weighted: each counts as 1) ──

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

    // ── Extended attributes (also weighted: each counts as 1) ──

    // Compare labelText
    if (fingerprint.labelText) {
      total++;
      if (element.labelText === fingerprint.labelText) matches++;
    }

    // Compare testIdAttr
    if (fingerprint.testIdAttr) {
      total++;
      if (element.testIdAttr === fingerprint.testIdAttr) matches++;
    }

    // Compare containerTitles (at least one common container = match)
    if (fingerprint.containerTitles && fingerprint.containerTitles.length > 0) {
      total++;
      const fpContainers = new Set(fingerprint.containerTitles.map(c => c.toLowerCase()));
      const elContainers = (element.containerTitles || []).map((c: string) => c.toLowerCase());
      const hasCommon = elContainers.some((c: string) => fpContainers.has(c));
      if (hasCommon) matches++;
    }

    // Compare boundingBox (within 100px tolerance — catches major repositioning)
    if (fingerprint.boundingBox && element.boundingBox) {
      total++;
      const fp = fingerprint.boundingBox;
      const el = element.boundingBox;
      const dx = Math.abs(fp.x - el.x);
      const dy = Math.abs(fp.y - el.y);
      if (dx <= 100 && dy <= 100) matches++;
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

  // ── BUG FIX: Signature mismatch must skip compiled execution ──────────
  // Previously this check was performed but never enforced — locators ran
  // even on drastically different pages, risking wrong element interaction.
  if (!signatureCheck.matched) {
    logger.warn('[COMPILED_EXECUTOR] Page signature mismatch — skipping compiled plan', {
      compiledSignaturePreview: compiled.context?.pageSignature?.slice(0, 50),
      currentSignaturePreview: signatureCheck.currentSignature.slice(0, 50),
    });
    return {
      success: false,
      skipReason: 'signature_mismatch',
      signatureMatched: false,
      source: 'resolver',
    };
  }

  // Always filter out ref strategy — data-agent-ref attributes only exist during preview sessions,
  // not during background replay/regression. Trying ref locators wastes 5s per step on timeout.
  // Keep stable strategies (role, label, testId, placeholder, css) that work without injected refs.
  let locatorsToTry = compiled.locatorPlan.filter(entry => entry.strategy !== 'ref');

  if (locatorsToTry.length === 0) {
    logger.info('[COMPILED_EXECUTOR] Only ref locators in plan, skipping (refs not available during replay)', {
      originalCount: compiled.locatorPlan.length,
    });
    return {
      success: false,
      skipReason: 'no_plan',
      signatureMatched: signatureCheck.matched,
      source: 'resolver',
    };
  }

  if (locatorsToTry.length < compiled.locatorPlan.length) {
    logger.debug('[COMPILED_EXECUTOR] Filtered ref strategy from plan', {
      originalCount: compiled.locatorPlan.length,
      filteredCount: locatorsToTry.length,
      remainingStrategies: locatorsToTry.map(e => e.strategy),
    });
  }

  // 4. Try each locator in order
  let sawAmbiguous = false;
  const ambiguityDetails: Array<{ strategy: string; matchCount: number }> = [];
  for (const entry of locatorsToTry) {
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
        signatureMatched: signatureCheck.matched,
        source: 'compiled',
      };
    }

    if (result.failureKind === 'ambiguous') {
      sawAmbiguous = true;
      // Extract match count from error message (e.g., "Ambiguous: 3 elements matched")
      const countMatch = result.error?.match(/Ambiguous:\s*(\d+)/);
      ambiguityDetails.push({
        strategy: entry.strategy,
        matchCount: countMatch ? parseInt(countMatch[1], 10) : 0,
      });
    }

    logger.debug('[COMPILED_EXECUTOR] Locator failed, trying next', {
      strategy: entry.strategy,
      error: result.error,
    });
  }

  // All locators failed
  logger.warn('[COMPILED_EXECUTOR] All locators in plan failed', {
    sawAmbiguous,
    ambiguityDetails: ambiguityDetails.length > 0 ? ambiguityDetails : undefined,
  });
  return {
    success: false,
    skipReason: sawAmbiguous ? 'ambiguous' : 'locator_failed',
    expired: false,
    signatureMatched: signatureCheck.matched,
    source: 'resolver',
    ambiguityDetails: ambiguityDetails.length > 0 ? ambiguityDetails : undefined,
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
      case 'ambiguous': {
        meta.failedReason = 'element_not_found';
        const details = result.ambiguityDetails;
        if (details && details.length > 0) {
          const strategyInfo = details.map(d => `${d.strategy}(${d.matchCount} matches)`).join(', ');
          meta.failureExplanation = `Multiple elements matched compiled locators [${strategyInfo}]. Cannot determine which element to interact with.`;
        } else {
          meta.failureExplanation = 'Multiple elements matched the locator. Cannot determine which element to interact with.';
        }
        break;
      }
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
