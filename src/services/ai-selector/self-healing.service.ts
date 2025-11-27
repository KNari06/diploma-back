/**
 * Self-Healing Service
 * Automatically repairs broken selectors using AI Selector Engine
 */

import { logger } from '@/utils/logger';
import { Page } from 'playwright';
import { AISelectorEngine } from './ai-selector-engine.service';
import { DOMNodeExtractor } from './dom-node-extractor';
import type { SelfHealingResult, SelectorType } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// SELF-HEALING SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class SelfHealingService {
  /**
   * Attempt to heal a broken selector
   * Called when element is not found during test execution
   */
  static async healSelector(params: {
    oldSelector: string; // Selector that failed
    intent: string; // What we're trying to do (from action.description)
    page: Page; // Current page
    errorMessage: string; // Error from Playwright
    metadata: {
      url: string;
      projectId?: string;
      userId?: string;
    };
    mode?: 'fast' | 'accurate'; // Fast: DOM only, Accurate: + screenshot
  }): Promise<SelfHealingResult> {
    const { oldSelector, intent, page, errorMessage, metadata, mode = 'fast' } = params;

    logger.info('[SELF_HEALING] Attempting to heal selector', {
      oldSelector,
      intent: intent.substring(0, 100),
      mode,
      url: metadata.url,
    });

    const startTime = Date.now();

    try {
      // Step 1: Extract current DOM nodes
      const nodes = await DOMNodeExtractor.extractNodes(page, {
        visibleOnly: true,
        interactiveOnly: true, // Only interactive elements
      });

      if (nodes.length === 0) {
        logger.warn('[SELF_HEALING] No interactive elements found on page');
        return {
          success: false,
          oldSelector,
          diff: {
            what_changed: 'Page has no interactive elements',
            old_strategy: this.detectSelectorType(oldSelector),
            new_strategy: 'css',
            confidence: 0,
          },
          suggestion: 'Page may not be loaded or has no interactive elements',
          autoApplied: false,
        };
      }

      // Step 2: Get page DOM and optionally screenshot
      const [dom, screenshot] = await Promise.all([
        page.content(),
        mode === 'accurate' ? page.screenshot({ type: 'png' }).then(b => b.toString('base64')) : Promise.resolve(undefined),
      ]);

      // Step 3: Get viewport
      const viewport = page.viewportSize() || { width: 1920, height: 1080 };

      // Step 4: Resolve new selector using AI
      const resolveResult = await AISelectorEngine.resolve({
        intent,
        dom,
        nodes,
        screenshot,
        metadata: {
          url: metadata.url,
          viewport,
          projectId: metadata.projectId,
          userId: metadata.userId,
        },
        mode,
      });

      // Step 5: Check if resolution successful
      if (!resolveResult.success || !resolveResult.selectedNode) {
        logger.warn('[SELF_HEALING] Failed to find replacement selector', {
          oldSelector,
          intent,
        });

        return {
          success: false,
          oldSelector,
          diff: {
            what_changed: 'No suitable replacement found',
            old_strategy: this.detectSelectorType(oldSelector),
            new_strategy: 'css',
            confidence: 0,
          },
          suggestion: resolveResult.explanation,
          autoApplied: false,
        };
      }

      // Step 6: Test new selector
      const newSelector = resolveResult.selectedNode.primarySelector;
      const isWorking = await this.testSelector(page, newSelector);

      if (!isWorking) {
        logger.warn('[SELF_HEALING] New selector does not work', {
          oldSelector,
          newSelector,
        });

        return {
          success: false,
          oldSelector,
          newSelector,
          diff: {
            what_changed: 'Found selector but it does not work',
            old_strategy: this.detectSelectorType(oldSelector),
            new_strategy: resolveResult.selectedNode.selectorType,
            confidence: resolveResult.selectedNode.confidence,
          },
          suggestion: `Tried ${newSelector} but it failed validation`,
          autoApplied: false,
        };
      }

      // Step 7: Build success result
      const oldStrategy = this.detectSelectorType(oldSelector);
      const newStrategy = resolveResult.selectedNode.selectorType;

      const whatChanged = this.describeWhatChanged(
        oldSelector,
        newSelector,
        oldStrategy,
        newStrategy
      );

      const duration = Date.now() - startTime;

      logger.info('[SELF_HEALING] Successfully healed selector', {
        oldSelector,
        newSelector,
        duration: `${duration}ms`,
        confidence: resolveResult.selectedNode.confidence,
      });

      // Auto-apply if confidence is high
      const autoApplied = resolveResult.selectedNode.confidence >= 0.85;

      return {
        success: true,
        oldSelector,
        newSelector,
        diff: {
          what_changed: whatChanged,
          old_strategy: oldStrategy,
          new_strategy: newStrategy,
          confidence: resolveResult.selectedNode.confidence,
        },
        suggestion: autoApplied
          ? `Auto-applied: ${newSelector}`
          : `Suggestion: Use ${newSelector} (confidence: ${(resolveResult.selectedNode.confidence * 100).toFixed(0)}%)`,
        autoApplied,
      };
    } catch (error) {
      logger.error('[SELF_HEALING] Healing failed', {
        error,
        oldSelector,
        intent,
      });

      return {
        success: false,
        oldSelector,
        diff: {
          what_changed: 'Healing process failed',
          old_strategy: this.detectSelectorType(oldSelector),
          new_strategy: 'css',
          confidence: 0,
        },
        suggestion: `Healing failed: ${error instanceof Error ? error.message : String(error)}`,
        autoApplied: false,
      };
    }
  }

  /**
   * Test if a selector works on the page
   */
  private static async testSelector(page: Page, selector: string): Promise<boolean> {
    try {
      // Try to find element
      const count = await page.locator(selector).count();
      if (count === 0) return false;

      // Check if element is visible
      const isVisible = await page.locator(selector).first().isVisible();
      return isVisible;
    } catch (error) {
      logger.debug('[SELF_HEALING] Selector test failed', { selector, error });
      return false;
    }
  }

  /**
   * Detect selector type from selector string
   */
  private static detectSelectorType(selector: string): SelectorType {
    if (selector.startsWith('getByRole(')) return 'getByRole';
    if (selector.startsWith('getByLabel(')) return 'getByLabel';
    if (selector.startsWith('getByText(')) return 'getByText';
    if (selector.includes('[data-testid=')) return 'data-testid';
    if (selector.startsWith('//')) return 'xpath';
    return 'css';
  }

  /**
   * Describe what changed between old and new selector
   */
  private static describeWhatChanged(
    oldSelector: string,
    newSelector: string,
    oldStrategy: SelectorType,
    newStrategy: SelectorType
  ): string {
    // Strategy changed
    if (oldStrategy !== newStrategy) {
      return `Strategy changed from ${oldStrategy} to ${newStrategy}`;
    }

    // Same strategy, different selector
    if (oldStrategy === 'css') {
      // Check if class changed
      if (oldSelector.includes('.') && newSelector.includes('.')) {
        return 'CSS classes changed';
      }
      // Check if ID changed
      if (oldSelector.includes('#') && newSelector.includes('#')) {
        return 'Element ID changed';
      }
      return 'CSS selector structure changed';
    }

    if (oldStrategy === 'getByRole') {
      return 'ARIA role or name changed';
    }

    if (oldStrategy === 'getByText') {
      return 'Element text content changed';
    }

    if (oldStrategy === 'data-testid') {
      return 'data-testid attribute changed';
    }

    return 'Selector changed';
  }
}
