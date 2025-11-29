import { AIExtractService } from '@/services/ai-extract';
import { SelfHealingService } from '@/services/ai-selector/self-healing.service';
import { PlaywrightActionType, PlaywrightCommand } from '@/types';
import { logger } from '@/utils/logger';
import { Locator, Page } from 'playwright';
import { AICostManager } from '@/services/ai-cost-manager.service';
import { getLocator, isSelectorRelatedError, normalizeSelector, validateAndGetLocator } from './utils/selector-utils';

/**
 * Execute Playwright commands on a page
 * ✅ NEW: With AI self-healing support
 */
export class CommandExecutor {
  private page: Page;
  private extractedData: Map<string, any> = new Map();
  private selfHealingEnabled: boolean = true; // ✅ NEW: Enable/disable self-healing
  private metadata: { url: string; projectId?: string; userId?: string };
  private abortController: AbortController; // ✅ FIX 7: AbortController for cancellation
  private isAborted: boolean = false;
  private costManager?: AICostManager; // ✅ FIX 9: Cost manager for AI operations

  constructor(
    page: Page,
    options: {
      selfHealingEnabled?: boolean;
      metadata?: { url: string; projectId?: string; userId?: string };
      abortSignal?: AbortSignal; // ✅ FIX 7: Accept external AbortSignal
      costManager?: AICostManager; // ✅ FIX 9: Accept cost manager
    } = {}
  ) {
    this.page = page;
    this.selfHealingEnabled = options.selfHealingEnabled ?? true;
    this.metadata = options.metadata || { url: '' };
    this.costManager = options.costManager; // ✅ FIX 9: Store cost manager

    // ✅ FIX 7: Setup abort controller
    this.abortController = new AbortController();

    // If external signal provided, link it to internal controller
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        this.abort();
      });
    }
  }

  /**
   * ✅ FIX 7: Abort all ongoing operations
   */
  abort(): void {
    if (this.isAborted) return;

    this.isAborted = true;
    this.abortController.abort();

    logger.info('[COMMAND_EXECUTOR] Aborted - all operations cancelled');
  }

  /**
   * ✅ FIX 7: Check if aborted before executing operations
   */
  private checkAborted(): void {
    if (this.isAborted) {
      throw new Error('Operation aborted by user');
    }
  }

  /**
   * ✅ FIX 2: Use centralized selector normalization (removed duplication)
   */
  // Removed: normalizeSelector() - now using utils/selector-utils.ts

  /**
   * ✅ FIX 2: Use centralized locator creation (removed duplication)
   * @returns Locator - all Playwright methods return Locator type
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
    // ✅ FIX 7: Check if aborted before executing
    this.checkAborted();

    const { action, selector, value, url, timeout, continueOnError, description } = command;

    logger.info(`Executing command: ${action}`, {
      action,
      selector,
      value,
      url,
      description,
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
          // ✅ FIX 1 & 2: Use centralized validation + get locator to avoid race conditions
          const clickValidation = await validateAndGetLocator(this.page, selector, {
            actionType: 'click',
            timeout: timeout || 2000,
          });

          if (!clickValidation.success || !clickValidation.locator) {
            // Try self-healing if validation failed
            const normalizedSelector = normalizeSelector(selector);
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, normalizedSelector);
                await locator.waitFor({ state: 'visible', timeout: timeout || 30000 });
                await locator.click({ timeout: timeout || 30000 });
              },
              {
                selector: normalizedSelector,
                intent: description || 'click element',
                action: 'click',
                timeout,
              }
            );
          } else {
            // ✅ FIX 1: Use the same validated locator to avoid race conditions
            await clickValidation.locator.click({ timeout: timeout || 30000 });
          }
          break;

        case 'fill':
          if (!selector) throw new Error('Selector is required for fill action');
          if (value === undefined) throw new Error('Value is required for fill action');
          // ✅ FIX 1 & 2: Use centralized validation + get locator
          const fillValidation = await validateAndGetLocator(this.page, selector, {
            actionType: 'fill',
            timeout: timeout || 2000,
          });

          if (!fillValidation.success || !fillValidation.locator) {
            // Try self-healing
            const fillSelector = normalizeSelector(selector);
            await this.executeWithSelfHealing(
              async () => {
                const locator = getLocator(this.page, fillSelector);
                await locator.fill(String(value), { timeout: timeout || 30000 });
              },
              {
                selector: fillSelector,
                intent: description || `fill ${fillSelector} with ${value}`,
                action: 'fill',
                timeout,
                value,
              }
            );
          } else {
            // ✅ FIX 1: Use the same validated locator
            await fillValidation.locator.fill(String(value), { timeout: timeout || 30000 });
          }
          break;

        case 'type':
          if (!selector) throw new Error('Selector is required for type action');
          if (value === undefined) throw new Error('Value is required for type action');
          // ✅ FIX: Normalize selector format
          const typeSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for type action
          const typeLocator = this.getLocatorInternal(typeSelector);
          await typeLocator.type(String(value), { timeout: timeout || 30000 });
          break;

        case 'select':
          if (!selector) throw new Error('Selector is required for select action');
          if (value === undefined) throw new Error('Value is required for select action');
          // ✅ FIX: Normalize selector format
          const selectSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for select action
          const selectLocator = this.getLocatorInternal(selectSelector);
          await selectLocator.selectOption(String(value), { timeout: timeout || 30000 });
          break;

        case 'check':
          if (!selector) throw new Error('Selector is required for check action');
          // ✅ FIX: Normalize selector format
          const checkSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for check action
          const checkLocator = this.getLocatorInternal(checkSelector);
          await checkLocator.check({ timeout: timeout || 30000 });
          break;

        case 'uncheck':
          if (!selector) throw new Error('Selector is required for uncheck action');
          // ✅ FIX: Normalize selector format
          const uncheckSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for uncheck action
          const uncheckLocator = this.getLocatorInternal(uncheckSelector);
          await uncheckLocator.uncheck({ timeout: timeout || 30000 });
          break;

        case 'hover':
          if (!selector) throw new Error('Selector is required for hover action');
          // ✅ FIX: Normalize selector format
          const hoverSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for hover action
          const hoverLocator = this.getLocatorInternal(hoverSelector);
          await hoverLocator.hover({ timeout: timeout || 30000 });
          break;

        case 'dblclick':
          if (!selector) throw new Error('Selector is required for dblclick action');
          const dblclickSelector = normalizeSelector(selector);
          const dblclickLocator = this.getLocatorInternal(dblclickSelector);
          await dblclickLocator.dblclick({ timeout: timeout || 30000 });
          break;

        case 'focus':
          if (!selector) throw new Error('Selector is required for focus action');
          const focusSelector = normalizeSelector(selector);
          const focusLocator = this.getLocatorInternal(focusSelector);
          await focusLocator.focus({ timeout: timeout || 30000 });
          break;

        case 'blur':
          if (!selector) throw new Error('Selector is required for blur action');
          const blurSelector = normalizeSelector(selector);
          const blurLocator = this.getLocatorInternal(blurSelector);
          await blurLocator.blur({ timeout: timeout || 30000 });
          break;

        case 'press':
          if (!value) throw new Error('Key is required for press action');
          await this.page.keyboard.press(String(value));
          break;

        case 'dragAndDrop':
          if (!selector) throw new Error('Source selector is required for dragAndDrop action');
          if (!value) throw new Error('Target selector is required for dragAndDrop action');
          const dragSource = this.getLocatorInternal(normalizeSelector(selector));
          const dragTarget = this.getLocatorInternal(normalizeSelector(String(value)));
          await dragSource.dragTo(dragTarget, { timeout: timeout || 30000 });
          break;

        case 'tap':
          if (!selector) throw new Error('Selector is required for tap action');
          const tapSelector = normalizeSelector(selector);
          const tapLocator = this.getLocatorInternal(tapSelector);
          await tapLocator.tap({ timeout: timeout || 30000 });
          break;

        case 'swipe':
          // Swipe is mobile-specific, implement as tap for now
          if (!selector) throw new Error('Selector is required for swipe action');
          const swipeSelector = normalizeSelector(selector);
          const swipeLocator = this.getLocatorInternal(swipeSelector);
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
          const scrollIntoViewSelector = normalizeSelector(selector);
          const scrollIntoViewLocator = this.getLocatorInternal(scrollIntoViewSelector);
          await scrollIntoViewLocator.scrollIntoViewIfNeeded({ timeout: timeout || 30000 });
          break;

        case 'wait':
          await this.page.waitForTimeout(timeout || 1000);
          break;

        case 'waitForSelector':
          if (!selector) throw new Error('Selector is required for waitForSelector action');
          // ✅ FIX: Normalize selector format
          const waitSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for waitForSelector action
          const waitLocator = this.getLocatorInternal(waitSelector);
          await waitLocator.waitFor({ state: 'visible', timeout: timeout || 30000 });
          break;

        case 'waitForNavigation':
          await this.page.waitForLoadState('networkidle', { timeout: timeout || 30000 });
          break;

        case 'scroll':
          if (selector) {
            // ✅ FIX: Normalize selector format
            const scrollSelector = normalizeSelector(selector);
            // ✅ CRITICAL FIX: Use getLocator() for scroll action
            const scrollLocator = this.getLocatorInternal(scrollSelector);
            await scrollLocator.scrollIntoViewIfNeeded();
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await this.page.evaluate(() => {
              // @ts-ignore - window and document are available in browser context
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
          // ✅ FIX: Normalize selector format
          const assertVisibleSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for assertVisible action
          const assertVisibleLocator = this.getLocatorInternal(assertVisibleSelector);
          const isVisible = await assertVisibleLocator.isVisible({ timeout: timeout || 5000 });
          if (!isVisible) {
            throw new Error(`Element not visible: ${assertVisibleSelector}`);
          }
          logger.info(`Assertion passed: Element is visible`, { selector: assertVisibleSelector });
          break;

        case 'assertText':
          if (!selector) throw new Error('Selector is required for assertText action');
          // ✅ FIX: Normalize selector format
          const assertTextSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for assertText action
          const assertTextLocator = this.getLocatorInternal(assertTextSelector);
          await assertTextLocator.waitFor({ state: 'visible', timeout: timeout || 5000 });
          const actualText = await assertTextLocator.textContent();
          const expectedText = String(command.assertion?.expected || '');
          const operator = command.assertion?.operator || '=';
          const passed = this.compareValues(actualText || '', expectedText, operator);
          if (!passed) {
            throw new Error(
              `Text assertion failed for ${assertTextSelector}: expected "${expectedText}", got "${actualText}"`
            );
          }
          logger.info(`Assertion passed: Text matches`, { selector: assertTextSelector, expected: expectedText, actual: actualText });
          break;

        case 'assertValue':
          if (!selector) throw new Error('Selector is required for assertValue action');
          // ✅ FIX: Normalize selector format
          const assertValueSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for assertValue action
          const assertValueLocator = this.getLocatorInternal(assertValueSelector);
          await assertValueLocator.waitFor({ state: 'visible', timeout: timeout || 5000 });
          const actualValue = await assertValueLocator.inputValue();
          const expectedValue = String(command.assertion?.expected || '');
          const valueOperator = command.assertion?.operator || '=';
          const valuePassed = this.compareValues(actualValue, expectedValue, valueOperator);
          if (!valuePassed) {
            throw new Error(
              `Value assertion failed for ${assertValueSelector}: expected "${expectedValue}", got "${actualValue}"`
            );
          }
          logger.info(`Assertion passed: Value matches`, {
            selector: assertValueSelector,
            expected: expectedValue,
            actual: actualValue,
          });
          break;

        case 'assertUrl':
          await this.assertUrl(command.assertion);
          break;

        case 'assertCount':
          if (!selector) throw new Error('Selector is required for assertCount action');
          // ✅ FIX: Normalize selector format
          const assertCountSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for assertCount action
          const assertCountLocator = this.getLocatorInternal(assertCountSelector);
          const actualCount = await assertCountLocator.count();
          const expectedCount = Number(command.assertion?.expected || 0);
          const countOperator = command.assertion?.operator || '=';
          const countPassed = this.compareValues(actualCount, expectedCount, countOperator);
          if (!countPassed) {
            throw new Error(
              `Count assertion failed for ${assertCountSelector}: expected ${expectedCount}, got ${actualCount}`
            );
          }
          logger.info(`Assertion passed: Count matches`, {
            selector: assertCountSelector,
            expected: expectedCount,
            actual: actualCount,
          });
          break;

        case 'extract': {
          if (!selector) throw new Error('Selector is required for extract action');
          if (!command.extract) throw new Error('Extract config is required for extract action');
          // ✅ FIX: Normalize selector format
          const extractSelector = normalizeSelector(selector);
          // ✅ CRITICAL FIX: Use getLocator() for extract action
          const extractLocator = this.getLocatorInternal(extractSelector);
          const extractedValue = await this.extractDataWithLocator(extractLocator, command.extract);
          this.extractedData.set(command.extract.name, extractedValue);
          return { success: true, extractedValue };
        }

        case 'evaluate':
          if (!value) throw new Error('Script is required for evaluate action');
          await this.page.evaluate(String(value));
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
   * Get extracted data
   */
  getExtractedData(): Map<string, any> {
    return this.extractedData;
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

      // Auto-apply if confidence is high
      if (healingResult.autoApplied) {
        logger.info('[COMMAND_EXECUTOR] Auto-applying healed selector', {
          newSelector: healingResult.newSelector,
          whatChanged: healingResult.diff.what_changed,
          action: context.action,
        });

        // ✅ CRITICAL FIX: Apply healed selector according to action type
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
        logger.warn('[COMMAND_EXECUTOR] Low confidence healing - not auto-applying', {
          suggestion: healingResult.suggestion,
          confidence: healingResult.diff.confidence,
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
}
