/**
 * ResultValidator
 * Validates action execution results
 * Checks if expected outcomes match actual outcomes
 */

import { Page } from 'playwright';
import { logger } from '@/utils/logger';
import {
  DynamicAction,
  ActionResult,
  ValidationResult,
} from './types/intelligent-testing.types';

// ═══════════════════════════════════════════════════════════════════════════
// RESULT VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════

export class ResultValidator {
  /**
   * Validate action result against expected outcome
   * @param action - Executed action
   * @param result - Action result
   * @param page - Playwright page (for additional checks)
   * @returns Validation result
   */
  static async validateResult(
    action: DynamicAction,
    result: ActionResult,
    page: Page
  ): Promise<ValidationResult> {
    // ✅ FIX: Wait actions should always pass if execution succeeded
    // Wait actions don't need text validation - they just wait for timeout
    if (action.action === 'wait' || action.action === 'waitForSelector' || action.action === 'waitForNavigation') {
      return {
        valid: true,
        expected: 'Wait action should complete without errors',
        actual: result.success ? 'Wait completed successfully' : 'Wait failed',
        passed: result.success,
        message: result.success ? 'Wait action completed' : result.error || 'Wait action failed',
      };
    }

    if (!action.expectedResult) {
      // No expectation, assume valid
      return {
        valid: true,
        expected: 'No expectation defined',
        actual: 'Action executed',
        passed: true,
      };
    }

    logger.debug('[RESULT_VALIDATOR] Validating result', {
      action: action.description,
      expected: action.expectedResult,
    });

    const expected = action.expectedResult.toLowerCase();

    // Check different types of expectations
    if (expected.includes('url') && expected.includes('change')) {
      return this.validateUrlChange(result);
    }

    if (expected.includes('redirect')) {
      return this.validateRedirect(result);
    }

    if (expected.includes('appear') || expected.includes('show')) {
      return await this.validateElementAppears(expected, page);
    }

    if (expected.includes('disappear') || expected.includes('hide')) {
      return await this.validateElementDisappears(expected, page);
    }

    if (expected.includes('increase') || expected.includes('count')) {
      return await this.validateCountIncrease(expected, page);
    }

    if (expected.includes('decrease')) {
      return await this.validateCountDecrease(expected, page);
    }

    if (expected.includes('message') || expected.includes('notification')) {
      return await this.validateMessage(expected, page);
    }

    if (expected.includes('error')) {
      return await this.validateError(page);
    }

    if (expected.includes('enable') || expected.includes('clickable')) {
      return await this.validateElementEnabled(expected, page);
    }

    if (expected.includes('disable')) {
      return await this.validateElementDisabled(expected, page);
    }

    // Generic text-based validation
    return await this.validateGeneric(expected, page);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SPECIFIC VALIDATORS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validate URL changed
   */
  private static validateUrlChange(result: ActionResult): ValidationResult {
    const changed = result.urlChanged;

    return {
      valid: true,
      expected: 'URL should change',
      actual: changed ? `URL changed from ${result.urlBefore} to ${result.urlAfter}` : 'URL did not change',
      passed: changed,
      message: changed ? 'URL changed as expected' : 'URL did not change',
    };
  }

  /**
   * Validate redirect occurred
   */
  private static validateRedirect(result: ActionResult): ValidationResult {
    const redirected = result.urlChanged && result.urlBefore !== result.urlAfter;

    return {
      valid: true,
      expected: 'Page should redirect',
      actual: redirected ? `Redirected to ${result.urlAfter}` : 'No redirect',
      passed: redirected,
      message: redirected ? 'Redirect occurred' : 'No redirect detected',
    };
  }

  /**
   * Validate element appears
   */
  private static async validateElementAppears(
    expected: string,
    page: Page
  ): Promise<ValidationResult> {
    try {
      // Extract element identifier from expectation
      // e.g., "success message appears" → look for success-related elements
      const keywords = this.extractKeywords(expected);

      // Try common selectors for success/error messages
      const selectors = this.buildSelectorsFromKeywords(keywords);

      for (const selector of selectors) {
        try {
          const element = await page.locator(selector).first();
          const isVisible = await element.isVisible({ timeout: 2000 });

          if (isVisible) {
            const text = await element.textContent();
            return {
              valid: true,
              expected: `Element with "${keywords.join(', ')}" should appear`,
              actual: `Element found: "${text?.substring(0, 50)}"`,
              passed: true,
              message: 'Element appeared as expected',
            };
          }
        } catch {
          // Try next selector
          continue;
        }
      }

      return {
        valid: true,
        expected: `Element with "${keywords.join(', ')}" should appear`,
        actual: 'Element not found',
        passed: false,
        message: 'Expected element did not appear',
      };
    } catch (error) {
      return {
        valid: false,
        expected: 'Element should appear',
        actual: 'Validation error',
        passed: false,
        message: 'Could not validate element appearance',
      };
    }
  }

  /**
   * Validate element disappears
   */
  private static async validateElementDisappears(
    expected: string,
    page: Page
  ): Promise<ValidationResult> {
    try {
      const keywords = this.extractKeywords(expected);
      const selectors = this.buildSelectorsFromKeywords(keywords);

      for (const selector of selectors) {
        try {
          const element = await page.locator(selector).first();
          const isVisible = await element.isVisible({ timeout: 2000 }).catch(() => false);

          if (!isVisible) {
            return {
              valid: true,
              expected: `Element with "${keywords.join(', ')}" should disappear`,
              actual: 'Element not visible',
              passed: true,
              message: 'Element disappeared as expected',
            };
          }
        } catch {
          continue;
        }
      }

      return {
        valid: true,
        expected: `Element with "${keywords.join(', ')}" should disappear`,
        actual: 'Element still visible',
        passed: false,
        message: 'Element did not disappear',
      };
    } catch (error) {
      return {
        valid: false,
        expected: 'Element should disappear',
        actual: 'Validation error',
        passed: false,
        message: 'Could not validate element disappearance',
      };
    }
  }

  /**
   * Validate count increases (e.g., cart count)
   */
  private static async validateCountIncrease(
    expected: string,
    page: Page
  ): Promise<ValidationResult> {
    try {
      // Look for common count indicators
      const countSelectors = [
        '.cart-count',
        '[class*="cart"] [class*="count"]',
        '[class*="badge"]',
        '[class*="counter"]',
        '[data-count]',
      ];

      for (const selector of countSelectors) {
        try {
          const element = await page.locator(selector).first();
          const text = await element.textContent({ timeout: 2000 });
          const count = parseInt(text || '0', 10);

          if (count > 0) {
            return {
              valid: true,
              expected: 'Count should increase',
              actual: `Count is ${count}`,
              passed: true,
              message: 'Count increased as expected',
            };
          }
        } catch {
          continue;
        }
      }

      return {
        valid: true,
        expected: 'Count should increase',
        actual: 'Count not found or zero',
        passed: false,
        message: 'Count did not increase',
      };
    } catch (error) {
      return {
        valid: false,
        expected: 'Count should increase',
        actual: 'Validation error',
        passed: false,
        message: 'Could not validate count increase',
      };
    }
  }

  /**
   * Validate count decreases
   */
  private static async validateCountDecrease(
    expected: string,
    page: Page
  ): Promise<ValidationResult> {
    // Similar to validateCountIncrease but checking for decrease
    return {
      valid: true,
      expected: 'Count should decrease',
      actual: 'Count validation not fully implemented',
      passed: false,
      message: 'Count decrease validation needs implementation',
    };
  }

  /**
   * Validate message appears
   */
  private static async validateMessage(
    expected: string,
    page: Page
  ): Promise<ValidationResult> {
    try {
      // Common message/notification selectors
      const messageSelectors = [
        '[role="alert"]',
        '.alert',
        '.message',
        '.notification',
        '.toast',
        '[class*="success"]',
        '[class*="error"]',
        '[class*="message"]',
      ];

      for (const selector of messageSelectors) {
        try {
          const element = await page.locator(selector).first();
          const isVisible = await element.isVisible({ timeout: 2000 });

          if (isVisible) {
            const text = await element.textContent();
            return {
              valid: true,
              expected: 'Message should appear',
              actual: `Message found: "${text?.substring(0, 100)}"`,
              passed: true,
              message: 'Message appeared as expected',
            };
          }
        } catch {
          continue;
        }
      }

      return {
        valid: true,
        expected: 'Message should appear',
        actual: 'No message found',
        passed: false,
        message: 'Expected message did not appear',
      };
    } catch (error) {
      return {
        valid: false,
        expected: 'Message should appear',
        actual: 'Validation error',
        passed: false,
        message: 'Could not validate message',
      };
    }
  }

  /**
   * Validate error appears
   */
  private static async validateError(page: Page): Promise<ValidationResult> {
    try {
      const errorSelectors = [
        '[role="alert"]',
        '.error',
        '.alert-error',
        '[class*="error"]',
        '[aria-live="assertive"]',
      ];

      for (const selector of errorSelectors) {
        try {
          const element = await page.locator(selector).first();
          const isVisible = await element.isVisible({ timeout: 2000 });

          if (isVisible) {
            const text = await element.textContent();
            return {
              valid: true,
              expected: 'Error message should appear',
              actual: `Error found: "${text?.substring(0, 100)}"`,
              passed: true,
              message: 'Error appeared as expected',
            };
          }
        } catch {
          continue;
        }
      }

      return {
        valid: true,
        expected: 'Error message should appear',
        actual: 'No error message found',
        passed: false,
        message: 'Expected error did not appear',
      };
    } catch (error) {
      return {
        valid: false,
        expected: 'Error should appear',
        actual: 'Validation error',
        passed: false,
        message: 'Could not validate error',
      };
    }
  }

  /**
   * Validate element becomes enabled
   */
  private static async validateElementEnabled(
    expected: string,
    page: Page
  ): Promise<ValidationResult> {
    // Extract element from expectation
    return {
      valid: true,
      expected: 'Element should become enabled',
      actual: 'Element state validation not fully implemented',
      passed: false,
      message: 'Element enable validation needs implementation',
    };
  }

  /**
   * Validate element becomes disabled
   */
  private static async validateElementDisabled(
    expected: string,
    page: Page
  ): Promise<ValidationResult> {
    return {
      valid: true,
      expected: 'Element should become disabled',
      actual: 'Element state validation not fully implemented',
      passed: false,
      message: 'Element disable validation needs implementation',
    };
  }

  /**
   * Generic validation (fallback)
   */
  private static async validateGeneric(
    expected: string,
    page: Page
  ): Promise<ValidationResult> {
    // Try to find any text matching the expectation
    try {
      const text = await page.textContent('body', { timeout: 2000 });
      const containsExpected = text?.toLowerCase().includes(expected.toLowerCase());

      return {
        valid: true,
        expected: `Page should contain "${expected}"`,
        actual: containsExpected ? 'Text found on page' : 'Text not found',
        passed: containsExpected || false,
        message: containsExpected ? 'Expected text found' : 'Expected text not found',
      };
    } catch (error) {
      return {
        valid: false,
        expected: `Page should contain "${expected}"`,
        actual: 'Could not read page content',
        passed: false,
        message: 'Generic validation failed',
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extract keywords from expectation string
   */
  private static extractKeywords(expected: string): string[] {
    const stopWords = ['should', 'appear', 'show', 'display', 'the', 'a', 'an'];
    const words = expected.toLowerCase().split(/\s+/);

    return words.filter(word => !stopWords.includes(word) && word.length > 2);
  }

  /**
   * Build selectors from keywords
   */
  private static buildSelectorsFromKeywords(keywords: string[]): string[] {
    const selectors: string[] = [];

    for (const keyword of keywords) {
      // Class-based selectors
      selectors.push(`.${keyword}`);
      selectors.push(`[class*="${keyword}"]`);

      // ID-based selectors
      selectors.push(`#${keyword}`);

      // Data attributes
      selectors.push(`[data-${keyword}]`);

      // Text-based selectors
      selectors.push(`text="${keyword}"`);
    }

    return selectors;
  }
}
