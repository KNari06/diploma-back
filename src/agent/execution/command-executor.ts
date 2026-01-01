/* eslint-disable no-case-declarations */
import { AICostManager } from '@/services/ai/cost/ai-cost-manager.service';
import { AIExtractService } from '@/services/ai-extract';
import { SelfHealingService } from '@/services/ai-selector/self-healing.service';
import { PlaywrightActionType, PlaywrightCommand } from '@/types';
import { logger } from '@/utils/core/logger';
import { Locator, Page } from 'playwright';
import { shouldPressEnterAfterFill } from '../utils/ai/enter-detection-ai';
import { getLocator, getSmartLocator, isSelectorRelatedError, normalizeSelector, validateAndGetLocator } from '../utils/selectors/selector-utils';
import { SelectorStabilityScore, SmartWaitService } from '../utils/selectors/smart-wait.service';

/**
 * Execute Playwright commands on a page
 * ✅ NEW: With AI self-healing support
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
   * Execute a single command
   */
  async executeCommand(command: PlaywrightCommand): Promise<{
    success: boolean;
    error?: string;
    screenshot?: string;
    extractedValue?: any;
  }> {
    this.checkAborted();

    const { action, value, url, timeout, continueOnError, description } = command;

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

          // ✅ FIX 3: Helper for click with optional navigation wait
          const performClick = async (locator: Locator) => {
            await this.forceScrollIntoView(locator);
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

        case 'fill':
          if (!selector) throw new Error('Selector is required for fill action');
          if (value === undefined) throw new Error('Value is required for fill action');

          // ✅ NEW: Use smart locator to select the right input element
          const fillSmartResult = await getSmartLocator(
            this.page,
            selector,
            'fill',
            description // Intent for AI context
          );

          if (fillSmartResult.wasSmartSelected) {
            logger.info('[COMMAND_EXECUTOR] Smart element selection used for fill', {
              selector: selector.substring(0, 50),
              totalMatches: fillSmartResult.totalMatches,
              selectedIndex: fillSmartResult.selectedIndex,
            });
          }

          try {
            await fillSmartResult.locator.waitFor({ state: 'visible', timeout: timeout || 10000 });
            await fillSmartResult.locator.fill(String(value), { timeout: timeout || 30000 });

            // ✅ AI-powered Enter key detection
            const shouldPress = await shouldPressEnterAfterFill(
              fillSmartResult.locator,
              this.page,
              description
            );

            if (shouldPress) {
              logger.info('[COMMAND_EXECUTOR] AI decided to press Enter after fill', {
                selector: selector.substring(0, 50),
              });
              await fillSmartResult.locator.press('Enter', { timeout: timeout || 5000 });
            }
          } catch (fillError) {
            // Smart locator failed, try self-healing
            logger.warn('[COMMAND_EXECUTOR] Smart locator fill failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: fillError instanceof Error ? fillError.message : String(fillError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.fill(String(value), { timeout: timeout || 30000 });

                // ✅ AI-powered Enter key detection (self-healing path)
                const shouldPress = await shouldPressEnterAfterFill(locator, this.page, description);
                if (shouldPress) {
                  logger.info('[COMMAND_EXECUTOR] AI decided to press Enter after fill (self-healing)');
                  await locator.press('Enter', { timeout: timeout || 5000 });
                }
              },
              {
                selector,
                intent: description || `fill with ${value}`,
                action: 'fill',
                timeout,
                value,
              }
            );
          }
          // Note: Post-action analysis handled by PostActionAnalyzer
          break;

        case 'type':
          if (!selector) throw new Error('Selector is required for type action');
          if (value === undefined) throw new Error('Value is required for type action');

          // ✅ NEW: Use smart locator for type action
          const typeSmartResult = await getSmartLocator(
            this.page,
            selector,
            'fill', // Type is similar to fill - targets input elements
            description
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
            await typeSmartResult.locator.type(String(value), { timeout: timeout || 30000 });
          } catch (typeError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator type failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: typeError instanceof Error ? typeError.message : String(typeError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
                await locator.type(String(value), { timeout: timeout || 30000 });
              },
              {
                selector,
                intent: description || `type ${value}`,
                action: 'type',
                timeout,
                value,
              }
            );
          }
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
            await checkSmartResult.locator.check({ timeout: timeout || 30000 });
          } catch (checkError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator check failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: checkError instanceof Error ? checkError.message : String(checkError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
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
            await uncheckSmartResult.locator.uncheck({ timeout: timeout || 30000 });
          } catch (uncheckError) {
            logger.warn('[COMMAND_EXECUTOR] Smart locator uncheck failed, trying self-healing', {
              selector: selector.substring(0, 50),
              error: uncheckError instanceof Error ? uncheckError.message : String(uncheckError),
            });

            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, selector);
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
            await pressLocator.press(String(value), { timeout: timeout || 30000 });
          } else {
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

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      // Take screenshot if requested (but not if already took one)
      if (command.screenshot && action !== 'screenshot' as PlaywrightActionType) {
        const screenshot = await this.page.screenshot({ type: 'png', fullPage: false });
        return {
          success: true,
          screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
        };
      }

      return { success: true };
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
      });

      if (continueOnError) {
        logger.warn(`Continuing despite error due to continueOnError flag`);
        return { success: false, error: errorMessage };
      }

      throw error;
    }
  }

  /**
   * Execute multiple commands in sequence
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
   * Get extracted data
   */
  getExtractedData(): Map<string, any> {
    return this.extractedData;
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
    const defaultTimeout = timeout || 30000;

    // Wait for element to be visible first (except for assertions and waits)
    const skipVisibilityCheck = [
      'wait', 'waitForSelector', 'waitForTimeout', 'waitForLoadState', 'waitForNavigation',
      'assertHidden', 'assertDisabled', 'screenshot', 'evaluate', 'extract'
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
        await locator.click({ timeout: defaultTimeout });
        break;

      case 'dblclick':
        await locator.dblclick({ timeout: defaultTimeout });
        break;

      case 'fill':
        if (value === undefined) throw new Error('Value is required for fill action');
        await locator.fill(String(value), { timeout: defaultTimeout });
        break;

      case 'type':
        if (value === undefined) throw new Error('Value is required for type action');
        await locator.type(String(value), { timeout: defaultTimeout });
        break;

      case 'select':
      case 'selectOption':
        if (value === undefined) throw new Error('Value is required for select action');
        await locator.selectOption(String(value), { timeout: defaultTimeout });
        break;

      case 'check':
        await locator.check({ timeout: defaultTimeout });
        break;

      case 'uncheck':
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
}
