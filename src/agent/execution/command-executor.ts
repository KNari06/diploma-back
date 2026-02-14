/* eslint-disable no-case-declarations */
import { AIExtractService } from '@/services/ai-extract';
import { SelfHealingService } from '@/services/ai-selector/self-healing.service';
import { AICostManager } from '@/services/ai/cost/ai-cost-manager.service';
import type { IntentPlaywrightCommand } from '@/services/testing/ui/preview/intent-step-converter.service';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import type { CompiledStepPlan, IntentStep, LocatorEntry, StepRuntimeMeta } from '@/services/testing/ui/preview/preview.types';
import { shouldSkipLookaheadAfter, waitForStepReadiness, type LookaheadResult } from '@/services/testing/ui/preview/step-readiness.service';
import { PlaywrightActionType, PlaywrightCommand } from '@/types';
import { logger } from '@/utils/core/logger';
import { Frame, Locator, Page } from 'playwright';
import { shouldPressEnterAfterFill } from '../utils/ai/enter-detection-ai';
import { getLocator, getSmartLocator, isSelectorRelatedError, normalizeSelector, validateAndGetLocator } from '../utils/selectors/selector-utils';
import { SelectorStabilityScore, SmartWaitService } from '../utils/selectors/smart-wait.service';
import { buildRuntimeMeta, executeCompiledLocatorPlan } from './compiled-locator-executor';

/**
 * Execute Playwright commands on a page
 * ✅ NEW: With AI self-healing support
 * ✅ V2: With compiled locator plan support for IntentStep execution
 */
export class CommandExecutor {
  private page: Page;
  private extractedData: Map<string, any> = new Map();
  private selfHealingEnabled: boolean = true;
  private metadata: { url: string; projectId?: string; userId?: string };
  private abortController: AbortController;
  private isAborted: boolean = false;
  private costManager?: AICostManager;
  private externalAbortHandler?: () => void; // ✅ FIX 1: Store handler for cleanup
  private selfHealingConfidenceThreshold: number = 0.85; // ✅ FIX 7: Configurable threshold
  private maxHealAttempts: number = 1; // ✅ V2: Limit self-heal attempts to expose flakiness
  /** Runtime metadata for each step (keyed by stepId) */
  private stepRuntimeMeta: Map<string, StepRuntimeMeta> = new Map();

  constructor(
    page: Page,
    options: {
      selfHealingEnabled?: boolean;
      metadata?: { url: string; projectId?: string; userId?: string };
      abortSignal?: AbortSignal;
      costManager?: AICostManager;
      selfHealingConfidenceThreshold?: number; // ✅ NEW: Configurable confidence
    } = {}
  ) {
    this.page = page;
    this.selfHealingEnabled = options.selfHealingEnabled ?? true;
    this.metadata = options.metadata || { url: '' };
    this.costManager = options.costManager;
    this.selfHealingConfidenceThreshold = options.selfHealingConfidenceThreshold ?? 0.85;

    this.abortController = new AbortController();

    // ✅ FIX 1: Store handler reference for cleanup
    if (options.abortSignal) {
      this.externalAbortHandler = () => this.abort();
      options.abortSignal.addEventListener('abort', this.externalAbortHandler, { once: true });
    }
  }

  /**
   * ✅ FIX 1: Cleanup resources (call when done with executor)
   */
  dispose(): void {
    // Cleanup is handled by { once: true } in addEventListener
    this.externalAbortHandler = undefined;
  }

  /**
   * Abort all ongoing operations
   */
  abort(): void {
    if (this.isAborted) return;

    this.isAborted = true;
    this.abortController.abort();

    logger.info('[COMMAND_EXECUTOR] Aborted - all operations cancelled');
  }

  /**
   * Check if aborted before executing operations
   */
  private checkAborted(): void {
    if (this.isAborted) {
      throw new Error('Operation aborted by user');
    }
  }

  /**
   * ✅ FIX 2: Normalize selector once (consistent handling)
   */
  private prepareSelector(selector: string | undefined): string | undefined {
    if (!selector) return undefined;
    return normalizeSelector(selector);
  }

  /**
   * Get locator from normalized selector
   */
  private getLocatorInternal(selector: string): Locator {
    return getLocator(this.page, selector);
  }

  /**
   * ✅ Get context-aware locator (page or iframe)
   * If iframe selector is provided, creates a frameLocator chain
   * @param selector The element selector
   * @param iframeSelector Optional iframe selector for actions within iframes
   * @returns Locator for the element (either in page or iframe context)
   */
  private getContextLocator(selector: string, iframeSelector?: string): Locator {
    if (iframeSelector) {
      // Element is within an iframe - use frameLocator
      logger.debug('[COMMAND_EXECUTOR] Using frameLocator for iframe context', {
        iframeSelector: iframeSelector.substring(0, 50),
        selector: selector.substring(0, 50),
      });
      return this.page.frameLocator(iframeSelector).locator(selector);
    } else {
      // Element is in main page context
      return getLocator(this.page, selector);
    }
  }

  /**
   * ✅ Resolve iframe Frame from iframe element selector.
   * Uses ElementHandle.contentFrame() to get the underlying Playwright Frame.
   * @param iframeSelector CSS selector for the iframe element
   * @param timeout Maximum time to wait for iframe to be attached/ready
   */
  private async getFrameFromIframeSelector(iframeSelector: string, timeout: number = 10000): Promise<Frame> {
    // Wait for the iframe element to exist in DOM
    const iframeHandle = await this.page.waitForSelector(iframeSelector, { timeout });
    const frame = await iframeHandle.contentFrame();
    if (!frame) {
      throw new Error(`Iframe content frame not available for selector: ${iframeSelector}`);
    }
    return frame;
  }

  /**
   * Execute a single command
   *
   * For IntentPlaywrightCommand (has intentMeta), uses:
   * 1. compiled.locatorPlan first (with pageSignature check + TTL expiry)
   * 2. Fallback to smart-locator
   * 3. Self-healing (with maxHealAttempts=1)
   *
   * Records StepRuntimeMeta for reporting.
   */
  async executeCommand(command: PlaywrightCommand): Promise<{
    success: boolean;
    error?: string;
    screenshot?: string;
    extractedValue?: any;
    /** Runtime metadata for intent-based commands */
    runtimeMeta?: StepRuntimeMeta;
  }> {
    this.checkAborted();

    const { action, value, url, timeout, continueOnError, description } = command;

    // ✅ V2: Check if this is an intent command (has intentMeta)
    const intentCommand = command as IntentPlaywrightCommand;
    const isIntentCommand = !!(intentCommand.intentMeta);

    // ✅ FIX 2: Normalize selector ONCE at the beginning
    const selector = this.prepareSelector(command.selector);
    const awaitNavigation = command.awaitNavigation ?? false; // ✅ FIX 3: Navigation flag

    // ✅ NEW: Log detailed command information before execution
    logger.info('[COMMAND_EXECUTOR] Executing command (FINAL)', {
      action,
      selector: {
        original: command.selector,
        normalized: selector,
      },
      value,
      url,
      description,
      awaitNavigation,
      timeout,
      continueOnError,
      waitFor: command.waitFor,
      assertion: command.assertion ? {
        type: command.assertion.type,
        expected: command.assertion.expected,
        operator: command.assertion.operator,
      } : undefined,
      isIntentCommand,
      intentStepId: intentCommand.intentMeta?.stepId,
      hasCompiledPlan: !!intentCommand.intentMeta?.compiled,
    });

    try {
      switch (action) {
        case 'goto':
          if (!url) throw new Error('URL is required for goto action');
          await this.page.goto(url, {
            waitUntil: command.waitFor || 'domcontentloaded',
            timeout: timeout || 30000,
          });
          break;

        case 'click':
          // ✅ FIX 3: Helper for click with optional navigation wait
          const performClick = async (locator: Locator) => {
            await this.forceScrollIntoView(locator);
            // ✅ Overlay guard: Ensure element is topmost before clicking
            await this.ensureTopMostAtCenter(locator, 2000);
            // ✅ Wait for enabled: Ensure element is not disabled
            await this.waitForEnabled(locator, 5000);
            if (awaitNavigation) {
              // Wait for navigation if expected
              await Promise.all([
                this.page.waitForNavigation({ timeout: timeout || 30000 }).catch(() => {
                  logger.debug('[COMMAND_EXECUTOR] Navigation timeout after click, continuing');
                }),
                locator.click({ timeout: timeout || 30000 }),
              ]);
            } else {
              await locator.click({ timeout: timeout || 30000 });
            }
          };

          // ✅ V2: Use intent-based locator resolution for IntentPlaywrightCommand
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentLocator } = await this.getLocatorForIntentCommand(
              intentCommand,
              'click',
              timeout || 30000
            );
            await performClick(intentLocator);
            break;
          }

          // Standard flow for non-intent commands
          if (!selector) throw new Error('Selector is required for click action');

          // ✅ NEW: Use smart locator to select the right element based on action context
          // This fixes the issue where text="Математика" finds <span> instead of <button>
          // Pass description as intent for AI disambiguation if needed
          const smartResult = await getSmartLocator(
            this.page,
            selector,
            'click',
            description // Intent for AI context
          );

          if (smartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used', {
              selector: selector.substring(0, 50),
              totalMatches: smartResult.totalMatches,
              selectedIndex: smartResult.selectedIndex,
            });
          }

          // Wait for element to be visible first
          try {
            await smartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await performClick(smartResult.locator);
          } catch (clickError) {
            // Smart locator failed, try self-healing
            logger.warn('[COMMAND_EXECUTOR] Smart locator click failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: clickError instanceof Error ? clickError.message : String(clickError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.waitFor({ state: 'visible', timeout: timeout || 30000 });
                await performClick(locator);
              },
              {
                selector,
                intent: description || 'click element',
                action: 'click',
                timeout,
              }
            );
          }
          break;

        case 'type':
          if (value === undefined) throw new Error('Value is required for type action');

          // ✅ V2: Use intent-based locator resolution for IntentPlaywrightCommand
          if (isIntentCommand && intentCommand.intentMeta) {
            const { locator: intentTypeLocator } = await this.getLocatorForIntentCommand(
              intentCommand,
              'type',
              timeout || 30000
            );
            await intentTypeLocator.fill(String(value), { timeout: timeout || 30000 });

            // AI-powered Enter key detection
            const shouldPressIntent = await shouldPressEnterAfterFill(intentTypeLocator, this.page, description);
            if (shouldPressIntent) {
              await intentTypeLocator.press('Enter', { timeout: timeout || 5000 });
            }
            break;
          }

          // Standard flow for non-intent commands
          if (!selector) throw new Error('Selector is required for type action');

          // ✅ NEW: Use smart locator to select the right input element
          const typeSmartResult = await getSmartLocator(
            this.page,
            selector,
            'type',
            description // Intent for AI context
          );

          if (typeSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for type', {
              selector: selector.substring(0, 50),
              totalMatches: typeSmartResult.totalMatches,
              selectedIndex: typeSmartResult.selectedIndex,
            });
          }

          try {
            await typeSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await typeSmartResult.locator.fill(String(value), { timeout: timeout || 30000 });

            // ✅ AI-powered Enter key detection
            const shouldPress = await shouldPressEnterAfterFill(
              typeSmartResult.locator,
              this.page,
              description
            );

            if (shouldPress) {
              logger.info('[COMMAND_EXECUTOR] AI decided to press Enter after type', {
                selector: selector.substring(0, 50),
              });
              await typeSmartResult.locator.press('Enter', { timeout: timeout || 5000 });
            }
          } catch (typeError) {
            // Smart locator failed, try self-healing
            logger.warn('[COMMAND_EXECUTOR] Smart locator type failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: typeError instanceof Error ? typeError.message : String(typeError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.fill(String(value), { timeout: timeout || 30000 });

                // ✅ AI-powered Enter key detection (self-healing path)
                const shouldPress = await shouldPressEnterAfterFill(locator, this.page, description);
                if (shouldPress) {
                  logger.info('[COMMAND_EXECUTOR] AI decided to press Enter after type (self-healing)');
                  await locator.press('Enter', { timeout: timeout || 5000 });
                }
              },
              {
                selector,
                intent: description || `type with ${value}`,
                action: 'type',
                timeout,
                value,
              }
            );
          }
          // Note: Post-action analysis handled by PostActionAnalyzer
          break;

        case 'select':
          if (!selector) throw new Error('Selector is required for select action');
          if (value === undefined) throw new Error('Value is required for select action');

          // ✅ NEW: Use smart locator to select the right select element
          const selectSmartResult = await getSmartLocator(
            this.page,
            selector,
            'select',
            description // Intent for AI context
          );

          if (selectSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for select', {
              selector: selector.substring(0, 50),
              totalMatches: selectSmartResult.totalMatches,
              selectedIndex: selectSmartResult.selectedIndex,
            });
          }

          // ✅ FIX 5: Support multiple selectOption formats
          const selectValue = this.parseSelectValue(value);

          try {
            await selectSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            // ✅ Wait for enabled: Ensure select is not disabled
            await this.waitForEnabled(selectSmartResult.locator, 5000);
            // ✅ Wait for options: Ensure select has options available
            await this.waitForSelectOptions(selectSmartResult.locator, 5000, 3);
            await selectSmartResult.locator.selectOption(selectValue, { timeout: timeout || 30000 });
          } catch (selectError) {
            // Smart locator failed, try self-healing
            logger.warn('[COMMAND_EXECUTOR] Smart locator select failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: selectError instanceof Error ? selectError.message : String(selectError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                // ✅ Wait for enabled in self-healing path too
                await this.waitForEnabled(locator, 5000);
                // ✅ Wait for options in self-healing path too
                await this.waitForSelectOptions(locator, 5000, 3);
                await locator.selectOption(selectValue, { timeout: timeout || 30000 });
              },
              {
                selector,
                intent: description || `select ${value}`,
                action: 'select',
                timeout,
                value,
              }
            );
          }
          break;

        case 'check':
          if (!selector) throw new Error('Selector is required for check action');

          // ✅ NEW: Use smart locator for check action
          const checkSmartResult = await getSmartLocator(
            this.page,
            selector,
            'check', // Uses checkbox preferences
            description
          );

          if (checkSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for check', {
              selector: selector.substring(0, 50),
              totalMatches: checkSmartResult.totalMatches,
              selectedIndex: checkSmartResult.selectedIndex,
            });
          }

          try {
            await checkSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            // ✅ Wait for enabled: Ensure checkbox is not disabled
            await this.waitForEnabled(checkSmartResult.locator, 5000);
            await checkSmartResult.locator.check({ timeout: timeout || 30000 });
          } catch (checkError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator check failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: checkError instanceof Error ? checkError.message : String(checkError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                // ✅ Wait for enabled in self-healing path too
                await this.waitForEnabled(locator, 5000);
                await locator.check({ timeout: timeout || 30000 });
              },
              {
                selector,
                intent: description || 'check checkbox',
                action: 'check',
                timeout,
              }
            );
          }
          break;

        case 'uncheck':
          if (!selector) throw new Error('Selector is required for uncheck action');

          // ✅ NEW: Use smart locator for uncheck action
          const uncheckSmartResult = await getSmartLocator(
            this.page,
            selector,
            'check', // Same preferences as check
            description
          );

          if (uncheckSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for uncheck', {
              selector: selector.substring(0, 50),
              totalMatches: uncheckSmartResult.totalMatches,
              selectedIndex: uncheckSmartResult.selectedIndex,
            });
          }

          try {
            await uncheckSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            // ✅ Wait for enabled: Ensure checkbox is not disabled
            await this.waitForEnabled(uncheckSmartResult.locator, 5000);
            await uncheckSmartResult.locator.uncheck({ timeout: timeout || 30000 });
          } catch (uncheckError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator uncheck failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: uncheckError instanceof Error ? uncheckError.message : String(uncheckError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                // ✅ Wait for enabled in self-healing path too
                await this.waitForEnabled(locator, 5000);
                await locator.uncheck({ timeout: timeout || 30000 });
              },
              {
                selector,
                intent: description || 'uncheck checkbox',
                action: 'uncheck',
                timeout,
              }
            );
          }
          break;

        case 'hover':
          if (!selector) throw new Error('Selector is required for hover action');

          // ✅ NEW: Use smart locator for hover action
          const hoverSmartResult = await getSmartLocator(
            this.page,
            selector,
            'hover',
            description
          );

          if (hoverSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for hover', {
              selector: selector.substring(0, 50),
              totalMatches: hoverSmartResult.totalMatches,
              selectedIndex: hoverSmartResult.selectedIndex,
            });
          }

          try {
            await hoverSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await hoverSmartResult.locator.hover({ timeout: timeout || 30000 });
          } catch (hoverError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator hover failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: hoverError instanceof Error ? hoverError.message : String(hoverError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.hover({ timeout: timeout || 30000 });
              },
              {
                selector,
                intent: description || 'hover element',
                action: 'hover',
                timeout,
              }
            );
          }
          break;

        case 'dblclick':
          if (!selector) throw new Error('Selector is required for dblclick action');

          // ✅ NEW: Use smart locator for dblclick action
          const dblclickSmartResult = await getSmartLocator(
            this.page,
            selector,
            'click', // Same preferences as click
            description
          );

          if (dblclickSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for dblclick', {
              selector: selector.substring(0, 50),
              totalMatches: dblclickSmartResult.totalMatches,
              selectedIndex: dblclickSmartResult.selectedIndex,
            });
          }

          try {
            await dblclickSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await dblclickSmartResult.locator.dblclick({ timeout: timeout || 30000 });
          } catch (dblclickError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator dblclick failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: dblclickError instanceof Error ? dblclickError.message : String(dblclickError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.dblclick({ timeout: timeout || 30000 });
              },
              {
                selector,
                intent: description || 'double click element',
                action: 'dblclick',
                timeout,
              }
            );
          }
          break;

        case 'focus':
          if (!selector) throw new Error('Selector is required for focus action');
          const focusLocator = this.getLocatorInternal(selector);
          await focusLocator.focus({ timeout: timeout || 30000 });
          break;

        case 'blur':
          if (!selector) throw new Error('Selector is required for blur action');
          const blurLocator = this.getLocatorInternal(selector);
          await blurLocator.blur({ timeout: timeout || 30000 });
          break;

        case 'press':
          // ✅ FIX 4: If selector provided, use locator.press; otherwise page.keyboard.press
          if (!value) throw new Error('Key is required for press action');
          if (selector) {
            const pressLocator = this.getLocatorInternal(selector);
            // ✅ Ensure focus: Verify element is focused before pressing key
            await this.ensureFocused(pressLocator, 2000);
            await pressLocator.press(String(value), { timeout: timeout || 30000 });
          } else {
            // No selector - use page.keyboard.press (risky, log warning)
            logger.warn('[COMMAND_EXECUTOR] Using page.keyboard.press without selector - risky behavior', {
              key: String(value),
            });
            await this.page.keyboard.press(String(value));
          }
          break;

        case 'dragAndDrop':
          if (!selector) throw new Error('Source selector is required for dragAndDrop action');
          if (!value) throw new Error('Target selector is required for dragAndDrop action');
          const dragSource = this.getLocatorInternal(selector);
          const dragTarget = this.getLocatorInternal(this.prepareSelector(String(value)) || String(value));
          await dragSource.dragTo(dragTarget, { timeout: timeout || 30000 });
          break;

        case 'tap':
          if (!selector) throw new Error('Selector is required for tap action');
          const tapLocator = this.getLocatorInternal(selector);
          await tapLocator.tap({ timeout: timeout || 30000 });
          break;

        case 'swipe':
          if (!selector) throw new Error('Selector is required for swipe action');
          const swipeLocator = this.getLocatorInternal(selector);
          logger.warn('[COMMAND_EXECUTOR] Swipe action not fully supported, using tap');
          await swipeLocator.tap({ timeout: timeout || 30000 });
          break;

        case 'goBack':
          await this.page.goBack({ timeout: timeout || 30000 });
          break;

        case 'goForward':
          await this.page.goForward({ timeout: timeout || 30000 });
          break;

        case 'reload':
          await this.page.reload({ timeout: timeout || 30000 });
          break;

        case 'scrollIntoView':
          if (!selector) throw new Error('Selector is required for scrollIntoView action');
          const scrollIntoViewLocator = this.getLocatorInternal(selector);
          await scrollIntoViewLocator.scrollIntoViewIfNeeded({ timeout: timeout || 30000 });
          break;

        case 'wait':
          await this.page.waitForTimeout(timeout || 1000);
          break;

        case 'waitForSelector':
          if (!selector) throw new Error('Selector is required for waitForSelector action');
          const waitLocator = this.getLocatorInternal(selector);
          await waitLocator.waitFor({ state: 'visible', timeout: timeout || 30000 });
          break;

        case 'waitForNavigation':
          await this.page.waitForLoadState('networkidle', { timeout: timeout || 30000 });
          break;

        // V5: SPA-safe URL waiting (Momentic-like matchers)
        case 'waitFor': {
          const matcher = command.urlMatcher;
          // V5.1: timeout is now primary (from command.timeout), urlMatcher.timeoutMs is fallback
          const waitForTimeout = timeout ?? matcher?.timeoutMs ?? 15000;
          await this.executeWaitFor(matcher, waitForTimeout);
          break;
        }

        case 'scroll':
          if (selector) {
            const scrollLocator = this.getLocatorInternal(selector);
            await scrollLocator.scrollIntoViewIfNeeded();
          } else {
            await this.page.evaluate(() => {
              // @ts-expect-error - browser context
              window.scrollTo(0, document.body.scrollHeight);
            });
          }
          break;

        case 'screenshot': {
          const screenshot = await this.page.screenshot({ type: 'png', fullPage: false });
          return {
            success: true,
            screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
          };
        }

        case 'assertVisible':
          if (!selector) throw new Error('Selector is required for assertVisible action');
          const assertVisibleLocator = this.getLocatorInternal(selector);
          const isVisible = await assertVisibleLocator.isVisible({ timeout: timeout || 5000 });
          if (!isVisible) {
            throw new Error(`Element not visible: ${selector}`);
          }
          logger.info(`Assertion passed: Element is visible`, { selector });
          break;

        case 'assertText':
          if (!selector) throw new Error('Selector is required for assertText action');
          const assertTextLocator = this.getLocatorInternal(selector);
          await assertTextLocator.waitFor({ state: 'visible', timeout: timeout || 5000 });
          const actualText = await assertTextLocator.textContent();
          const expectedText = String(command.assertion?.expected || '');
          const operator = command.assertion?.operator || '=';
          const passed = this.compareValues(actualText || '', expectedText, operator);
          if (!passed) {
            throw new Error(`Text assertion failed for ${selector}: expected "${expectedText}", got "${actualText}"`);
          }
          logger.info(`Assertion passed: Text matches`, { selector, expected: expectedText, actual: actualText });
          break;

        case 'assertValue':
          if (!selector) throw new Error('Selector is required for assertValue action');
          const assertValueLocator = this.getLocatorInternal(selector);
          await assertValueLocator.waitFor({ state: 'visible', timeout: timeout || 5000 });
          const actualValue = await assertValueLocator.inputValue();
          const expectedValue = String(command.assertion?.expected || '');
          const valueOperator = command.assertion?.operator || '=';
          const valuePassed = this.compareValues(actualValue, expectedValue, valueOperator);
          if (!valuePassed) {
            throw new Error(`Value assertion failed for ${selector}: expected "${expectedValue}", got "${actualValue}"`);
          }
          logger.info(`Assertion passed: Value matches`, { selector, expected: expectedValue, actual: actualValue });
          break;

        case 'assertUrl':
          await this.assertUrl(command.assertion);
          break;

        case 'assertCount':
          if (!selector) throw new Error('Selector is required for assertCount action');
          const assertCountLocator = this.getLocatorInternal(selector);
          const actualCount = await assertCountLocator.count();
          const expectedCount = Number(command.assertion?.expected || 0);
          const countOperator = command.assertion?.operator || '=';
          const countPassed = this.compareValues(actualCount, expectedCount, countOperator);
          if (!countPassed) {
            throw new Error(`Count assertion failed for ${selector}: expected ${expectedCount}, got ${actualCount}`);
          }
          logger.info(`Assertion passed: Count matches`, { selector, expected: expectedCount, actual: actualCount });
          break;

        case 'extract': {
          if (!selector) throw new Error('Selector is required for extract action');
          if (!command.extract) throw new Error('Extract config is required for extract action');
          const extractLocator = this.getLocatorInternal(selector);
          const extractedValue = await this.extractDataWithLocator(extractLocator, command.extract);
          this.extractedData.set(command.extract.name, extractedValue);
          return { success: true, extractedValue };
        }

        case 'evaluate':
          // ✅ FIX 6: Log script (truncated) for security audit
          if (!value) throw new Error('Script is required for evaluate action');
          const script = String(value);
          logger.debug('[COMMAND_EXECUTOR] Executing evaluate script', {
            scriptPreview: script.substring(0, 100) + (script.length > 100 ? '...' : ''),
            scriptLength: script.length,
          });
          await this.page.evaluate(script);
          break;

        // ═══════════════════════════════════════════════════════════════
        // V3: AI CHECK (LLM-based assertion)
        // ═══════════════════════════════════════════════════════════════
        case 'aiCheck': {
          logger.info('[COMMAND_EXECUTOR] Executing aiCheck assertion', {
            stepId: isIntentCommand ? intentCommand.intentMeta?.stepId : undefined,
            assertionText: isIntentCommand ? intentCommand.intentMeta?.assertionText : undefined,
          });

          if (!isIntentCommand || !intentCommand.intentMeta?.assertionText) {
            throw new Error('aiCheck requires intentMeta.assertionText');
          }

          try {
            // Import services
            const { evaluateAiCheck } = await import('@/services/testing/ui/preview/ai-check.service');
            const { buildSemanticHtmlFromPage } = await import('@/services/testing/ui/preview/html-context.service');

            // Determine context mode (default: html+a11y+screenshot)
            const contextMode = intentCommand.intentMeta.aiContextMode || 'html+a11y+screenshot';

            // Gather context based on mode
            let html: string | undefined;
            let a11yTree: any[] | undefined;
            let screenshotBase64: string | undefined;

            // Feature flag: use semantic HTML builder (default: ON)
            const useSemanticHtml = process.env.AI_CHECK_SEMANTIC_HTML !== '0';

            if (contextMode.includes('html')) {
              if (useSemanticHtml) {
                try {
                  // Use semantic HTML builder with token budgeting
                  const semanticResult = await buildSemanticHtmlFromPage(this.page, {
                    assertionText: intentCommand.intentMeta.assertionText,
                    tokenBudget: 8000,
                    expandForNegative: true,
                  });
                  html = semanticResult.html;
                  
                  logger.debug('[COMMAND_EXECUTOR] Using semantic HTML for aiCheck', {
                    stepId: intentCommand.intentMeta.stepId,
                    originalLength: semanticResult.originalLength,
                    semanticLength: semanticResult.semanticLength,
                    tokens: semanticResult.tokens,
                    reduction: `${Math.round((1 - semanticResult.semanticLength / semanticResult.originalLength) * 100)}%`,
                  });
                } catch (semanticError) {
                  // Fallback to raw HTML if semantic builder fails
                  logger.warn('[COMMAND_EXECUTOR] Semantic HTML builder failed, falling back to raw HTML', {
                    stepId: intentCommand.intentMeta.stepId,
                    error: semanticError instanceof Error ? semanticError.message : String(semanticError),
                  });
                  html = await this.page.content();
                  // Truncate if too large (100KB)
                  if (html.length > 100 * 1024) {
                    html = html.substring(0, 100 * 1024);
                  }
                }
              } else {
                // Legacy path: use raw HTML with truncation
                html = await this.page.content();
                // Truncate if too large (100KB)
                if (html.length > 100 * 1024) {
                  html = html.substring(0, 100 * 1024);
                }
              }
            }

            if (contextMode.includes('a11y')) {
              // Fetch accessibility tree via CDP
              const cdpSession = await this.page.context().newCDPSession(this.page);
              try {
                const { nodes } = await cdpSession.send('Accessibility.getFullAXTree');
                // Convert CDP nodes to our format (simplified)
                a11yTree = this.convertCdpA11yTree(nodes);
              } catch (a11yError) {
                logger.warn('[COMMAND_EXECUTOR] Failed to fetch accessibility tree', {
                  error: a11yError instanceof Error ? a11yError.message : String(a11yError),
                });
              } finally {
                await cdpSession.detach();
              }
            }

            if (contextMode.includes('screenshot')) {
              const screenshot = await this.page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
              screenshotBase64 = screenshot.toString('base64');
            }

            // Evaluate AI check
            const aiCheckResult = await evaluateAiCheck({
              assertionText: intentCommand.intentMeta.assertionText,
              url: this.page.url(),
              html,
              a11yTree,
              screenshotBase64,
            });

            logger.info('[COMMAND_EXECUTOR] aiCheck evaluation completed', {
              stepId: intentCommand.intentMeta.stepId,
              pass: aiCheckResult.pass,
              confidence: aiCheckResult.confidence,
            });

            // If check fails, throw error with explanation
            if (!aiCheckResult.pass) {
              // Record failure in runtime meta
              if (isIntentCommand && intentCommand.intentMeta?.stepId) {
                this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                  runtimeStatus: 'failed',
                  source: 'resolver',
                  confidenceTier: 'high',
                  failedReason: 'assertion_failed',
                  failureExplanation: aiCheckResult.explanation,
                  resolutionPath: 'embeddings', // ai_check uses embeddings-based resolution
                });
              }
              throw new Error(aiCheckResult.explanation);
            }

            // Success - record in runtime meta
            if (isIntentCommand && intentCommand.intentMeta?.stepId) {
              this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                runtimeStatus: 'executed',
                source: 'resolver',
                confidenceTier: aiCheckResult.confidence && aiCheckResult.confidence >= 0.85 ? 'high' :
                                aiCheckResult.confidence && aiCheckResult.confidence >= 0.6 ? 'medium' : 'low',
                resolutionPath: 'embeddings',
              });
            }
          } catch (error) {
            // Record failure in runtime meta
            if (isIntentCommand && intentCommand.intentMeta?.stepId) {
              this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                runtimeStatus: 'failed',
                source: 'resolver',
                confidenceTier: 'low',
                failedReason: 'assertion_failed',
                failureExplanation: error instanceof Error ? error.message : String(error),
                resolutionPath: 'embeddings',
              });
            }
            throw error;
          }
          break;
        }

        // ═══════════════════════════════════════════════════════════════
        // V6: FILE UPLOAD
        // ═══════════════════════════════════════════════════════════════
        case 'upload': {
          logger.info('[COMMAND_EXECUTOR] Executing upload action', {
            stepId: isIntentCommand ? intentCommand.intentMeta?.stepId : undefined,
            hasUploadConfig: !!command.upload,
            fileUrl: command.upload?.fileUrl?.substring(0, 100),
            sourceType: command.upload?.sourceType,
          });

          if (!command.upload?.fileUrl) {
            throw new Error('Upload config with fileUrl is required for upload action');
          }

          // Step 1: Download/prepare the file
          const { downloadFileForUpload, cleanupUploadTempFile } = await import('./file-download.service');
          let localFilePath: string;
          let downloadResult: Awaited<ReturnType<typeof downloadFileForUpload>> | undefined;

          try {
            // Both 'url' and 'storage' sources are public URLs — download to temp dir
            downloadResult = await downloadFileForUpload(command.upload.fileUrl, {
              filename: command.upload.filename,
              maxSizeBytes: command.upload.maxSizeBytes,
            });
            localFilePath = downloadResult.localPath;

            logger.info('[COMMAND_EXECUTOR] File prepared for upload', {
              localFilePath,
              sizeBytes: downloadResult?.sizeBytes,
            });

            // Step 2: Resolve the file input locator and upload
            const performUpload = async (locator: Locator) => {
              // File inputs are often hidden; wait for attached instead of visible
              await locator.waitFor({ state: 'attached', timeout: timeout || 10000 });
              await locator.setInputFiles(localFilePath, { timeout: timeout || 30000 });
            };

            // Intent-based locator resolution
            if (isIntentCommand && intentCommand.intentMeta) {
              const { locator: intentLocator } = await this.getLocatorForIntentCommand(
                intentCommand,
                'upload',
                timeout || 30000
              );
              await performUpload(intentLocator);
            } else {
              // Standard selector-based flow
              if (!selector) throw new Error('Selector is required for upload action');

              const uploadSmartResult = await getSmartLocator(
                this.page,
                selector,
                'upload',
                description
              );

              try {
                await performUpload(uploadSmartResult.locator);
              } catch (uploadError) {
                logger.warn('[COMMAND_EXECUTOR] Smart locator upload failed, trying self-healing', {
                  selector: selector.substring(0, 50),
                  error: uploadError instanceof Error ? uploadError.message : String(uploadError),
                });

                await this.executeWithSelfHealing(
                  async () => {
                    const locator = getLocator(this.page, selector);
                    await locator.waitFor({ state: 'attached', timeout: timeout || 30000 });
                    await locator.setInputFiles(localFilePath, { timeout: timeout || 30000 });
                  },
                  {
                    selector,
                    intent: description || 'upload file',
                    action: 'upload',
                    timeout,
                    value: localFilePath,
                  }
                );
              }
            }

            // Step 3: Store env var if requested
            if (command.upload.envVar) {
              this.extractedData.set(command.upload.envVar, localFilePath);
              logger.debug('[COMMAND_EXECUTOR] Upload file path stored in env var', {
                envVar: command.upload.envVar,
                localFilePath,
              });
            }

            // Step 4: Schedule temp file cleanup (deferred to let Playwright finish reading)
            if (downloadResult) {
              const tempPath = downloadResult.localPath;
              setTimeout(() => {
                cleanupUploadTempFile(tempPath).catch(() => {});
              }, 10_000);
            }
          } catch (error) {
            // Record failure in runtime meta for intent commands
            if (isIntentCommand && intentCommand.intentMeta?.stepId) {
              this.stepRuntimeMeta.set(intentCommand.intentMeta.stepId, {
                runtimeStatus: 'failed',
                source: 'resolver',
                confidenceTier: 'low',
                failedReason: 'unknown',
                failureExplanation: error instanceof Error ? error.message : String(error),
              });
            }
            throw error;
          }

          break;
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      // Take screenshot if requested (but not if already took one)
      if (command.screenshot && action !== 'screenshot' as PlaywrightActionType) {
        const screenshot = await this.page.screenshot({ type: 'png', fullPage: false });
        return {
          success: true,
          screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
          runtimeMeta: isIntentCommand ? this.stepRuntimeMeta.get(intentCommand.intentMeta?.stepId || '') : undefined,
        };
      }

      // ✅ V2: Include runtime metadata for intent-based commands
      const runtimeMeta = isIntentCommand
        ? this.stepRuntimeMeta.get(intentCommand.intentMeta?.stepId || '')
        : undefined;

      return { success: true, runtimeMeta };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // ✅ FIX: Enhanced error logging with full context
      logger.error(`[COMMAND_EXECUTOR] Command execution failed: ${action}`, {
        action,
        selector,
        value: value ? String(value).substring(0, 100) : undefined,
        url,
        timeout,
        description,
        currentUrl: this.page.url(),
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
        intentStepId: isIntentCommand ? intentCommand.intentMeta?.stepId : undefined,
      });

      if (continueOnError) {
        logger.warn(`Continuing despite error due to continueOnError flag`);
        const runtimeMeta = isIntentCommand
          ? this.stepRuntimeMeta.get(intentCommand.intentMeta?.stepId || '')
          : undefined;
        return { success: false, error: errorMessage, runtimeMeta };
      }

      throw error;
    }
  }

  /**
   * Execute multiple commands in sequence
   * V6: Includes lookahead wait between commands for inter-step stability
   */
  async executeCommands(commands: PlaywrightCommand[]): Promise<{
    success: boolean;
    results: Array<{ command: PlaywrightCommand; result: any }>;
    errors: Array<{ command: PlaywrightCommand; error: string }>;
  }> {
    const results: Array<{ command: PlaywrightCommand; result: any }> = [];
    const errors: Array<{ command: PlaywrightCommand; error: string }> = [];

    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];

      try {
        const result = await this.executeCommand(command);
        results.push({ command, result });

        if (!result.success && !command.continueOnError) {
          throw new Error(result.error || 'Command failed');
        }

        // ─────────────────────────────────────────────────────────────────────
        // Lookahead wait: check next command's element readiness before executing
        // Uses fast Playwright checks only (no AI/embeddings)
        // ─────────────────────────────────────────────────────────────────────
        if (result.success && index < commands.length - 1) {
          const nextCommand = commands[index + 1];
          const intentCommand = command as IntentPlaywrightCommand;
          const nextIntentCommand = nextCommand as IntentPlaywrightCommand;

          // Only apply lookahead if both commands are intent-based (have intentMeta)
          if (intentCommand.intentMeta && nextIntentCommand.intentMeta) {
            const prevActionType = intentCommand.intentMeta.actionType as any;

            // Skip lookahead if previous action already handled waiting
            if (!shouldSkipLookaheadAfter(prevActionType)) {
              // Build IntentStep-like object for lookahead
              const nextStepForLookahead: IntentStep = {
                id: nextIntentCommand.intentMeta.stepId || `cmd-${index + 1}`,
                type: nextIntentCommand.intentMeta.actionType as any,
                description: nextIntentCommand.description || '',
                compiled: nextIntentCommand.intentMeta.compiled,
                evidence: nextIntentCommand.intentMeta.evidence,
                options: {
                  disableLookaheadWait: nextIntentCommand.intentMeta.disableLookaheadWait,
                },
              };

              try {
                const lookahead: LookaheadResult = await waitForStepReadiness(
                  this.page,
                  nextStepForLookahead,
                  {
                    maxWaitMs: 10000,
                    settleMs: 3000,
                    autoWaitThresholdMs: 2000,
                  }
                );

                // Update runtime meta if significant wait occurred
                if (lookahead.autoWaitApplied && nextIntentCommand.intentMeta.stepId) {
                  const existingMeta = this.stepRuntimeMeta.get(nextIntentCommand.intentMeta.stepId);
                  this.stepRuntimeMeta.set(nextIntentCommand.intentMeta.stepId, {
                    ...existingMeta,
                    runtimeStatus: existingMeta?.runtimeStatus || 'executed',
                    source: existingMeta?.source || 'resolver',
                    confidenceTier: existingMeta?.confidenceTier || 'medium',
                    // V6: Add lookahead wait info
                    autoWaitApplied: true,
                    autoWaitMs: lookahead.waited,
                  } as StepRuntimeMeta & { autoWaitApplied?: boolean; autoWaitMs?: number });

                  logger.info('[COMMAND_EXECUTOR] Lookahead auto-wait applied', {
                    currentIndex: index,
                    nextStepId: nextIntentCommand.intentMeta.stepId,
                    waitedMs: lookahead.waited,
                  });
                } else if (lookahead.skipReason) {
                  logger.debug('[COMMAND_EXECUTOR] Lookahead skipped', {
                    nextStepId: nextIntentCommand.intentMeta.stepId,
                    reason: lookahead.skipReason,
                  });
                }
              } catch (lookaheadError) {
                // Lookahead failure is non-fatal, log and continue
                logger.warn('[COMMAND_EXECUTOR] Lookahead wait failed, continuing', {
                  nextIndex: index + 1,
                  error: lookaheadError instanceof Error ? lookaheadError.message : String(lookaheadError),
                });
              }
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ command, error: errorMessage });

        if (!command.continueOnError) {
          // ✅ FIX: Enhanced error logging with full command context
          logger.error('[COMMAND_EXECUTOR] Command execution stopped due to error', {
            command: {
              action: command.action,
              selector: command.selector,
              description: command.description,
              index: index,
            },
            totalCommands: commands.length,
            currentUrl: this.page.url(),
            error: error instanceof Error ? {
              message: error.message,
              name: error.name,
              stack: error.stack,
            } : String(error),
          });
          break;
        }
      }
    }

    const success = errors.length === 0;
    logger.info(`Executed ${commands.length} commands`, {
      successful: results.length,
      failed: errors.length,
    });

    return { success, results, errors };
  }

  /**
   * ✅ REMOVED: assertVisible, assertText, assertValue methods
   * Now handled directly in executeCommand() using getLocator()
   */

  /**
   * Assert URL
   */
  private async assertUrl(assertion: PlaywrightCommand['assertion']): Promise<void> {
    if (!assertion) throw new Error('Assertion config is required');

    const actualUrl = this.page.url();
    const expectedUrl = String(assertion.expected);
    const operator = assertion.operator || 'contains';

    const passed = this.compareValues(actualUrl, expectedUrl, operator);

    if (!passed) {
      throw new Error(`URL assertion failed: expected "${expectedUrl}", got "${actualUrl}"`);
    }

    logger.info(`Assertion passed: URL matches`, { expected: expectedUrl, actual: actualUrl });
  }

  /**
   * ✅ REMOVED: assertCount method
   * Now handled directly in executeCommand() using getLocator()
   */

  /**
   * Extract data from element using locator
   * Supports both traditional extraction and AI-powered extraction with JSON schema
   */
  private async extractDataWithLocator(
    locator: import('playwright').Locator,
    config: NonNullable<PlaywrightCommand['extract']>
  ): Promise<any> {
    // ✅ NEW: AI Extract with JSON schema
    if (config.useAI && config.schema) {
      logger.info('[COMMAND_EXECUTOR] Using AI extraction with schema', {
        mode: config.mode || 'auto',
        hasCostManager: !!this.costManager,
      });

      // ✅ IMPROVED: Get element HTML instead of passing empty selector
      // This gives AI more context for extraction
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      const elementHTML = await locator.evaluate((el: any) => el.outerHTML).catch(() => '');

      // ✅ FIX 9: Pass cost manager to AI extraction
      const result = await AIExtractService.extract(this.page, {
        selector: '', // Keep empty for page context
        schema: config.schema,
        mode: config.mode,
        instructions: config.instructions
          ? `${config.instructions}\n\nElement HTML: ${elementHTML.substring(0, 500)}`
          : `Extract from element: ${elementHTML.substring(0, 500)}`,
      }, this.costManager); // ✅ FIX 9: Pass cost manager

      if (!result.success) {
        throw new Error(`AI extraction failed: ${result.error}`);
      }

      logger.info('[COMMAND_EXECUTOR] AI extraction successful', {
        confidence: result.confidence,
        tokensUsed: result.metadata.tokensUsed,
      });

      return result.data;
    }

    // Traditional extraction (backwards compatible)
    await locator.waitFor({ state: 'visible', timeout: 5000 });

    if (config.attribute) {
      return await locator.getAttribute(config.attribute);
    }

    if (config.property === 'text') {
      return await locator.textContent();
    }

    if (config.property === 'value') {
      return await locator.inputValue();
    }

    if (config.property === 'innerHTML') {
      return await locator.innerHTML();
    }

    return await locator.textContent();
  }

  /**
   * Compare values based on operator
   */
  private compareValues(actual: any, expected: any, operator: string = '='): boolean {
    switch (operator) {
      case '=':
        return actual === expected;
      case '!=':
        return actual !== expected;
      case '>':
        return Number(actual) > Number(expected);
      case '<':
        return Number(actual) < Number(expected);
      case 'contains':
        return String(actual).includes(String(expected));
      case 'startsWith':
        return String(actual).startsWith(String(expected));
      case 'endsWith':
        return String(actual).endsWith(String(expected));
      default:
        return actual === expected;
    }
  }

  /**
   * ✅ FIX 5: Parse selectOption value to support multiple formats
   * Supports: string, array, JSON object { value/label/index }
   */
  private parseSelectValue(value: any): string | string[] | { value?: string; label?: string; index?: number } {
    if (Array.isArray(value)) {
      return value.map(v => String(v));
    }

    const strValue = String(value);

    // Try to parse as JSON (object or array)
    if (strValue.startsWith('{') || strValue.startsWith('[')) {
      try {
        return JSON.parse(strValue);
      } catch {
        // Not valid JSON, treat as string
      }
    }

    // Check for comma-separated values (e.g., "option1,option2")
    if (strValue.includes(',') && !strValue.includes('"')) {
      return strValue.split(',').map(v => v.trim());
    }

    return strValue;
  }

  /**
   * V3: Convert CDP accessibility tree to our PreviewAccessibilityNode format
   * Simplified converter for ai_check runtime execution
   */
  private convertCdpA11yTree(nodes: any[]): any[] {
    if (!nodes || nodes.length === 0) return [];

    const result: any[] = [];
    const maxNodes = 500;
    let nodeCount = 0;

    const convertNode = (node: any): any | null => {
      if (nodeCount >= maxNodes) return null;
      if (!node.role || node.role.value === 'none' || node.role.value === 'ignored') return null;

      nodeCount++;

      const converted: any = {
        role: node.role?.value || 'unknown',
      };

      if (node.name?.value) converted.name = node.name.value;
      if (node.value?.value) converted.value = node.value.value;
      if (node.description?.value) converted.description = node.description.value;

      if (node.childIds && node.childIds.length > 0) {
        const children: any[] = [];
        for (const childId of node.childIds) {
          const childNode = nodes.find((n: any) => n.nodeId === childId);
          if (childNode) {
            const convertedChild = convertNode(childNode);
            if (convertedChild) children.push(convertedChild);
          }
        }
        if (children.length > 0) converted.children = children;
      }

      return converted;
    };

    // Find root nodes (nodes without parents)
    const rootNodes = nodes.filter((node: any) => {
      const hasParent = nodes.some((n: any) => n.childIds?.includes(node.nodeId));
      return !hasParent;
    });

    for (const rootNode of rootNodes) {
      const converted = convertNode(rootNode);
      if (converted) result.push(converted);
      if (nodeCount >= maxNodes) break;
    }

    return result;
  }

  /**
   * Get extracted data
   */
  getExtractedData(): Map<string, any> {
    return this.extractedData;
  }

  /**
   * Get runtime metadata for all executed steps
   * Useful for reporting and debugging intent-based test execution
   */
  getStepRuntimeMeta(): Map<string, StepRuntimeMeta> {
    return this.stepRuntimeMeta;
  }

  /**
   * Get runtime metadata for a specific step
   */
  getStepRuntimeMetaById(stepId: string): StepRuntimeMeta | undefined {
    return this.stepRuntimeMeta.get(stepId);
  }

  /**
   * V2: Persist healed compiled plan to DB after high-confidence heal
   * This updates the IntentTestCase so future runs use the new selector
   *
   * NOTE: Only updates locatorPlan and context, preserves existing action
   */
  private async persistHealedCompiled(params: {
    intentTestCaseId?: string;
    stepId: string;
    newSelector: string;
    healConfidence: number;
    pageUrl: string;
    existingCompiled?: CompiledStepPlan;
  }): Promise<void> {
    const { intentTestCaseId, stepId, newSelector, healConfidence, pageUrl, existingCompiled } = params;

    if (!intentTestCaseId) {
      logger.debug('[COMMAND_EXECUTOR] No intentTestCaseId, skipping heal persistence');
      return;
    }

    // Build new locator plan from healed selector
    // Add healed selector as primary, keep old selectors as fallback
    const healedEntry: LocatorEntry = {
      strategy: 'css',
      value: newSelector,
      confidence: healConfidence,
    };

    // Merge with existing locator plan (healed first, then old ones as fallback)
    const existingLocators = existingCompiled?.locatorPlan || [];
    const newLocatorPlan: LocatorEntry[] = [
      healedEntry,
      ...existingLocators.filter(e => e.value !== newSelector), // Avoid duplicates
    ];

    // Preserve existing action, update locators and context
    const newCompiled: CompiledStepPlan = {
      locatorPlan: newLocatorPlan,
      action: existingCompiled?.action || { type: 'click' },
      targetFingerprint: existingCompiled?.targetFingerprint, // Preserve fingerprint
      context: {
        ...existingCompiled?.context,
        pageUrl,
        compiledAt: new Date().toISOString(),
        pageSignature: undefined, // Clear signature - will be regenerated on next lint
      },
      meta: {
        compiledVersion: existingCompiled?.meta?.compiledVersion || '1.0.0',
        resolverVersion: '3.0.0-healed',
      },
    };

    const newEvidence = {
      lastSuccessSelector: newSelector,
      confidence: healConfidence,
    };

    await IntentTestCaseService.updateStepAfterHeal({
      intentTestCaseId,
      stepId,
      compiled: newCompiled,
      evidence: newEvidence,
    });

    logger.info('[COMMAND_EXECUTOR] Persisted healed compiled to DB', {
      intentTestCaseId,
      stepId,
      healConfidence,
      locatorCount: newLocatorPlan.length,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COMPILED LOCATOR PLAN EXECUTION (for IntentStep-based commands)
  // ═══════════════════════════════════════════════════════════════════════════

  /** V2: Retry configuration for element resolution */
  private static readonly RETRY_CONFIG = {
    maxRetries: 2,
    retryDelayMs: 500,
    retryBackoffMultiplier: 1.5,
  };

  /**
   * Get locator for an intent-based command with retry logic
   *
   * Priority order:
   * 1. compiled.locatorPlan (if present, not expired, signature matches)
   * 2. Smart locator from selector (if provided)
   * 3. Self-healing (if enabled and maxHealAttempts not exceeded)
   *
   * V2: Includes retry logic (2-3 attempts with backoff delay)
   *
   * Records runtime metadata for reporting.
   */
  private async getLocatorForIntentCommand(
    command: IntentPlaywrightCommand,
    actionType: string,
    timeout: number
  ): Promise<{
    locator: Locator;
    runtimeMeta: StepRuntimeMeta;
  }> {
    const { maxRetries, retryDelayMs, retryBackoffMultiplier } = CommandExecutor.RETRY_CONFIG;
    let lastError: Error | undefined;

    // Retry loop
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // Wait before retry with exponential backoff
        const delay = retryDelayMs * Math.pow(retryBackoffMultiplier, attempt - 1);
        logger.info('[COMMAND_EXECUTOR] Retrying element resolution', {
          attempt: attempt + 1,
          maxRetries: maxRetries + 1,
          delayMs: Math.round(delay),
        });
        await this.page.waitForTimeout(delay);
      }

      try {
        return await this.tryGetLocatorForIntentCommand(command, actionType, timeout);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn('[COMMAND_EXECUTOR] Element resolution attempt failed', {
          attempt: attempt + 1,
          error: lastError.message,
        });
      }
    }

    // All retries failed
    throw lastError || new Error('Element not found after retries');
  }

  /**
   * Single attempt to get locator for intent command (called by retry wrapper)
   */
  private async tryGetLocatorForIntentCommand(
    command: IntentPlaywrightCommand,
    actionType: string,
    timeout: number
  ): Promise<{
    locator: Locator;
    runtimeMeta: StepRuntimeMeta;
  }> {
    const startTime = Date.now();
    const intentMeta = command.intentMeta;
    const stepId = intentMeta?.stepId || 'unknown';
    const iframeSelector = intentMeta?.iframeSelector;

    // Track healing attempts for this step
    let healAttempts = 0;

    // 1. Try compiled locator plan first (if available)
    if (intentMeta?.compiled) {
      const compiledContext = iframeSelector
        ? await this.getFrameFromIframeSelector(iframeSelector, Math.min(timeout, 10000))
        : this.page;
      const compiledResult = await executeCompiledLocatorPlan(
        compiledContext,
        intentMeta.compiled,
        actionType,
        timeout
      );

      if (compiledResult.success && compiledResult.locator) {
        const runtimeMeta = buildRuntimeMeta(compiledResult, Date.now() - startTime);
        this.stepRuntimeMeta.set(stepId, runtimeMeta);

        logger.info('[COMMAND_EXECUTOR] Using compiled locator', {
          stepId,
          strategy: compiledResult.usedStrategy,
          confidence: compiledResult.confidence,
          iframe: !!iframeSelector,
        });

        return { locator: compiledResult.locator, runtimeMeta };
      }

      // Log why compiled failed
      logger.info('[COMMAND_EXECUTOR] Compiled locator failed, falling back', {
        stepId,
        skipReason: compiledResult.skipReason,
        expired: compiledResult.expired,
        signatureMatched: compiledResult.signatureMatched,
      });
    }

    // 2. Try embeddings-based resolution (intent-aware, accurate)
    // This is the P0 critical fix: collect fresh DOM + use embeddings for resolution
    if (intentMeta?.intentDescription && intentMeta?.actionType) {
      try {
        logger.info('[COMMAND_EXECUTOR] Trying embeddings-based resolution', {
          stepId,
          intent: intentMeta.intentDescription.slice(0, 80),
          actionType: intentMeta.actionType,
        });

        // Collect fresh interactive nodes from current page
        const { collectInteractiveNodes } = await import('./background-dom-collector');
        const domNodes = await collectInteractiveNodes(this.page);

        if (domNodes.length === 0) {
          logger.warn('[COMMAND_EXECUTOR] No interactive nodes collected', { stepId });
        } else {
          // Run embeddings-based resolution
          const { resolveWithEmbeddings } = await import('@/services/testing/ui/preview/embeddings-resolver.service');
          const resolveResult = await resolveWithEmbeddings({
            previewSessionId: 'background', // Not a preview session
            stepDraft: {
              id: stepId,
              type: intentMeta.actionType as any,
              description: intentMeta.intentDescription,
              bindingHints: intentMeta.bindingHints,
              evidence: intentMeta.evidence,
            },
            domNodes,
            pageUrl: this.page.url(),
            disableCaching: true, // Always fresh resolution in background
            includeAlternatives: false,
            enableLLMDisambiguation: true, // Use aggressive LLM disambiguation
          });

          if (resolveResult.status === 'resolved' && resolveResult.candidates.length > 0) {
            const topCandidate = resolveResult.candidates[0];

            if (topCandidate.ref) {
              // Build locator from resolved ref (temporary data-agent-ref="bg-X")
              const locator = this.page.locator(`[data-agent-ref="${topCandidate.ref}"]`).first();

              // Apply iframe context if needed
              const finalLocator = iframeSelector
                ? this.page.frameLocator(iframeSelector).locator(`[data-agent-ref="${topCandidate.ref}"]`).first()
                : locator;

              await finalLocator.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });

              // Validate element fingerprint: verify the resolved element matches expectations
              // Catches race conditions where DOM changed between collection and resolution
              const expectedNode = topCandidate.node;
              if (expectedNode) {
                const actualTag = await finalLocator.evaluate((el: any) => el?.tagName?.toLowerCase()).catch(() => '');
                if (actualTag && expectedNode.tag && actualTag !== expectedNode.tag.toLowerCase()) {
                  logger.warn('[COMMAND_EXECUTOR] Element fingerprint mismatch after resolution', {
                    stepId,
                    expectedTag: expectedNode.tag,
                    actualTag,
                    ref: topCandidate.ref,
                  });
                  // Don't use this element - fall through to smart locator / self-heal
                  throw new Error(`Element mismatch: expected <${expectedNode.tag}>, found <${actualTag}>`);
                }
              }

              const runtimeMeta: StepRuntimeMeta = {
                runtimeStatus: 'healed', // Mark as healed since compiled failed
                source: 'resolver', // Embeddings-based resolution from resolver service
                confidenceTier: topCandidate.confidence >= 0.85 ? 'high' :
                               topCandidate.confidence >= 0.6 ? 'medium' : 'low',
                executionMs: Date.now() - startTime,
                usedLocatorStrategy: 'embeddings',
                healConfidence: topCandidate.confidence,
                resolutionPath: 'embeddings',
                needsReview: topCandidate.confidence < 0.85,
                flaky: topCandidate.confidence < 0.75,
              };
              this.stepRuntimeMeta.set(stepId, runtimeMeta);

              logger.info('[COMMAND_EXECUTOR] Embeddings resolution succeeded', {
                stepId,
                ref: topCandidate.ref,
                confidence: topCandidate.confidence,
                label: topCandidate.label?.slice(0, 50),
                resolutionPath: 'embeddings',
              });

              // TODO P1: Persist healed ref back to intent test case for future runs
              // if (topCandidate.confidence >= 0.85 && intentMeta.intentTestCaseId) {
              //   await IntentTestCaseService.updateStep(...)
              // }

              return { locator: finalLocator, runtimeMeta };
            }
          }

          logger.info('[COMMAND_EXECUTOR] Embeddings resolution unsuccessful', {
            stepId,
            status: resolveResult.status,
            candidateCount: resolveResult.candidates.length,
            message: resolveResult.message,
          });
        }
      } catch (embeddingsError) {
        logger.warn('[COMMAND_EXECUTOR] Embeddings resolution failed', {
          stepId,
          error: embeddingsError instanceof Error ? embeddingsError.message : String(embeddingsError),
        });
      }
    }

    // 3. Try smart locator from selector (legacy fallback)
    if (command.selector) {
      try {
        const smartResult = await getSmartLocator(
          this.page,
          command.selector,
          actionType as any,
          command.description
        );

        if (smartResult.locator) {
          // Apply iframe context if needed
          const finalLocator = iframeSelector
            ? this.page.frameLocator(iframeSelector).locator(command.selector)
            : smartResult.locator;

          await finalLocator.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });

          const runtimeMeta: StepRuntimeMeta = {
            runtimeStatus: 'executed',
            source: 'resolver',
            confidenceTier: 'medium',
            executionMs: Date.now() - startTime,
            usedLocatorStrategy: 'smart',
            // getSmartLocator() does NOT use embeddings; it uses deterministic scoring and (optionally) LLM disambiguation.
            resolutionPath: smartResult.usedAI ? 'llm_disambiguation' : 'rule_fallback',
          };
          this.stepRuntimeMeta.set(stepId, runtimeMeta);

          logger.info('[COMMAND_EXECUTOR] Using smart locator', {
            stepId,
            wasSmartSelected: smartResult.wasSmartSelected,
            totalMatches: smartResult.totalMatches,
            resolutionPath: runtimeMeta.resolutionPath,
            iframe: !!iframeSelector,
          });

          return { locator: finalLocator, runtimeMeta };
        }
      } catch (smartError) {
        logger.warn('[COMMAND_EXECUTOR] Smart locator failed', {
          stepId,
          error: smartError instanceof Error ? smartError.message : String(smartError),
        });
      }
    }

    // 3. Try self-healing (if enabled and not exceeded max attempts)
    if (this.selfHealingEnabled && healAttempts < this.maxHealAttempts) {
      healAttempts++;

      try {
        const healingResult = await SelfHealingService.healSelector({
          oldSelector: command.selector || '',
          intent: intentMeta?.intentDescription || command.description || '',
          page: this.page,
          errorMessage: 'Element not found via compiled or smart locator',
          metadata: {
            url: this.metadata.url || this.page.url(),
            projectId: this.metadata.projectId,
            userId: this.metadata.userId,
          },
          mode: 'fast',
        });

        if (healingResult.success && healingResult.newSelector) {
          const healConfidence = healingResult.diff?.confidence ?? 0;

          // GUARD RAILS: Check confidence threshold before auto-applying healed selector
          // This prevents "quietly wrong heal" - a key safety feature
          if (healConfidence >= this.selfHealingConfidenceThreshold) {
            // Apply iframe context if needed
            const locator = iframeSelector
              ? this.page.frameLocator(iframeSelector).locator(healingResult.newSelector)
              : getLocator(this.page, healingResult.newSelector);

            await locator.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });

            // Determine if this healed step needs review
            // Even successful heals with medium confidence should be flagged
            const needsReview = healConfidence < 0.9;
            const flaky = healConfidence < 0.9;

            const runtimeMeta: StepRuntimeMeta = {
              runtimeStatus: 'healed',
              source: 'self_heal',
              confidenceTier: healConfidence >= 0.9 ? 'high' : 'medium',
              executionMs: Date.now() - startTime,
              usedLocatorStrategy: 'healed',
              healConfidence,
              resolutionPath: 'self_heal',
              // GUARD RAILS: Flag for review even when heal succeeds
              needsReview,
              flaky,
            };
            this.stepRuntimeMeta.set(stepId, runtimeMeta);

            logger.info('[COMMAND_EXECUTOR] Self-healing succeeded', {
              stepId,
              newSelector: healingResult.newSelector,
              confidence: healConfidence,
              resolutionPath: 'self_heal',
              needsReview,
              flaky,
            });

            // V2: Update compiled in DB if high-confidence heal (≥0.9)
            // This persists the healed selector for future runs
            if (healConfidence >= 0.9 && intentMeta?.stepId && intentMeta?.intentTestCaseId) {
              this.persistHealedCompiled({
                intentTestCaseId: intentMeta.intentTestCaseId,
                stepId: intentMeta.stepId,
                newSelector: healingResult.newSelector,
                healConfidence,
                pageUrl: this.page.url(),
                existingCompiled: intentMeta.compiled, // Pass existing for merging
              }).catch(err => {
                // Don't fail the action if persistence fails
                logger.warn('[COMMAND_EXECUTOR] Failed to persist healed compiled', {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }

            return { locator, runtimeMeta };
          } else {
            // GUARD RAILS: Low confidence - block auto-healing entirely
            // Don't auto-update compiled/evidence when semantic match is low
            logger.warn('[COMMAND_EXECUTOR] Self-healing BLOCKED due to low confidence (guard rails)', {
              stepId,
              confidence: healConfidence,
              threshold: this.selfHealingConfidenceThreshold,
              reason: 'heal_blocked',
            });

            // Record that healing was attempted but blocked
            const blockedMeta: StepRuntimeMeta = {
              runtimeStatus: 'failed',
              source: 'self_heal',
              confidenceTier: 'low',
              executionMs: Date.now() - startTime,
              failedReason: 'heal_blocked',
              failureExplanation: `Self-healing was blocked due to low confidence (${Math.round(healConfidence * 100)}% < ${Math.round(this.selfHealingConfidenceThreshold * 100)}%). Cannot auto-apply potentially incorrect selector.`,
              healConfidence,
              resolutionPath: 'self_heal',
              needsReview: true,
              flaky: true,
            };
            this.stepRuntimeMeta.set(stepId, blockedMeta);
          }
        }
      } catch (healError) {
        logger.warn('[COMMAND_EXECUTOR] Self-healing failed', {
          stepId,
          error: healError instanceof Error ? healError.message : String(healError),
        });
      }
    }

    // 4. All attempts failed
    const runtimeMeta: StepRuntimeMeta = {
      runtimeStatus: 'failed',
      source: intentMeta?.compiled ? 'compiled' : 'resolver',
      confidenceTier: 'low',
      executionMs: Date.now() - startTime,
      failedReason: 'element_not_found',
      failureExplanation: `Element not found after trying all resolution methods (compiled → smart locator → self-healing). ${intentMeta?.intentDescription || command.description || 'Element'} may not exist on current page or selector may be invalid.`,
      needsReview: true,
      resolutionPath: 'rule_fallback', // Failed all methods, no resolution path succeeded
    };
    this.stepRuntimeMeta.set(stepId, runtimeMeta);

    throw new Error(`Element not found for step: ${intentMeta?.intentDescription || command.description || 'unknown'}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SMART WAIT & FLAKINESS PREVENTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ✅ NEW: Wait for element with smart strategies (anti-flakiness)
   * Uses adaptive waiting based on selector stability
   */
  private async waitForElementSmart(
    selector: string,
    options: {
      timeout?: number;
      actionType?: 'click' | 'fill' | 'type' | 'select' | 'other';
    } = {}
  ): Promise<{
    success: boolean;
    locator?: Locator;
    stabilityScore?: SelectorStabilityScore;
    error?: string;
  }> {
    const { timeout = 10000, actionType = 'other' } = options;

    // Use SmartWaitService for intelligent waiting
    const waitResult = await SmartWaitService.waitForElement(
      this.page,
      selector,
      {
        timeout,
        strategy: 'auto', // Auto-detect best strategy
        retries: 3,
        retryDelay: 300,
      }
    );

    // Log stability info for flaky selectors
    if (waitResult.stabilityScore?.isFlaky) {
      logger.warn('[COMMAND_EXECUTOR] Flaky selector detected', {
        selector: selector.substring(0, 50),
        stabilityScore: waitResult.stabilityScore.score,
        reasons: waitResult.stabilityScore.reasons,
        recommendation: waitResult.stabilityScore.recommendation,
      });
    }

    if (!waitResult.success) {
      return {
        success: false,
        stabilityScore: waitResult.stabilityScore,
        error: waitResult.error,
      };
    }

    // Validate the locator is actionable
    const locator = waitResult.locator!;

    // Additional check for specific action types
    if (actionType === 'click' || actionType === 'fill') {
      try {
        // Check if element is actually interactable (runs in browser context)
        const isActionable = await locator.evaluate((el: any) => {
          const rect = el.getBoundingClientRect();
          // @ts-expect-error - window.getComputedStyle exists in browser context
          const style = window.getComputedStyle(el);

          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.pointerEvents !== 'none'
          );
        }).catch(() => true); // Assume true if check fails

        if (!isActionable) {
          return {
            success: false,
            locator,
            stabilityScore: waitResult.stabilityScore,
            error: 'Element exists but is not actionable',
          };
        }
      } catch {
        // Check failed, continue anyway
      }
    }

    return {
      success: true,
      locator,
      stabilityScore: waitResult.stabilityScore,
    };
  }

  /**
   * ✅ NEW: Analyze selector before action for flakiness detection
   * Returns stability score and recommendations
   */
  private analyzeSelector(selector: string): SelectorStabilityScore {
    return SmartWaitService.analyzeSelectorStability(selector);
  }

  /**
   * ✅ CRITICAL FIX: Execute action with self-healing support
   * If selector fails, attempt to heal it using AI Selector Engine
   * Applies healed selector according to action type (click, fill, select, etc.)
   */
  private async executeWithSelfHealing(
    action: () => Promise<void>,
    context: {
      selector: string;
      intent: string;
      action: string;
      timeout?: number;
      value?: any; // ✅ NEW: Value for fill/type/select actions
    }
  ): Promise<void> {
    try {
      // Try original selector first
      await action();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // ✅ IMPROVED: More robust selector error detection
      // Check error type (Playwright errors) + message patterns
      const isSelectorError = isSelectorRelatedError(error);

      if (!isSelectorError || !this.selfHealingEnabled) {
        // Not a selector error or self-healing disabled → re-throw
        throw error;
      }

      logger.warn('[COMMAND_EXECUTOR] Selector failed, attempting self-healing', {
        selector: context.selector,
        intent: context.intent,
        error: errorMessage,
      });

      // Attempt self-healing
      const healingResult = await SelfHealingService.healSelector({
        oldSelector: context.selector,
        intent: context.intent,
        page: this.page,
        errorMessage,
        metadata: {
          url: this.metadata.url || this.page.url(),
          projectId: this.metadata.projectId,
          userId: this.metadata.userId,
        },
        mode: 'fast', // Use fast mode for during-test healing
      });

      if (!healingResult.success || !healingResult.newSelector) {
        logger.error('[COMMAND_EXECUTOR] Self-healing failed', {
          oldSelector: context.selector,
          suggestion: healingResult.suggestion,
        });
        // Re-throw original error
        throw error;
      }

      // Healing successful - log and retry with new selector
      logger.info('[COMMAND_EXECUTOR] Self-healing successful', {
        oldSelector: context.selector,
        newSelector: healingResult.newSelector,
        autoApplied: healingResult.autoApplied,
        confidence: healingResult.diff.confidence,
      });

      // ✅ FIX 7: Use configurable confidence threshold
      const meetsConfidenceThreshold = healingResult.diff.confidence >= this.selfHealingConfidenceThreshold;

      if (healingResult.autoApplied && meetsConfidenceThreshold) {
        logger.info('[COMMAND_EXECUTOR] Auto-applying healed selector', {
          newSelector: healingResult.newSelector,
          whatChanged: healingResult.diff.what_changed,
          action: context.action,
          confidence: healingResult.diff.confidence,
          threshold: this.selfHealingConfidenceThreshold,
        });

        // Apply healed selector according to action type
        await this.applyHealedSelector(
          healingResult.newSelector,
          context.action,
          context.value,
          context.timeout
        );

        logger.info('[COMMAND_EXECUTOR] Healed selector worked successfully', {
          newSelector: healingResult.newSelector,
          action: context.action,
        });
      } else {
        // Low confidence - log suggestion but don't auto-apply
        logger.warn('[COMMAND_EXECUTOR] Healing below confidence threshold - not auto-applying', {
          suggestion: healingResult.suggestion,
          confidence: healingResult.diff.confidence,
          threshold: this.selfHealingConfidenceThreshold,
          reason: !meetsConfidenceThreshold ? 'below_threshold' : 'auto_apply_disabled',
        });
        throw error; // Re-throw original error
      }
    }
  }

  /**
   * ✅ FIX 2 & 4: Use centralized error classification (removed duplication)
   */
  // Removed: isSelectorRelatedError() - now using utils/selector-utils.ts

  /**
   * ✅ COMPLETE: Apply healed selector according to action type
   * Supports ALL Playwright actions (30+ actions)
   * ✅ FIX 3: Always validate before applying healed selector
   */
  private async applyHealedSelector(
    selector: string,
    actionType: string,
    value: any,
    timeout?: number
  ): Promise<void> {
    // ✅ FIX 3: Dry-run validation before applying healed selector
    const validation = await validateAndGetLocator(this.page, selector, {
      actionType: actionType as any,
      timeout: timeout || 2000,
    });

    if (!validation.success || !validation.locator) {
      throw new Error(`Healed selector validation failed: ${validation.error}`);
    }

    const locator = validation.locator; // ✅ FIX 1: Use validated locator to avoid race conditions

    // ✅ Post-heal ambiguity check: Ensure healed selector matches exactly 1 element
    const elementCount = await locator.count();
    if (elementCount !== 1) {
      const errorMsg = elementCount === 0
        ? `Healed selector matches 0 elements (element disappeared)`
        : `Healed selector is ambiguous: matches ${elementCount} elements (expected exactly 1)`;

      logger.error('[COMMAND_EXECUTOR] Post-heal ambiguity check failed', {
        selector: selector.substring(0, 100),
        elementCount,
        actionType,
      });

      // Record this as a failure requiring review
      throw new Error(errorMsg);
    }

    logger.debug('[COMMAND_EXECUTOR] Post-heal count check passed', {
      selector: selector.substring(0, 100),
      elementCount,
    });

    const defaultTimeout = timeout || 30000;

    // Wait for element to be visible first (except for assertions and waits)
    const skipVisibilityCheck = [
      'wait', 'waitForSelector', 'waitForTimeout', 'waitForLoadState', 'waitForNavigation',
      'assertHidden', 'assertDisabled', 'screenshot', 'evaluate', 'extract',
      'upload' // File inputs are often hidden via CSS
    ];
    if (!skipVisibilityCheck.includes(actionType)) {
      await locator.waitFor({ state: 'visible', timeout: defaultTimeout }).catch(() => {
        // Element might not be visible for some actions (e.g., assertHidden)
        logger.debug('[COMMAND_EXECUTOR] Element not visible, continuing anyway', { actionType });
      });
    }

    switch (actionType) {
      // ═══════════════════════════════════════════════════════════════
      // INTERACTIONS
      // ═══════════════════════════════════════════════════════════════
      case 'click':
        // ✅ FIX: Force scroll into view before clicking (handles viewport issues)
        await this.forceScrollIntoView(locator);
        // ✅ Overlay guard: Ensure element is topmost before clicking
        await this.ensureTopMostAtCenter(locator, 2000);
        // ✅ Wait for enabled: Ensure element is not disabled
        await this.waitForEnabled(locator, 5000);
        await locator.click({ timeout: defaultTimeout });
        break;

      case 'dblclick':
        await locator.dblclick({ timeout: defaultTimeout });
        break;

      case 'type':
        if (value === undefined) throw new Error('Value is required for type action');
        await locator.fill(String(value), { timeout: defaultTimeout });
        break;

      case 'select':
      case 'selectOption':
        if (value === undefined) throw new Error('Value is required for select action');
        // ✅ Wait for enabled: Ensure select is not disabled
        await this.waitForEnabled(locator, 5000);
        // ✅ Wait for options: Ensure select has options available
        await this.waitForSelectOptions(locator, 5000, 3);
        await locator.selectOption(String(value), { timeout: defaultTimeout });
        break;

      case 'check':
        // ✅ Wait for enabled: Ensure checkbox is not disabled
        await this.waitForEnabled(locator, 5000);
        await locator.check({ timeout: defaultTimeout });
        break;

      case 'uncheck':
        // ✅ Wait for enabled: Ensure checkbox is not disabled
        await this.waitForEnabled(locator, 5000);
        await locator.uncheck({ timeout: defaultTimeout });
        break;

      case 'hover':
        await locator.hover({ timeout: defaultTimeout });
        break;

      case 'focus':
        await locator.focus({ timeout: defaultTimeout });
        break;

      case 'blur':
        await locator.blur({ timeout: defaultTimeout });
        break;

      case 'press':
        if (value === undefined) throw new Error('Key is required for press action');
        // ✅ Ensure focus: Verify element is focused before pressing key
        await this.ensureFocused(locator, 2000);
        await locator.press(String(value), { timeout: defaultTimeout });
        break;

      // ═══════════════════════════════════════════════════════════════
      // DRAG & DROP / MOBILE
      // ═══════════════════════════════════════════════════════════════
      case 'dragAndDrop':
        if (!value) throw new Error('Target selector is required for dragAndDrop action');
        const targetLocator = this.getLocatorInternal(String(value));
        await locator.dragTo(targetLocator, { timeout: defaultTimeout });
        break;

      case 'tap':
        await locator.tap({ timeout: defaultTimeout });
        break;

      case 'swipe':
        // Swipe is typically implemented as dragTo with offset
        logger.warn('[COMMAND_EXECUTOR] Swipe action not fully supported, using tap', { actionType });
        await locator.tap({ timeout: defaultTimeout });
        break;

      // ═══════════════════════════════════════════════════════════════
      // SCROLL
      // ═══════════════════════════════════════════════════════════════
      case 'scroll':
      case 'scrollIntoView':
        await locator.scrollIntoViewIfNeeded({ timeout: defaultTimeout });
        break;

      // ═══════════════════════════════════════════════════════════════
      // WAIT
      // ═══════════════════════════════════════════════════════════════
      case 'wait':
      case 'waitForTimeout':
        await this.page.waitForTimeout(defaultTimeout);
        break;

      case 'waitForSelector':
        await locator.waitFor({ state: 'visible', timeout: defaultTimeout });
        break;

      // ═══════════════════════════════════════════════════════════════
      // ASSERTIONS
      // ═══════════════════════════════════════════════════════════════
      case 'assertVisible':
        const isVisible = await locator.isVisible({ timeout: defaultTimeout });
        if (!isVisible) throw new Error(`Element not visible: ${selector}`);
        break;

      case 'assertHidden':
        const isHidden = await locator.isHidden({ timeout: defaultTimeout });
        if (!isHidden) throw new Error(`Element not hidden: ${selector}`);
        break;

      case 'assertEnabled':
        const isEnabled = await locator.isEnabled({ timeout: defaultTimeout });
        if (!isEnabled) throw new Error(`Element not enabled: ${selector}`);
        break;

      case 'assertDisabled':
        const isDisabled = await locator.isDisabled({ timeout: defaultTimeout });
        if (!isDisabled) throw new Error(`Element not disabled: ${selector}`);
        break;

      case 'assertText':
        const actualText = await locator.textContent({ timeout: defaultTimeout });
        if (value && !String(actualText).includes(String(value))) {
          throw new Error(`Text assertion failed: expected "${value}", got "${actualText}"`);
        }
        break;

      case 'assertValue':
        const actualValue = await locator.inputValue({ timeout: defaultTimeout });
        if (value && actualValue !== String(value)) {
          throw new Error(`Value assertion failed: expected "${value}", got "${actualValue}"`);
        }
        break;

      case 'assertCount':
        const count = await locator.count();
        if (value && count !== Number(value)) {
          throw new Error(`Count assertion failed: expected ${value}, got ${count}`);
        }
        break;

      // ═══════════════════════════════════════════════════════════════
      // DATA EXTRACTION
      // ═══════════════════════════════════════════════════════════════
      case 'extract':
        // Extract is handled separately in executeCommand
        logger.warn('[COMMAND_EXECUTOR] Extract action in self-healing not fully supported', {
          actionType,
        });
        break;

      case 'upload':
        // Upload in self-healing context: value holds the local file path
        if (value) {
          await locator.setInputFiles(String(value), { timeout: defaultTimeout });
        } else {
          logger.warn('[COMMAND_EXECUTOR] Upload action in self-healing has no file path', { actionType });
        }
        break;

      case 'evaluate':
        if (value) {
          await locator.evaluate(String(value));
        }
        break;

      // ═══════════════════════════════════════════════════════════════
      // SCREENSHOT
      // ═══════════════════════════════════════════════════════════════
      case 'screenshot':
        await locator.screenshot({ timeout: defaultTimeout });
        break;

      // ═══════════════════════════════════════════════════════════════
      // NAVIGATION (no selector needed, but included for completeness)
      // ═══════════════════════════════════════════════════════════════
      case 'goto':
      case 'goBack':
      case 'goForward':
      case 'reload':
      case 'waitForNavigation':
      case 'waitForLoadState':
      case 'waitFor': // V5: SPA-safe URL waiting (no selector needed)
        logger.warn('[COMMAND_EXECUTOR] Navigation action in self-healing - no selector needed', {
          actionType,
        });
        break;

      // ═══════════════════════════════════════════════════════════════
      // UNKNOWN
      // ═══════════════════════════════════════════════════════════════
      default:
        // ✅ IMPROVED: Don't fallback to click - throw error for unknown actions
        throw new Error(`Unknown action type for self-healing: ${actionType}. Cannot apply healed selector.`);
    }
  }

  /**
   * V5: Execute wait_for using SPA-safe approach (page.waitForFunction)
   * Works for both full navigations AND SPA client-side routing (React Router, Next.js, etc.)
   *
   * Matcher precedence:
   * 1. changedFrom: wait until URL != changedFrom value (used by auto-insert)
   * 2. regex: match URL against regex pattern
   * 3. glob: match URL against glob pattern (converted to regex)
   * 4. substring: URL contains substring
   * 5. domain: URL domain equals value (strict host match)
   *
   * @param matcher URL matcher configuration
   * @param timeoutMs Timeout in milliseconds
   */
  private async executeWaitFor(
    matcher: import('@/types').PlaywrightUrlMatcher | undefined,
    timeoutMs: number
  ): Promise<void> {
    if (!matcher) {
      // No matcher specified - simple wait for duration (like 'wait' action)
      logger.debug('[COMMAND_EXECUTOR] No URL matcher specified, waiting for duration', { timeoutMs });
      await this.page.waitForTimeout(timeoutMs);
      return;
    }

    const negate = matcher.negate ?? false;
    const caseSensitive = matcher.caseSensitive ?? false;

    logger.debug('[COMMAND_EXECUTOR] Executing waitFor', {
      matcher: Object.keys(matcher).filter(k => (matcher as any)[k] !== undefined),
      timeoutMs,
    });

    // Priority: changedFrom > regex > glob > substring > domain

    if (matcher.changedFrom) {
      // Wait until URL changes from the specified value
      const prevUrl = matcher.changedFrom;
      await this.page.waitForFunction(
        (prev: string) => String((globalThis as any).location?.href ?? '') !== prev,
        prevUrl,
        { timeout: timeoutMs }
      );
      logger.debug('[COMMAND_EXECUTOR] URL changed from previous value', {
        prevUrl,
        newUrl: this.page.url(),
      });
      return;
    }

    if (matcher.regex) {
      const pattern = matcher.regex;
      const flags = caseSensitive ? '' : 'i';
      await this.page.waitForFunction(
        ({ pattern, flags, negate }: { pattern: string; flags: string; negate: boolean }) => {
          const re = new RegExp(pattern, flags);
          const href = String((globalThis as any).location?.href ?? '');
          const matches = re.test(href);
          return negate ? !matches : matches;
        },
        { pattern, flags, negate: negate },
        { timeout: timeoutMs }
      );
      return;
    }

    if (matcher.glob) {
      // Convert glob to regex (simple conversion)
      const globToRegex = (glob: string): string => {
        return glob
          .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
          .replace(/\*\*/g, '.*') // ** → .*
          .replace(/\*/g, '[^/]*') // * → [^/]*
          .replace(/\?/g, '.'); // ? → .
      };
      const pattern = globToRegex(matcher.glob);
      const flags = caseSensitive ? '' : 'i';
      await this.page.waitForFunction(
        ({ pattern, flags, negate }: { pattern: string; flags: string; negate: boolean }) => {
          const re = new RegExp(pattern, flags);
          const href = String((globalThis as any).location?.href ?? '');
          const matches = re.test(href);
          return negate ? !matches : matches;
        },
        { pattern, flags, negate: negate },
        { timeout: timeoutMs }
      );
      return;
    }

    if (matcher.substring) {
      const sub = matcher.substring;
      await this.page.waitForFunction(
        ({ sub, caseSensitive, negate }: { sub: string; caseSensitive: boolean; negate: boolean }) => {
          const hrefRaw = String((globalThis as any).location?.href ?? '');
          const url = caseSensitive ? hrefRaw : hrefRaw.toLowerCase();
          const search = caseSensitive ? sub : sub.toLowerCase();
          const matches = url.includes(search);
          return negate ? !matches : matches;
        },
        { sub, caseSensitive, negate: negate },
        { timeout: timeoutMs }
      );
      return;
    }

    if (matcher.domain) {
      const domain = matcher.domain;
      await this.page.waitForFunction(
        ({ domain, caseSensitive, negate }: { domain: string; caseSensitive: boolean; negate: boolean }) => {
          const hostRaw = String((globalThis as any).location?.hostname ?? '');
          const host = caseSensitive ? hostRaw : hostRaw.toLowerCase();
          const target = caseSensitive ? domain : domain.toLowerCase();
          const matches = host === target;
          return negate ? !matches : matches;
        },
        { domain, caseSensitive, negate: negate },
        { timeout: timeoutMs }
      );
      return;
    }

    // No specific matcher - return
  }

  /**
   * ✅ FIX: Force scroll element into viewport using multiple strategies
   * Handles cases where scrollIntoViewIfNeeded() fails
   */
  private async forceScrollIntoView(locator: Locator): Promise<void> {
    try {
      // Strategy 1: Try scrollIntoViewIfNeeded first (Playwright's built-in)
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {
        logger.debug('[COMMAND_EXECUTOR] scrollIntoViewIfNeeded failed, trying manual scroll');
      });

      // Strategy 2: Check if element is in viewport, if not - use manual scroll
      const isInViewport = await locator.evaluate((el) => {
        // @ts-ignore - browser context
        const rect = el.getBoundingClientRect();
        // @ts-ignore - browser context
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        // @ts-ignore - browser context
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

        return (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= viewportHeight &&
          rect.right <= viewportWidth
        );
      }).catch(() => false);

      if (!isInViewport) {
        logger.debug('[COMMAND_EXECUTOR] Element not in viewport, using manual scroll');

        // Strategy 3: Manual scroll using JavaScript
        await locator.evaluate((el) => {
          // @ts-ignore - browser context
          const rect = el.getBoundingClientRect();
          // @ts-ignore - browser context
          const elementTop = rect.top + window.pageYOffset;
          // @ts-ignore - browser context
          const elementLeft = rect.left + window.pageXOffset;

          // Scroll to element with some offset from top
          const offset = 100; // Leave some space from top
          // @ts-ignore - browser context
          window.scrollTo({
            top: elementTop - offset,
            left: elementLeft,
            behavior: 'smooth'
          });
        });

        // Wait a bit for smooth scroll to complete
        await this.page.waitForTimeout(300);

        // Strategy 4: If still not in viewport, try scrollIntoView with block: 'center'
        const stillNotInViewport = await locator.evaluate((el) => {
          // @ts-ignore - browser context
          const rect = el.getBoundingClientRect();
          // @ts-ignore - browser context
          const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
          // @ts-ignore - browser context
          const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

          return !(
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= viewportHeight &&
            rect.right <= viewportWidth
          );
        }).catch(() => true);

        if (stillNotInViewport) {
          logger.debug('[COMMAND_EXECUTOR] Still not in viewport, using scrollIntoView with block: center');
          await locator.evaluate((el) => {
            // @ts-ignore - browser context
            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
          });
          await this.page.waitForTimeout(300);
        }
      }
    } catch (error) {
      // If all scroll strategies fail, log but don't throw - element might still be clickable
      logger.warn('[COMMAND_EXECUTOR] Failed to force scroll into view', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * ✅ Overlay/interception guard: Ensure element is topmost at its center point
   * Prevents clicks on elements that are covered by overlays, modals, sticky headers, etc.
   * @param locator The locator to check
   * @param timeout Maximum time to wait for element to become topmost (default: 2000ms)
   * @throws Error if element is not topmost after timeout
   */
  private async ensureTopMostAtCenter(locator: Locator, timeout: number = 2000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 250;

    while (Date.now() - startTime < timeout) {
      try {
        // Get the target element's bounding box
        const box = await locator.boundingBox();
        if (!box) {
          throw new Error('Element has no bounding box (not visible or not in DOM)');
        }

        // Calculate center point
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;

        // Check if the element at center point is the target or its descendant
        const isTopMost = await this.page.evaluate(
          ({ x, y, targetElement }) => {
            // @ts-ignore - browser context
            const elementAtPoint = document.elementFromPoint(x, y);
            if (!elementAtPoint) return false;

            // Check if elementAtPoint is the target or a descendant of target
            return targetElement === elementAtPoint || targetElement.contains(elementAtPoint);
          },
          { x: centerX, y: centerY, targetElement: await locator.elementHandle() }
        );

        if (isTopMost) {
          logger.debug('[COMMAND_EXECUTOR] Element is topmost at center point');
          return; // Success
        }

        // Element is not topmost, wait and retry
        logger.debug('[COMMAND_EXECUTOR] Element not topmost, waiting...', {
          elapsed: Date.now() - startTime,
        });
        await this.page.waitForTimeout(pollInterval);
      } catch (error) {
        // If we can't get bounding box or evaluate, element might be gone
        logger.debug('[COMMAND_EXECUTOR] Error checking topmost status', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.page.waitForTimeout(pollInterval);
      }
    }

    // Timeout reached - element is still not topmost
    throw new Error(
      `Element is not clickable: it is covered by another element (overlay, modal, sticky header, etc.). ` +
      `Waited ${timeout}ms but the element at the click point is still not the target element.`
    );
  }

  /**
   * ✅ Wait for element to be enabled (not disabled)
   * Checks both the 'disabled' property and 'aria-disabled' attribute (for custom components)
   * @param locator The locator to check
   * @param timeout Maximum time to wait for element to become enabled (default: 5000ms)
   * @throws Error if element is still disabled after timeout
   */
  private async waitForEnabled(locator: Locator, timeout: number = 5000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 250;

    while (Date.now() - startTime < timeout) {
      try {
        // Check if element is enabled (both native and ARIA disabled)
        const isEnabled = await locator.evaluate((el) => {
          // Check native disabled property (for native form elements)
          if ('disabled' in el && (el as any).disabled === true) {
            return false;
          }

          // Check aria-disabled attribute (for custom components)
          const ariaDisabled = el.getAttribute('aria-disabled');
          if (ariaDisabled === 'true') {
            return false;
          }

          // Element is enabled
          return true;
        });

        if (isEnabled) {
          logger.debug('[COMMAND_EXECUTOR] Element is enabled');
          return; // Success
        }

        // Element is still disabled, wait and retry
        logger.debug('[COMMAND_EXECUTOR] Element disabled, waiting...', {
          elapsed: Date.now() - startTime,
        });
        await this.page.waitForTimeout(pollInterval);
      } catch (error) {
        // If we can't evaluate, element might be gone
        logger.debug('[COMMAND_EXECUTOR] Error checking enabled status', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.page.waitForTimeout(pollInterval);
      }
    }

    // Timeout reached - element is still disabled
    throw new Error(
      `Element is disabled and cannot be interacted with. ` +
      `Waited ${timeout}ms but the element remained disabled.`
    );
  }

  /**
   * ✅ Wait for select element to have options available
   * Checks that the select element has at least one option element
   * @param locator The select locator to check
   * @param timeout Maximum time to wait for options to appear (default: 5000ms)
   * @param maxRetries Maximum number of retries (default: 3)
   * @throws Error if options don't appear after timeout and retries
   */
  private async waitForSelectOptions(locator: Locator, timeout: number = 5000, maxRetries: number = 3): Promise<void> {
    let attempt = 0;
    const backoffMs = 500; // Short backoff between retries

    while (attempt < maxRetries) {
      try {
        const startTime = Date.now();
        const pollInterval = 250;

        while (Date.now() - startTime < timeout) {
          // Check if select has at least one option
          const optionsCount = await locator.locator('option').count();

          if (optionsCount > 0) {
            logger.debug('[COMMAND_EXECUTOR] Select has options available', { optionsCount });
            return; // Success
          }

          // No options yet, wait and retry
          logger.debug('[COMMAND_EXECUTOR] Waiting for select options...', {
            elapsed: Date.now() - startTime,
            attempt: attempt + 1,
          });
          await this.page.waitForTimeout(pollInterval);
        }

        // Timeout reached for this attempt - retry with backoff
        logger.debug('[COMMAND_EXECUTOR] No options found, retrying with backoff', {
          attempt: attempt + 1,
          maxRetries,
        });
        await this.page.waitForTimeout(backoffMs);
        attempt++;
      } catch (error) {
        logger.debug('[COMMAND_EXECUTOR] Error checking select options', {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempt + 1,
        });
        await this.page.waitForTimeout(backoffMs);
        attempt++;
      }
    }

    // All retries exhausted - select has no options
    throw new Error(
      `Select element has no options available. ` +
      `Waited ${timeout}ms with ${maxRetries} retries but no <option> elements appeared.`
    );
  }

  /**
   * ✅ Ensure element has focus before pressing keys
   * Verifies that document.activeElement is the target element
   * @param locator The locator to focus
   * @param timeout Maximum time to wait for focus (default: 2000ms)
   * @throws Error if element cannot be focused after timeout
   */
  private async ensureFocused(locator: Locator, timeout: number = 2000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 250;
    let lastError: string | undefined;

    while (Date.now() - startTime < timeout) {
      try {
        // Focus the element
        await locator.focus({ timeout: 1000 });

        // Wait a bit for focus to take effect
        await this.page.waitForTimeout(100);

        // Verify that the element is now the active element
        const isFocused = await this.page.evaluate(
          (targetElement) => {
            // @ts-ignore - browser context
            return document.activeElement === targetElement;
          },
          await locator.elementHandle()
        );

        if (isFocused) {
          logger.debug('[COMMAND_EXECUTOR] Element has focus');
          return; // Success
        }

        lastError = 'Element is not document.activeElement after focus() call';
        logger.debug('[COMMAND_EXECUTOR] Element not focused, retrying...', {
          elapsed: Date.now() - startTime,
        });
        await this.page.waitForTimeout(pollInterval);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        logger.debug('[COMMAND_EXECUTOR] Error focusing element', {
          error: lastError,
          elapsed: Date.now() - startTime,
        });
        await this.page.waitForTimeout(pollInterval);
      }
    }

    // Timeout reached - element cannot be focused
    throw new Error(
      `Element cannot be focused for press action. ` +
      `Waited ${timeout}ms but the element is not document.activeElement. ` +
      `Last error: ${lastError || 'unknown'}`
    );
  }
}
