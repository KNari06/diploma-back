/**
 * ErrorCollector
 * Collects page-level errors (JavaScript errors, failed resources, UI errors)
 * ENHANCED: Structured UI error collection similar to Pro's ErrorCollectorService
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';

/**
 * Structured UI error (Pro-grade)
 */
export interface UIError {
  text: string;
  selector: string;
  type: 'error' | 'warning' | 'validation';
  timestamp: number;
  iteration?: number;
}

export class ErrorCollector {
  /**
   * Collect current page errors
   * Checks for JavaScript errors, failed resources, and other page-level issues
   *
   * @param page - Playwright page instance
   * @returns Array of error strings
   */
  static async collectFromPage(page: Page): Promise<string[]> {
    const errors: string[] = [];

    try {
      // Execute in page context to collect errors
      const pageErrors = await page.evaluate(() => {
        // @ts-expect-error - DOM types available in browser context
        const collected: string[] = [];

        // Check for global errors stored in window
        if (typeof window !== 'undefined' && (window as any).__pageErrors) {
          const windowErrors = (window as any).__pageErrors;
          if (Array.isArray(windowErrors)) {
            collected.push(...windowErrors.map(String));
          }
        }

        // Check for React error boundaries
        const errorBoundaries = document.querySelectorAll('[data-error-boundary], [data-test-error]');
        errorBoundaries.forEach((el: Element) => {
          const errorText = el.textContent?.trim();
          if (errorText) {
            collected.push(`React Error: ${errorText.slice(0, 200)}`);
          }
        });

        // Check for visible error messages
        const errorElements = document.querySelectorAll(
          '.error, .error-message, [class*="error"], [role="alert"]'
        );
        errorElements.forEach((el: Element) => {
          const errorText = el.textContent?.trim();
          if (errorText && errorText.length > 5) {
            collected.push(`Page Error: ${errorText.slice(0, 200)}`);
          }
        });

        return collected;
      });

      errors.push(...pageErrors);

      // Check page title for error indicators
      const title = await page.title();
      if (title.toLowerCase().includes('error') ||
          title.toLowerCase().includes('not found') ||
          title.toLowerCase().includes('404') ||
          title.toLowerCase().includes('500')) {
        errors.push(`Page Title indicates error: ${title}`);
      }

      // Check URL for error indicators
      const url = page.url();
      if (url.includes('/error') ||
          url.includes('/404') ||
          url.includes('/500')) {
        errors.push(`URL indicates error page: ${url}`);
      }

      logger.debug('[ERROR_COLLECTOR] Collected page errors', {
        count: errors.length,
      });

      return errors;
    } catch (error) {
      logger.error('[ERROR_COLLECTOR] Failed to collect page errors', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Check if page appears to be an error page
   *
   * @param page - Playwright page instance
   * @returns True if page appears to be an error page
   */
  static async isErrorPage(page: Page): Promise<boolean> {
    try {
      const title = await page.title();
      const url = page.url();

      // Check for common error page indicators
      const errorIndicators = [
        'error', '404', '500', 'not found',
        'page not found', 'access denied', 'forbidden'
      ];

      const titleLower = title.toLowerCase();
      const urlLower = url.toLowerCase();

      return errorIndicators.some(
        (indicator) => titleLower.includes(indicator) || urlLower.includes(indicator)
      );
    } catch (error) {
      logger.error('[ERROR_COLLECTOR] Failed to check if error page', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Collect structured UI errors (Pro-grade)
   * Scans DOM for error indicators similar to ErrorCollectorService.collectUIErrors
   *
   * @param page - Playwright page instance
   * @param iteration - Current test iteration for context
   * @returns Array of structured UI errors
   */
  static async collectUIErrors(page: Page, iteration?: number): Promise<UIError[]> {
    try {
      const uiErrors = await page.evaluate(() => {
        const errors: Array<{ text: string; selector: string; type: 'error' | 'warning' | 'validation' }> = [];
        const seenTexts = new Set<string>();

        // Error selectors (similar to Pro's ErrorCollectorService)
        const errorSelectors = [
          '[class*="error"]',
          '[class*="Error"]',
          '[class*="danger"]',
          '[role="alert"]',
          '[aria-label*="error"]',
          '[aria-label*="Error"]',
          '.text-red',
          '.text-danger',
          '.invalid-feedback',
          '.form-error',
          '[data-error]',
          '.error-message',
          '.field-error',
          '.validation-error',
        ];

        // Warning selectors
        const warningSelectors = [
          '[class*="warning"]',
          '[class*="Warning"]',
          '.text-warning',
          '.alert-warning',
        ];

        // False positive filters (similar to Pro)
        const falsePositivePatterns = [
          /^required$/i,
          /^please enter/i,
          /^please fill/i,
          /^\*$/,
          /^$/,
        ];

        const isFalsePositive = (text: string): boolean => {
          if (!text || text.length < 3) return true;
          if (text.length > 300) return true; // Too long - likely not an error message
          return falsePositivePatterns.some((pattern) => pattern.test(text));
        };

        // Collect errors
        errorSelectors.forEach((selector) => {
          document.querySelectorAll(selector).forEach((el: Element) => {
            const text = el.textContent?.trim();
            if (text && !isFalsePositive(text) && !seenTexts.has(text)) {
              seenTexts.add(text);
              errors.push({
                text: text.slice(0, 200),
                selector,
                type: 'error',
              });
            }
          });
        });

        // Collect warnings
        warningSelectors.forEach((selector) => {
          document.querySelectorAll(selector).forEach((el: Element) => {
            const text = el.textContent?.trim();
            if (text && !isFalsePositive(text) && !seenTexts.has(text)) {
              seenTexts.add(text);
              errors.push({
                text: text.slice(0, 200),
                selector,
                type: 'warning',
              });
            }
          });
        });

        // Check for form validation errors
        const invalidInputs = document.querySelectorAll('input:invalid, select:invalid, textarea:invalid');
        invalidInputs.forEach((input: Element) => {
          const htmlInput = input as HTMLInputElement;
          const validationMessage = htmlInput.validationMessage;
          if (validationMessage && !seenTexts.has(validationMessage)) {
            seenTexts.add(validationMessage);
            errors.push({
              text: validationMessage,
              selector: `input[name="${htmlInput.name || 'unknown'}"]`,
              type: 'validation',
            });
          }
        });

        return errors;
      });

      const timestamp = Date.now();
      const result: UIError[] = uiErrors.map((e) => ({
        ...e,
        timestamp,
        iteration,
      }));

      logger.debug('[ERROR_COLLECTOR] Collected UI errors', {
        count: result.length,
        iteration,
      });

      return result;
    } catch (error) {
      logger.error('[ERROR_COLLECTOR] Failed to collect UI errors', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
