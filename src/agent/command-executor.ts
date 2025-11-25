import { PlaywrightActionType, PlaywrightCommand } from '@/types';
import { logger } from '@/utils/logger';
import { Page } from 'playwright';

/**
 * Execute Playwright commands on a page
 */
export class CommandExecutor {
  private page: Page;
  private extractedData: Map<string, any> = new Map();

  constructor(page: Page) {
    this.page = page;
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
          // ✅ IMPROVED: Use locator with better error handling
          try {
            const locator = this.page.locator(selector);
            // Wait for element to be visible and actionable
            await locator.waitFor({ state: 'visible', timeout: timeout || 30000 });
            await locator.click({ timeout: timeout || 30000 });
          } catch (clickError) {
            // ✅ IMPROVED: Provide more detailed error message
            const errorMessage = clickError instanceof Error ? clickError.message : String(clickError);
            if (errorMessage.includes('not found') || errorMessage.includes('timeout')) {
              throw new Error(`Element not found or not visible: ${selector}. ${errorMessage}`);
            }
            throw clickError;
          }
          break;

        case 'fill':
          if (!selector) throw new Error('Selector is required for fill action');
          if (value === undefined) throw new Error('Value is required for fill action');
          await this.page.fill(selector, String(value), { timeout: timeout || 30000 });
          break;

        case 'type':
          if (!selector) throw new Error('Selector is required for type action');
          if (value === undefined) throw new Error('Value is required for type action');
          await this.page.type(selector, String(value), { timeout: timeout || 30000 });
          break;

        case 'select':
          if (!selector) throw new Error('Selector is required for select action');
          if (value === undefined) throw new Error('Value is required for select action');
          await this.page.selectOption(selector, String(value), { timeout: timeout || 30000 });
          break;

        case 'check':
          if (!selector) throw new Error('Selector is required for check action');
          await this.page.check(selector, { timeout: timeout || 30000 });
          break;

        case 'uncheck':
          if (!selector) throw new Error('Selector is required for uncheck action');
          await this.page.uncheck(selector, { timeout: timeout || 30000 });
          break;

        case 'hover':
          if (!selector) throw new Error('Selector is required for hover action');
          await this.page.hover(selector, { timeout: timeout || 30000 });
          break;

        case 'press':
          if (!value) throw new Error('Key is required for press action');
          await this.page.keyboard.press(String(value));
          break;

        case 'wait':
          await this.page.waitForTimeout(timeout || 1000);
          break;

        case 'waitForSelector':
          if (!selector) throw new Error('Selector is required for waitForSelector action');
          await this.page.waitForSelector(selector, { timeout: timeout || 30000 });
          break;

        case 'waitForNavigation':
          await this.page.waitForLoadState('networkidle', { timeout: timeout || 30000 });
          break;

        case 'scroll':
          if (selector) {
            await this.page.locator(selector).scrollIntoViewIfNeeded();
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
          await this.assertVisible(selector, timeout);
          break;

        case 'assertText':
          if (!selector) throw new Error('Selector is required for assertText action');
          await this.assertText(selector, command.assertion, timeout);
          break;

        case 'assertValue':
          if (!selector) throw new Error('Selector is required for assertValue action');
          await this.assertValue(selector, command.assertion, timeout);
          break;

        case 'assertUrl':
          await this.assertUrl(command.assertion);
          break;

        case 'assertCount':
          if (!selector) throw new Error('Selector is required for assertCount action');
          await this.assertCount(selector, command.assertion);
          break;

        case 'extract': {
          if (!selector) throw new Error('Selector is required for extract action');
          if (!command.extract) throw new Error('Extract config is required for extract action');
          const extractedValue = await this.extractData(selector, command.extract);
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
   * Assert that element is visible
   */
  private async assertVisible(selector: string, timeout?: number): Promise<void> {
    const element = this.page.locator(selector);
    const isVisible = await element.isVisible({ timeout: timeout || 5000 });

    if (!isVisible) {
      throw new Error(`Element not visible: ${selector}`);
    }

    logger.info(`Assertion passed: Element is visible`, { selector });
  }

  /**
   * Assert element text
   */
  private async assertText(
    selector: string,
    assertion: PlaywrightCommand['assertion'],
    timeout?: number
  ): Promise<void> {
    if (!assertion) throw new Error('Assertion config is required');

    const element = this.page.locator(selector);
    await element.waitFor({ state: 'visible', timeout: timeout || 5000 });

    const actualText = await element.textContent();
    const expectedText = String(assertion.expected);
    const operator = assertion.operator || '=';

    const passed = this.compareValues(actualText || '', expectedText, operator);

    if (!passed) {
      throw new Error(
        `Text assertion failed for ${selector}: expected "${expectedText}", got "${actualText}"`
      );
    }

    logger.info(`Assertion passed: Text matches`, { selector, expected: expectedText, actual: actualText });
  }

  /**
   * Assert input value
   */
  private async assertValue(
    selector: string,
    assertion: PlaywrightCommand['assertion'],
    timeout?: number
  ): Promise<void> {
    if (!assertion) throw new Error('Assertion config is required');

    const element = this.page.locator(selector);
    await element.waitFor({ state: 'visible', timeout: timeout || 5000 });

    const actualValue = await element.inputValue();
    const expectedValue = String(assertion.expected);
    const operator = assertion.operator || '=';

    const passed = this.compareValues(actualValue, expectedValue, operator);

    if (!passed) {
      throw new Error(
        `Value assertion failed for ${selector}: expected "${expectedValue}", got "${actualValue}"`
      );
    }

    logger.info(`Assertion passed: Value matches`, {
      selector,
      expected: expectedValue,
      actual: actualValue,
    });
  }

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
   * Assert element count
   */
  private async assertCount(
    selector: string,
    assertion: PlaywrightCommand['assertion'],
  ): Promise<void> {
    if (!assertion) throw new Error('Assertion config is required');

    const elements = this.page.locator(selector);
    const actualCount = await elements.count();
    const expectedCount = Number(assertion.expected);
    const operator = assertion.operator || '=';

    const passed = this.compareValues(actualCount, expectedCount, operator);

    if (!passed) {
      throw new Error(
        `Count assertion failed for ${selector}: expected ${expectedCount}, got ${actualCount}`
      );
    }

    logger.info(`Assertion passed: Count matches`, {
      selector,
      expected: expectedCount,
      actual: actualCount,
    });
  }

  /**
   * Extract data from element
   */
  private async extractData(
    selector: string,
    config: NonNullable<PlaywrightCommand['extract']>
  ): Promise<any> {
    const element = this.page.locator(selector);
    await element.waitFor({ state: 'visible', timeout: 5000 });

    if (config.attribute) {
      return await element.getAttribute(config.attribute);
    }

    if (config.property === 'text') {
      return await element.textContent();
    }

    if (config.property === 'value') {
      return await element.inputValue();
    }

    if (config.property === 'innerHTML') {
      return await element.innerHTML();
    }

    return await element.textContent();
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
}
