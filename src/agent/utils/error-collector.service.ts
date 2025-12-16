/**
 * ErrorCollectorService
 * Collects console errors, network errors, UI errors, and accessibility warnings during page analysis
 */

import { logger } from '@/utils/logger';
import { Page } from 'playwright';
import { ErrorSignals } from '../types/intelligent-testing.types';

export class ErrorCollectorService {
  private consoleErrors: ErrorSignals['consoleErrors'] = [];
  private networkErrors: ErrorSignals['networkErrors'] = [];
  private uiErrors: ErrorSignals['uiErrors'] = [];
  private accessibilityWarnings: ErrorSignals['accessibilityWarnings'] = [];

  private page: Page;
  private isListening: boolean = false;

  // ✅ FIX: Store listener references so we can remove them (prevents leaks / double-collection)
  private onConsole = (msg: any) => {
    if (!this.isListening) return;
    try {
      if (msg.type?.() === 'error') {
        this.consoleErrors.push({
          message: msg.text?.() || '',
          source: msg.location?.().url,
          line: msg.location?.().lineNumber,
          timestamp: Date.now(),
        });
        logger.debug('[ERROR_COLLECTOR] Console error', { message: msg.text?.() });
      }
    } catch {
      // ignore listener errors
    }
  };

  private onPageError = (error: any) => {
    if (!this.isListening) return;
    try {
      const message = error?.message || String(error);
      this.consoleErrors.push({
        message,
        source: error?.stack?.split('\n')?.[0] || 'unknown',
        timestamp: Date.now(),
      });
      logger.debug('[ERROR_COLLECTOR] Page error', { message });
    } catch {
      // ignore listener errors
    }
  };

  private onRequestFailed = (request: any) => {
    if (!this.isListening) return;
    try {
      const failure = request.failure?.();
      this.networkErrors.push({
        url: request.url?.() || '',
        method: request.method?.() || '',
        error: failure?.errorText || 'Unknown network error',
        timestamp: Date.now(),
      });
      logger.debug('[ERROR_COLLECTOR] Request failed', { url: request.url?.(), error: failure?.errorText });
    } catch {
      // ignore listener errors
    }
  };

  private onResponse = (response: any) => {
    if (!this.isListening) return;
    try {
      const status = response.status?.();
      if (typeof status === 'number' && status >= 400) {
        this.networkErrors.push({
          url: response.url?.() || '',
          status,
          method: response.request?.().method?.() || '',
          error: `HTTP ${status}`,
          timestamp: Date.now(),
        });
        logger.debug('[ERROR_COLLECTOR] HTTP error', { url: response.url?.(), status });
      }
    } catch {
      // ignore listener errors
    }
  };

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Start collecting errors
   */
  startCollecting(): void {
    if (this.isListening) {
      logger.warn('[ERROR_COLLECTOR] Already listening for errors');
      return;
    }

    this.isListening = true;

    // ✅ FIX: Attach listeners with stored handler refs (so we can detach later)
    this.page.on('console', this.onConsole);
    this.page.on('pageerror', this.onPageError);
    this.page.on('requestfailed', this.onRequestFailed);
    this.page.on('response', this.onResponse);

    logger.info('[ERROR_COLLECTOR] Started collecting errors');
  }

  /**
   * Stop collecting errors
   */
  stopCollecting(): void {
    if (!this.isListening) {
      return;
    }

    this.isListening = false;

    // ✅ FIX: Detach listeners to prevent leaks and double-collection across runs
    try {
      this.page.off('console', this.onConsole);
      this.page.off('pageerror', this.onPageError);
      this.page.off('requestfailed', this.onRequestFailed);
      this.page.off('response', this.onResponse);
    } catch {
      // ignore listener removal errors
    }

    logger.info('[ERROR_COLLECTOR] Stopped collecting errors');
  }

  /**
   * Collect UI errors (red error text on page)
   */
  async collectUIErrors(): Promise<void> {
    try {
      const errors = await this.page.evaluate(() => {
        const document = (globalThis as any).document as any;
        const errorSelectors = [
          '[class*="error"]',
          '[class*="Error"]',
          '[class*="danger"]',
          '[role="alert"]',
          '[aria-label*="error"]',
          '[aria-label*="Error"]',
          '.text-red',
          '.text-danger',
        ];

        const foundErrors: Array<{ text: string; selector?: string }> = [];

        for (const selector of errorSelectors) {
          try {
            const elements = document.querySelectorAll(selector) as any;
            elements.forEach((el: any) => {
              const text = el?.textContent?.trim();
              if (text && text.length > 0 && text.length < 500) {
                // Filter out common false positives
                const lowerText = text.toLowerCase();
                if (!lowerText.includes('required') ||
                    lowerText.includes('error') ||
                    lowerText.includes('failed') ||
                    lowerText.includes('invalid')) {
                  foundErrors.push({
                    text,
                    selector,
                  });
                }
              }
            });
          } catch (e) {
            // Ignore selector errors
          }
        }

        return foundErrors;
      });

      errors.forEach((error) => {
        this.uiErrors.push({
          ...error,
          timestamp: Date.now(),
        });
      });

      if (errors.length > 0) {
        logger.debug('[ERROR_COLLECTOR] UI errors found', { count: errors.length });
      }
    } catch (error) {
      logger.warn('[ERROR_COLLECTOR] Failed to collect UI errors', { error });
    }
  }

  /**
   * Collect accessibility warnings
   */
  async collectAccessibilityWarnings(): Promise<void> {
    try {
      const warnings = await this.page.evaluate(() => {
        const document = (globalThis as any).document as any;
        const foundWarnings: Array<{ message: string; selector?: string }> = [];

        // Check for images without alt text
        const images = document.querySelectorAll('img:not([alt])') as any;
        if (images.length > 0) {
          foundWarnings.push({
            message: `${images.length} images without alt text`,
            selector: 'img:not([alt])',
          });
        }

        // Check for buttons without accessible names
        const buttons = document.querySelectorAll('button:not([aria-label]):not([title])') as any;
        buttons.forEach((button: any) => {
          if (!button?.textContent?.trim()) {
            foundWarnings.push({
              message: 'Button without accessible name or text',
              selector: 'button',
            });
          }
        });

        // Check for form inputs without labels
        const inputs = document.querySelectorAll('input:not([aria-label]):not([title])') as any;
        inputs.forEach((input: any) => {
          const id = input?.getAttribute?.('id');
          if (id) {
            const label = document.querySelector(`label[for="${id}"]`) as any;
            if (!label) {
              foundWarnings.push({
                message: `Input without label: ${input?.getAttribute?.('name') || input?.getAttribute?.('type') || 'unknown'}`,
                selector: `input[id="${id}"]`,
              });
            }
          }
        });

        return foundWarnings;
      });

      warnings.forEach((warning) => {
        this.accessibilityWarnings.push({
          ...warning,
          timestamp: Date.now(),
        });
      });

      if (warnings.length > 0) {
        logger.debug('[ERROR_COLLECTOR] Accessibility warnings found', { count: warnings.length });
      }
    } catch (error) {
      logger.warn('[ERROR_COLLECTOR] Failed to collect accessibility warnings', { error });
    }
  }

  /**
   * Get all collected errors
   */
  getErrors(): ErrorSignals {
    return {
      consoleErrors: [...this.consoleErrors],
      networkErrors: [...this.networkErrors],
      uiErrors: [...this.uiErrors],
      accessibilityWarnings: [...this.accessibilityWarnings],
    };
  }

  /**
   * Clear all collected errors
   */
  clear(): void {
    this.consoleErrors = [];
    this.networkErrors = [];
    this.uiErrors = [];
    this.accessibilityWarnings = [];
    logger.debug('[ERROR_COLLECTOR] Cleared all errors');
  }

  /**
   * Get error summary
   */
  getSummary(): string {
    const total =
      this.consoleErrors.length +
      this.networkErrors.length +
      this.uiErrors.length +
      this.accessibilityWarnings.length;

    if (total === 0) {
      return 'No errors detected';
    }

    const parts: string[] = [];
    if (this.consoleErrors.length > 0) {
      parts.push(`${this.consoleErrors.length} console errors`);
    }
    if (this.networkErrors.length > 0) {
      parts.push(`${this.networkErrors.length} network errors`);
    }
    if (this.uiErrors.length > 0) {
      parts.push(`${this.uiErrors.length} UI errors`);
    }
    if (this.accessibilityWarnings.length > 0) {
      parts.push(`${this.accessibilityWarnings.length} accessibility warnings`);
    }

    return parts.join(', ');
  }
}
