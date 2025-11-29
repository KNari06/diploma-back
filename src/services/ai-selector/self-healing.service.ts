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

      // Step 6: Test new selector with dry-run validation
      const newSelector = resolveResult.selectedNode.primarySelector;
      const testResult = await this.testSelectorWithDryRun(page, newSelector);

      if (!testResult.works) {
        logger.warn('[SELF_HEALING] New selector does not work', {
          oldSelector,
          newSelector,
          count: testResult.count,
          isVisible: testResult.isVisible,
          error: testResult.error,
        });

        // ✅ NEW: Try fallback selectors if primary fails
        if (resolveResult.fallbackSelectors && resolveResult.fallbackSelectors.length > 0) {
          logger.info('[SELF_HEALING] Trying fallback selectors', {
            count: resolveResult.fallbackSelectors.length,
          });

          for (const fallback of resolveResult.fallbackSelectors) {
            const fallbackTest = await this.testSelectorWithDryRun(page, fallback.selector);
            if (fallbackTest.works) {
              logger.info('[SELF_HEALING] Fallback selector works!', {
                selector: fallback.selector,
                type: fallback.type,
              });

              // Use fallback selector instead
              const fallbackDuration = Date.now() - startTime;
              return this.buildSuccessResult(
                oldSelector,
                fallback.selector,
                fallback.type,
                fallback.confidence,
                fallbackDuration
              );
            }
          }
        }

        return {
          success: false,
          oldSelector,
          newSelector,
          diff: {
            what_changed: `Found selector but validation failed: ${testResult.error || 'not visible or not unique'}`,
            old_strategy: this.detectSelectorType(oldSelector),
            new_strategy: resolveResult.selectedNode.selectorType,
            confidence: resolveResult.selectedNode.confidence,
          },
          suggestion: `Tried ${newSelector} but it failed validation (count: ${testResult.count}, visible: ${testResult.isVisible})`,
          autoApplied: false,
        };
      }

      // Step 7: Build success result
      const duration = Date.now() - startTime;
      return this.buildSuccessResult(
        oldSelector,
        newSelector,
        resolveResult.selectedNode.selectorType,
        resolveResult.selectedNode.confidence,
        duration
      );
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
   * ✅ DEPRECATED: Use testSelectorWithDryRun() instead
   * Kept for backwards compatibility
   */
  private static async testSelector(page: Page, selector: string): Promise<boolean> {
    const result = await this.testSelectorWithDryRun(page, selector);
    return result.works;
  }

  /**
   * ✅ NEW: Test selector with dry-run validation
   * Returns detailed information about why selector works or doesn't work
   * Uses getLocator() helper to support all Playwright formats (text=, role=, label=)
   */
  private static async testSelectorWithDryRun(page: Page, selector: string): Promise<{
    works: boolean;
    count: number;
    isVisible: boolean;
    error?: string;
  }> {
    try {
      // ✅ CRITICAL FIX: Use getLocator() helper instead of page.locator()
      // This ensures we support text=, role=, label= formats
      const locator = this.getLocatorForPage(page, selector);
      const count = await locator.count();

      if (count === 0) {
        return {
          works: false,
          count: 0,
          isVisible: false,
          error: 'No elements found',
        };
      }

      // Check if element is visible (with short timeout)
      const isVisible = await locator.first().isVisible({ timeout: 2000 }).catch(() => false);

      // ✅ STRICT: Only works if exactly 1 element and visible
      // Multiple elements = ambiguous selector
      return {
        works: count === 1 && isVisible,
        count,
        isVisible,
        error: count > 1 ? `Multiple elements found (${count})` : !isVisible ? 'Element not visible' : undefined,
      };
    } catch (error) {
      logger.debug('[SELF_HEALING] Selector test failed', { selector, error });
      return {
        works: false,
        count: 0,
        isVisible: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * ✅ NEW: Get Playwright locator for a page (duplicated from CommandExecutor)
   * This is needed because SelfHealingService doesn't have access to CommandExecutor instance
   * TODO: Extract to shared utility if this grows
   * @returns Locator - all Playwright methods return Locator type
   */
  private static getLocatorForPage(page: Page, selector: string): import('playwright').Locator {
    if (!selector) {
      throw new Error('Selector is required');
    }

    const s = selector.trim();

    // 1. Handle text= format
    const textMatch = s.match(/^text\s*=\s*(.+)$/i);
    if (textMatch) {
      let payload = textMatch[1].trim();
      const regexMatch = payload.match(/^\/(.+?)\/([gimsuy]*)$/);
      if (regexMatch) {
        return page.getByText(new RegExp(regexMatch[1], regexMatch[2]));
      }
      payload = payload.replace(/^["']|["']$/g, '');
      const isExact = textMatch[1].includes('"') || textMatch[1].includes("'");
      return page.getByText(payload, { exact: isExact });
    }

    // 2. Handle label= format
    const labelMatch = s.match(/^label\s*=\s*(.+)$/i);
    if (labelMatch) {
      const label = labelMatch[1].trim().replace(/^["']|["']$/g, '');
      return page.getByLabel(label);
    }

    // 3. Handle role= format
    const roleMatch = s.match(/^role\s*=\s*([^\[\s]+)(?:\s*\[name\s*=\s*(.+?)\])?$/i);
    if (roleMatch) {
      const role = roleMatch[1].trim() as any;
      let name = roleMatch[2]?.trim();
      if (name) {
        const nameRegexMatch = name.match(/^\/(.+?)\/([gimsuy]*)$/);
        if (nameRegexMatch) {
          return page.getByRole(role, { name: new RegExp(nameRegexMatch[1], nameRegexMatch[2]) });
        }
        name = name.replace(/^["']|["']$/g, '');
        return page.getByRole(role, { name });
      }
      return page.getByRole(role);
    }

    // 4. Handle contextual locators
    if (s.includes('>>') || s.includes(':has-text(') || s.includes(':has(') || s.includes(':scope')) {
      return page.locator(s);
    }

    // 5. Handle XPath
    if (s.match(/^(xpath\s*=\s*)?\/{1,2}/i)) {
      const xpath = s.startsWith('xpath=') ? s.slice(6).trim() : s;
      return page.locator(`xpath=${xpath}`);
    }

    // 6. CSS selector (default)
    return page.locator(s);
  }

  /**
   * ✅ NEW: Build success result (extracted for reuse with fallback selectors)
   */
  private static buildSuccessResult(
    oldSelector: string,
    newSelector: string,
    newStrategy: SelectorType,
    confidence: number,
    duration: number
  ): SelfHealingResult {
    const oldStrategy = this.detectSelectorType(oldSelector);
    const whatChanged = this.describeWhatChanged(oldSelector, newSelector, oldStrategy, newStrategy);
    const autoApplied = confidence >= 0.8;

    logger.info('[SELF_HEALING] Successfully healed selector', {
      oldSelector,
      newSelector,
      whatChanged,
      confidence,
      autoApplied,
      duration: `${duration}ms`,
    });

    return {
      success: true,
      oldSelector,
      newSelector,
      diff: {
        what_changed: whatChanged,
        old_strategy: oldStrategy,
        new_strategy: newStrategy,
        confidence,
      },
      suggestion: autoApplied
        ? `Auto-applied: ${newSelector}`
        : `Suggestion: Use ${newSelector} (confidence: ${(confidence * 100).toFixed(0)}%)`,
      autoApplied,
    };
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
