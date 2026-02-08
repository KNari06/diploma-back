/**
 * AssertionEngine
 * Validates test assertions against actual page state
 */

import type { Page } from 'playwright';
import type { Assertion, AssertionResult, AssertionType } from './types';

export class AssertionEngine {
  constructor(private page: Page) {}

  /**
   * Execute an assertion and return the result
   *
   * @param assertion - Assertion to validate
   * @returns Result with passed/failed status and actual value
   */
  async assert(assertion: Assertion): Promise<AssertionResult> {
    try {
      const actual = await this.evaluate(assertion);
      const passed = this.compare(assertion.type, assertion.expected, actual);

      return {
        assertion,
        passed,
        actual,
        message: passed
          ? `✅ ${assertion.type}: ${assertion.expected}`
          : `❌ ${assertion.type}: expected ${assertion.expected}, got ${actual}`,
      };
    } catch (error) {
      return {
        assertion,
        passed: false,
        message: `❌ ${assertion.type}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Evaluate assertion to get actual value
   *
   * @param assertion - Assertion to evaluate
   * @returns Actual value found
   */
  private async evaluate(assertion: Assertion): Promise<any> {
    switch (assertion.type) {
      case 'element_exists': {
        if (!assertion.selector) {
          throw new Error('selector is required for element_exists assertion');
        }
        return (await this.page.locator(assertion.selector).count()) > 0;
      }

      case 'element_visible': {
        if (!assertion.selector) {
          throw new Error('selector is required for element_visible assertion');
        }
        const el = this.page.locator(assertion.selector);
        return await el.isVisible().catch(() => false);
      }

      case 'element_not_exists': {
        if (!assertion.selector) {
          throw new Error('selector is required for element_not_exists assertion');
        }
        return (await this.page.locator(assertion.selector).count()) === 0;
      }

      case 'url_matches': {
        return this.page.url();
      }

      case 'url_contains': {
        return this.page.url();
      }

      case 'text_visible': {
        return await this.page
          .locator(`text=${assertion.expected}`)
          .isVisible()
          .catch(() => false);
      }

      case 'text_contains': {
        const text = await this.page.textContent('body');
        return text || '';
      }

      case 'value_equals': {
        if (!assertion.selector) {
          throw new Error('selector is required for value_equals assertion');
        }
        return await this.page.locator(assertion.selector).inputValue();
      }

      case 'count_equals': {
        if (!assertion.selector) {
          throw new Error('selector is required for count_equals assertion');
        }
        return await this.page.locator(assertion.selector).count();
      }

      case 'custom': {
        // Custom assertions not implemented yet
        throw new Error('Custom assertions are not yet supported');
      }

      default:
        throw new Error(`Unknown assertion type: ${assertion.type}`);
    }
  }

  /**
   * Compare expected and actual values
   *
   * @param type - Assertion type
   * @param expected - Expected value
   * @param actual - Actual value
   * @returns True if assertion passed
   */
  private compare(type: AssertionType, expected: any, actual: any): boolean {
    switch (type) {
      case 'element_exists':
      case 'element_visible':
      case 'element_not_exists':
      case 'text_visible':
        return actual === true;

      case 'url_matches':
        return new RegExp(expected).test(actual);

      case 'url_contains':
      case 'text_contains':
        return String(actual).includes(String(expected));

      case 'value_equals':
      case 'count_equals':
        return actual === expected;

      case 'custom':
        // Custom comparison not implemented
        return false;

      default:
        return false;
    }
  }

  /**
   * Run multiple assertions in parallel
   *
   * @param assertions - Array of assertions to run
   * @returns Array of assertion results
   */
  async assertAll(assertions: Assertion[]): Promise<AssertionResult[]> {
    return await Promise.all(assertions.map((a) => this.assert(a)));
  }
}
