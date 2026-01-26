/**
 * Preview Step Apply Service V2
 * Executes a single step in the preview session
 * Features: ownership enforcement, post-action verification, state-aware retries
 */

import { logger } from '@/utils/core/logger';
import { sanitizeUrl } from '@/utils/validation/validation';
import type { Page } from 'playwright';
import { IntentStepLintService } from './intent-step-lint.service';
import { getPreviewSessionService } from './preview-session.service';
import type {
  IntentStep,
  InteractiveNode,
  LintCandidate,
} from './preview.types';

// Max attempts to try different candidates
const MAX_ATTEMPTS = 3;
const ACTION_TIMEOUT = 10000; // 10 seconds
const POST_ACTION_SETTLE_TIMEOUT = 5000; // 5 seconds

// V2: Action types that support state verification
const STATE_VERIFIABLE_ACTIONS = new Set(['check', 'uncheck', 'toggle', 'open', 'close', 'fill', 'click']);

/**
 * Result of step application (V2: enhanced)
 */
interface ApplyResult {
  success: boolean;
  error?: string;
  appliedStep?: IntentStep;
  urlChanged?: boolean;
  url?: string;
  highlight?: Array<{
    ref?: string;
    boundingBox?: { x: number; y: number; width: number; height: number };
    type: 'success' | 'warning' | 'error';
  }>;
  attempts?: number;
  /** V2: Whether action was verified post-execution */
  verified?: boolean;
  /** V2: State change detected */
  stateChange?: {
    before?: Partial<InteractiveNode>;
    after?: Partial<InteractiveNode>;
  };
}

/**
 * V2: Verify that an action had the expected effect
 */
async function verifyActionEffect(
  page: Page,
  step: IntentStep,
  ref: string
): Promise<boolean> {
  const selector = `[data-agent-ref="${ref}"]`;

  try {
    switch (step.type) {
      case 'check': {
        const checked = await page.locator(selector).isChecked();
        return checked === true;
      }

      case 'uncheck': {
        const checked = await page.locator(selector).isChecked();
        return checked === false;
      }

      case 'toggle': {
        // For toggle, we just verify the element is still interactive
        const isVisible = await page.locator(selector).isVisible();
        return isVisible;
      }

      case 'open': {
        const expanded = await page.locator(selector).getAttribute('aria-expanded');
        return expanded === 'true';
      }

      case 'close': {
        const expanded = await page.locator(selector).getAttribute('aria-expanded');
        return expanded !== 'true';
      }

      case 'fill': {
        // Verify the input has a value
        const value = await page.locator(selector).inputValue().catch(() => '');
        return value.length > 0 || step.value === ''; // Empty fill is valid
      }

      case 'click': {
        // For click, verification is tricky - we assume success if no error
        return true;
      }

      default:
        return true; // Non-verifiable actions assumed successful
    }
  } catch {
    return false;
  }
}

/**
 * Execute an action on the page
 */
async function executeAction(
  page: Page,
  step: IntentStep,
  candidate: LintCandidate
): Promise<{ success: boolean; error?: string; urlChanged: boolean }> {
  const urlBefore = page.url();

  try {
    // Build selector from candidate
    const selector = candidate.ref
      ? `[data-agent-ref="${candidate.ref}"]`
      : undefined;

    if (!selector && step.type !== 'navigate' && step.type !== 'wait') {
      return { success: false, error: 'No valid selector for element', urlChanged: false };
    }

    switch (step.type) {
      case 'fill': {
        if (!selector) throw new Error('No selector for fill action');
        const value = step.value || '';
        if (step.options?.replaceContent === false) {
          await page.click(selector, { timeout: ACTION_TIMEOUT });
          await page.type(selector, value, { timeout: ACTION_TIMEOUT });
        } else {
          await page.fill(selector, value, { timeout: ACTION_TIMEOUT });
        }
        if (step.options?.pressEnter) {
          await page.press(selector, 'Enter', { timeout: ACTION_TIMEOUT });
        }
        break;
      }

      case 'click': {
        if (!selector) throw new Error('No selector for click action');
        await page.click(selector, { timeout: ACTION_TIMEOUT });
        break;
      }

      case 'select': {
        if (!selector) throw new Error('No selector for select action');
        await page.selectOption(selector, step.value || '', { timeout: ACTION_TIMEOUT });
        break;
      }

      case 'hover': {
        if (!selector) throw new Error('No selector for hover action');
        await page.hover(selector, { timeout: ACTION_TIMEOUT });
        break;
      }

      case 'press': {
        if (!selector) throw new Error('No selector for press action');
        const key = step.value || 'Enter';
        await page.press(selector, key, { timeout: ACTION_TIMEOUT });
        break;
      }

      case 'scroll': {
        if (selector) {
          await page.locator(selector).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
        } else {
          // Scroll down by 300px
          await page.evaluate(() => {
            // @ts-ignore - window is available in browser context
            (globalThis as any).scrollBy(0, 300);
          });
        }
        break;
      }

      case 'wait': {
        const timeout = step.options?.timeout || 1000;
        await page.waitForTimeout(timeout);
        break;
      }

      case 'navigate': {
        if (!step.value) throw new Error('No URL for navigate action');
        const safeUrl = sanitizeUrl(step.value);
        await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      }

      case 'assert': {
        if (!selector) throw new Error('No selector for assert action');
        const element = page.locator(selector);
        await element.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V2: New state-aware action types
      // ═══════════════════════════════════════════════════════════════════════
      case 'check': {
        if (!selector) throw new Error('No selector for check action');
        await page.locator(selector).check({ timeout: ACTION_TIMEOUT });
        break;
      }

      case 'uncheck': {
        if (!selector) throw new Error('No selector for uncheck action');
        await page.locator(selector).uncheck({ timeout: ACTION_TIMEOUT });
        break;
      }

      case 'toggle': {
        if (!selector) throw new Error('No selector for toggle action');
        // Toggle: click the element (works for checkboxes, switches, toggles)
        await page.click(selector, { timeout: ACTION_TIMEOUT });
        break;
      }

      case 'open': {
        if (!selector) throw new Error('No selector for open action');
        // Open: click to expand (dropdown, accordion, menu)
        // First check if already open
        const isExpanded = await page.locator(selector).getAttribute('aria-expanded');
        if (isExpanded !== 'true') {
          await page.click(selector, { timeout: ACTION_TIMEOUT });
        }
        break;
      }

      case 'close': {
        if (!selector) throw new Error('No selector for close action');
        // Close: click to collapse (dropdown, accordion, menu)
        const isExpanded = await page.locator(selector).getAttribute('aria-expanded');
        if (isExpanded === 'true') {
          await page.click(selector, { timeout: ACTION_TIMEOUT });
        }
        break;
      }

      default:
        return { success: false, error: `Unknown action type: ${step.type}`, urlChanged: false };
    }

    const urlAfter = page.url();
    return { success: true, urlChanged: urlBefore !== urlAfter };
  } catch (error) {
    logger.warn('[PREVIEW_APPLY] Action execution failed', {
      stepType: step.type,
      candidateRef: candidate.ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Action failed',
      urlChanged: page.url() !== urlBefore,
    };
  }
}

/**
 * Preview Step Apply Service
 */
export class PreviewStepApplyService {
  /**
   * Apply a step in the preview session
   * Tries top candidates with limited retries
   */
  static async applyStep(params: {
    previewSessionId: string;
    stepDraft: IntentStep;
    pageRef?: string;
    userId: string;
  }): Promise<ApplyResult> {
    const { previewSessionId, stepDraft, userId } = params;

    logger.info('[PREVIEW_APPLY] Applying step', {
      previewSessionId,
      stepType: stepDraft.type,
      description: stepDraft.description,
    });

    try {
      // Get page from session
      const sessionService = getPreviewSessionService();
      const page = sessionService.getPage(previewSessionId, userId);

      if (!page) {
        return {
          success: false,
          error: 'Preview session not found or expired',
        };
      }

      // Lint the step to get candidates
      const lintResult = await IntentStepLintService.lintStep({
        previewSessionId,
        stepDraft,
        userId,
      });

      // Handle non-targeting actions
      if (['navigate', 'wait'].includes(stepDraft.type)) {
        const result = await executeAction(page, stepDraft, { label: '', reason: '', confidence: 1 });
        return {
          success: result.success,
          error: result.error,
          appliedStep: stepDraft,
          urlChanged: result.urlChanged,
          url: page.url(),
          attempts: 1,
        };
      }

      if (lintResult.status === 'not_found' || lintResult.candidates.length === 0) {
        return {
          success: false,
          error: lintResult.message || 'No matching elements found',
          highlight: [],
        };
      }

      // Try candidates in order
      const candidatesToTry = lintResult.candidates.slice(0, MAX_ATTEMPTS);
      let lastError: string | undefined;
      let attempts = 0;

      for (const candidate of candidatesToTry) {
        attempts++;
        logger.debug('[PREVIEW_APPLY] Trying candidate', {
          attempt: attempts,
          ref: candidate.ref,
          confidence: candidate.confidence,
        });

        const result = await executeAction(page, stepDraft, candidate);

        if (result.success) {
          // Wait for page to settle
          await page.waitForLoadState('networkidle', { timeout: POST_ACTION_SETTLE_TIMEOUT }).catch(() => { });

          // V2: Post-action verification for state-aware actions
          let verified = false;
          const stateChange: ApplyResult['stateChange'] = undefined;

          if (STATE_VERIFIABLE_ACTIONS.has(stepDraft.type) && candidate.ref) {
            try {
              verified = await verifyActionEffect(page, stepDraft, candidate.ref);
              if (verified) {
                logger.debug('[PREVIEW_APPLY] Action verified', {
                  stepType: stepDraft.type,
                  candidateRef: candidate.ref,
                });
              }
            } catch (verifyError) {
              logger.warn('[PREVIEW_APPLY] Verification failed', {
                error: verifyError instanceof Error ? verifyError.message : String(verifyError),
              });
            }
          }

          // Update step evidence
          const updatedStep: IntentStep = {
            ...stepDraft,
            evidence: {
              ...stepDraft.evidence,
              lastSuccessRef: candidate.ref,
              confidence: candidate.confidence,
            },
          };

          return {
            success: true,
            appliedStep: updatedStep,
            urlChanged: result.urlChanged,
            url: page.url(),
            highlight: [{
              ref: candidate.ref,
              boundingBox: candidate.boundingBox,
              type: 'success',
            }],
            attempts,
            verified,
            stateChange,
          };
        }

        lastError = result.error;
      }

      // All attempts failed
      return {
        success: false,
        error: lastError || 'All candidates failed',
        highlight: candidatesToTry.map(c => ({
          ref: c.ref,
          boundingBox: c.boundingBox,
          type: 'error' as const,
        })),
        attempts,
      };
    } catch (error) {
      logger.error('[PREVIEW_APPLY] Apply failed', {
        error: error instanceof Error ? error.message : String(error),
        previewSessionId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Apply failed',
      };
    }
  }
}
