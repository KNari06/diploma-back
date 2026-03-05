/**
 * ErrorCollectorService
 * Collects console errors, network errors, UI errors, and accessibility warnings during page analysis
 */

import { logger } from '@/utils/core/logger';
import { Page } from 'playwright';
import { ErrorSignals } from '../../types/intelligent-testing.types';

export class ErrorCollectorService {
  private consoleErrors: ErrorSignals['consoleErrors'] = [];
  private networkErrors: ErrorSignals['networkErrors'] = [];
  private uiErrors: ErrorSignals['uiErrors'] = [];
  private accessibilityWarnings: ErrorSignals['accessibilityWarnings'] = [];
  private brokenResources: Array<{ type: 'broken_image' | 'failed_stylesheet' | 'failed_script'; url: string; element?: string; timestamp: number }> = [];
  private slowApiCalls: Array<{ url: string; method: string; status: number; responseTime: number; timestamp: number }> = [];
  private allApiCalls: Array<{ url: string; method: string; status: number; responseTime: number; timestamp: number }> = [];

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
        const url = response.url?.() || '';
        const method = response.request?.().method?.() || '';
        const errorEntry: ErrorSignals['networkErrors'][number] = {
          url,
          status,
          method,
          error: `HTTP ${status}`,
          timestamp: Date.now(),
        };

        this.networkErrors.push(errorEntry);
        logger.debug('[ERROR_COLLECTOR] HTTP error', { url, status });

        // V11: Enhanced 4xx body capture for mutating requests (validation error detection)
        if (status >= 400 && status < 500) {
          const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);
          if (isMutating) {
            try {
              const contentType = response.headers?.()?.['content-type'] || '';
              if (contentType.includes('application/json')) {
                const bodyPromise = response.json?.();
                if (bodyPromise && typeof bodyPromise.then === 'function') {
                  bodyPromise.then((parsed: any) => {
                    if (parsed) {
                      // Truncate large bodies to 2KB — store as raw string when truncating
                      // (JSON.parse of a truncated string always throws — store string directly)
                      const serialized = JSON.stringify(parsed);
                      errorEntry.responseBody = serialized.length > 2048
                        ? serialized.slice(0, 2048) : parsed;
                      errorEntry.fieldErrors = ErrorCollectorService.parseFieldErrors(parsed);
                    }
                  }).catch(() => { /* non-fatal: body parsing failed */ });
                }
              }
            } catch { /* non-fatal */ }
          }
        }
      }

      // Track ALL API responses with timing for performance metrics
      try {
        const timing = response.request?.().timing?.();
        const responseTime = timing?.responseEnd;
        if (typeof responseTime === 'number' && responseTime > 0) {
          const apiCall = {
            url: response.url?.() || '',
            method: response.request?.().method?.() || '',
            status: typeof status === 'number' ? status : 0,
            responseTime: Math.round(responseTime),
            timestamp: Date.now(),
          };

          // Track all API calls for metrics calculation
          this.allApiCalls.push(apiCall);

          // Also track slow calls separately (>2s threshold)
          if (responseTime > 2000) {
            this.slowApiCalls.push(apiCall);
          }
        }
      } catch {
        // timing() may not be available — non-fatal
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
   * Collect accessibility warnings (WCAG 2.1 Level A/AA)
   * Enhanced: 11 checks covering key WCAG criteria
   */
  async collectAccessibilityWarnings(): Promise<void> {
    try {
      const warnings = await this.page.evaluate(`
        (function() {
          var foundWarnings = [];

          // 1. Images without alt text (WCAG 1.1.1)
          var images = document.querySelectorAll('img:not([alt])');
          if (images.length > 0) {
            foundWarnings.push({ message: images.length + ' images without alt text', selector: 'img:not([alt])', wcag: '1.1.1' });
          }

          // 2. Buttons without accessible names (WCAG 4.1.2)
          var buttons = document.querySelectorAll('button:not([aria-label]):not([title])');
          var emptyButtons = 0;
          buttons.forEach(function(btn) { if (!btn.textContent || !btn.textContent.trim()) emptyButtons++; });
          if (emptyButtons > 0) {
            foundWarnings.push({ message: emptyButtons + ' buttons without accessible name', selector: 'button', wcag: '4.1.2' });
          }

          // 3. Form inputs without labels (WCAG 1.3.1)
          var inputs = document.querySelectorAll('input:not([aria-label]):not([title]):not([type="hidden"]):not([type="submit"]):not([type="button"])');
          var unlabeled = 0;
          inputs.forEach(function(input) {
            var id = input.getAttribute('id');
            var hasLabel = false;
            if (id) { hasLabel = !!document.querySelector('label[for="' + id + '"]'); }
            if (!hasLabel) { hasLabel = !!input.closest('label'); }
            if (!hasLabel && !input.getAttribute('aria-labelledby')) { unlabeled++; }
          });
          if (unlabeled > 0) {
            foundWarnings.push({ message: unlabeled + ' form inputs without labels', selector: 'input', wcag: '1.3.1' });
          }

          // 4. Heading hierarchy — skipped levels (WCAG 1.3.1)
          var headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
          var lastLevel = 0;
          var skipCount = 0;
          var firstSkip = '';
          headings.forEach(function(h) {
            var level = parseInt(h.tagName.charAt(1));
            if (lastLevel > 0 && level > lastLevel + 1) {
              skipCount++;
              if (!firstSkip) firstSkip = 'h' + lastLevel + ' to h' + level;
            }
            lastLevel = level;
          });
          if (skipCount > 0) {
            foundWarnings.push({
              message: skipCount + ' heading level skip(s) detected (e.g., ' + firstSkip + ')',
              selector: 'h1-h6',
              wcag: '1.3.1'
            });
          }

          // 5. Document language (WCAG 3.1.1)
          if (!document.documentElement.getAttribute('lang')) {
            foundWarnings.push({ message: 'Page missing lang attribute on <html>', selector: 'html', wcag: '3.1.1' });
          }

          // 6. Missing main landmark (WCAG 1.3.1)
          if (!document.querySelector('main, [role="main"]')) {
            foundWarnings.push({ message: 'Page missing <main> landmark region', selector: 'body', wcag: '1.3.1' });
          }

          // 7. Non-descriptive link text (WCAG 2.4.4)
          var vagueTexts = ['click here', 'here', 'read more', 'more', 'link'];
          var vagueCount = 0;
          document.querySelectorAll('a').forEach(function(link) {
            var text = (link.textContent || '').trim().toLowerCase();
            if (text && vagueTexts.indexOf(text) >= 0 && !link.getAttribute('aria-label')) vagueCount++;
          });
          if (vagueCount > 0) {
            foundWarnings.push({ message: vagueCount + ' links with non-descriptive text ("click here", "read more")', selector: 'a', wcag: '2.4.4' });
          }

          // 8. Positive tabindex (WCAG 2.4.3)
          var positiveTabCount = 0;
          document.querySelectorAll('[tabindex]').forEach(function(el) {
            if (parseInt(el.getAttribute('tabindex')) > 0) positiveTabCount++;
          });
          if (positiveTabCount > 0) {
            foundWarnings.push({ message: positiveTabCount + ' elements with positive tabindex (disrupts tab order)', selector: '[tabindex]', wcag: '2.4.3' });
          }

          // 9. Identity inputs without autocomplete (WCAG 1.3.5)
          var identityInputs = document.querySelectorAll('input[type="email"], input[type="tel"], input[name*="name"], input[name*="address"]');
          var noAC = 0;
          identityInputs.forEach(function(input) { if (!input.getAttribute('autocomplete')) noAC++; });
          if (noAC > 0) {
            foundWarnings.push({ message: noAC + ' identity inputs without autocomplete attribute', selector: 'input', wcag: '1.3.5' });
          }

          // 10. Auto-playing media (WCAG 1.4.2)
          var autoplay = document.querySelectorAll('video[autoplay], audio[autoplay]');
          if (autoplay.length > 0) {
            foundWarnings.push({ message: autoplay.length + ' auto-playing media elements', selector: 'video[autoplay], audio[autoplay]', wcag: '1.4.2' });
          }

          // 11. Empty links (WCAG 2.4.4)
          var emptyLinks = 0;
          document.querySelectorAll('a[href]').forEach(function(link) {
            if (!link.textContent.trim() && !link.getAttribute('aria-label') && !link.querySelector('img[alt]')) emptyLinks++;
          });
          if (emptyLinks > 0) {
            foundWarnings.push({ message: emptyLinks + ' empty links without text or aria-label', selector: 'a', wcag: '2.4.4' });
          }

          return foundWarnings;
        })()
      `) as Array<{ message: string; selector?: string; wcag?: string }>;

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
   * Detect broken resources on the page (images, CSS)
   * Non-fatal: findings are stored separately and also added to uiErrors
   */
  async collectBrokenResources(): Promise<void> {
    try {
      const resources = await this.page.evaluate(`
        (function() {
          var results = [];

          // 1. Broken images: loaded but broken (naturalWidth === 0)
          var imgs = document.querySelectorAll('img');
          imgs.forEach(function(img) {
            if (!img.src || img.src === '' || img.src.startsWith('data:')) return;
            if (img.width <= 1 && img.height <= 1) return;
            if (img.complete && img.naturalWidth === 0) {
              results.push({
                type: 'broken_image',
                url: img.src,
                element: img.alt ? 'img[alt="' + img.alt.substring(0, 40) + '"]' : 'img[src="...' + img.src.slice(-50) + '"]',
              });
            }
          });

          // 2. Failed stylesheets: link[rel=stylesheet] that failed to load
          // Note: CORS stylesheets throw on .sheet access, so we use disabled flag
          var links = document.querySelectorAll('link[rel="stylesheet"]');
          links.forEach(function(link) {
            try {
              // Only flag as broken if link is disabled OR if we can access .sheet and it's null
              // Check disabled first to avoid CORS exceptions
              if (link.href && link.disabled) {
                results.push({
                  type: 'failed_stylesheet',
                  url: link.href,
                  element: 'link[rel=stylesheet]',
                });
                return;
              }
              // Try to check .sheet, but if it throws (CORS), skip
              if (link.href && !link.disabled) {
                var sheet = link.sheet;
                if (sheet === null) {
                  results.push({
                    type: 'failed_stylesheet',
                    url: link.href,
                    element: 'link[rel=stylesheet]',
                  });
                }
              }
            } catch(e) {
              // Cross-origin stylesheets throw on .sheet access — skip (not broken, just CORS)
            }
          });

          return results;
        })()
      `) as Array<{ type: 'broken_image' | 'failed_stylesheet' | 'failed_script'; url: string; element?: string }>;

      const timestamp = Date.now();
      for (const resource of resources) {
        this.brokenResources.push({ ...resource, timestamp });
        // Also add to uiErrors for unified reporting / AI analysis
        this.uiErrors.push({
          text: `Broken resource (${resource.type}): ${resource.url}`,
          selector: resource.element,
          timestamp,
        });
      }

      if (resources.length > 0) {
        logger.debug('[ERROR_COLLECTOR] Broken resources found', { count: resources.length });
      }
    } catch (error) {
      logger.warn('[ERROR_COLLECTOR] Failed to collect broken resources', { error });
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
   * Get errors that occurred since a given timestamp (for step-scoped correlation)
   */
  getErrorsSince(since: number): ErrorSignals {
    return {
      consoleErrors: this.consoleErrors.filter(e => e.timestamp >= since),
      networkErrors: this.networkErrors.filter(e => e.timestamp >= since),
      uiErrors: this.uiErrors.filter(e => e.timestamp >= since),
      accessibilityWarnings: this.accessibilityWarnings.filter(e => e.timestamp >= since),
    };
  }

  /**
   * Get broken resources detected on the page
   */
  getBrokenResources(): typeof this.brokenResources {
    return [...this.brokenResources];
  }

  /**
   * Get slow API calls (>2s response time)
   */
  getSlowApiCalls(): typeof this.slowApiCalls {
    return [...this.slowApiCalls];
  }

  /**
   * Get slow API calls since a given timestamp (step-scoped)
   */
  getSlowApiCallsSince(since: number): typeof this.slowApiCalls {
    return this.slowApiCalls.filter(c => c.timestamp >= since);
  }

  /**
   * Get all API calls with timing (for performance metrics calculation)
   */
  getAllApiCalls(): typeof this.allApiCalls {
    return [...this.allApiCalls];
  }

  /**
   * Clear all collected errors
   */
  clear(): void {
    this.consoleErrors = [];
    this.networkErrors = [];
    this.uiErrors = [];
    this.accessibilityWarnings = [];
    this.brokenResources = [];
    this.slowApiCalls = [];
    this.allApiCalls = [];
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

  // ═══════════════════════════════════════════════════════════════════════════
  // V11: Field-level validation error parsing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Parse field-level validation errors from 4xx response body.
   * Supports multiple API formats: Laravel/Rails, array-based, object-based.
   */
  private static parseFieldErrors(body: any): Array<{ field: string; message: string }> | undefined {
    if (!body) return undefined;
    const errors: Array<{ field: string; message: string }> = [];
    try {
      // Format 1: Object { errors: { email: ['invalid'], password: ['too short'] } } (Laravel/Rails)
      if (body.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)) {
        for (const [field, msgs] of Object.entries(body.errors)) {
          if (Array.isArray(msgs)) {
            for (const m of msgs) {
              errors.push({ field, message: String(m) });
            }
          } else if (typeof msgs === 'string') {
            errors.push({ field, message: msgs });
          }
        }
      }
      // Format 2: Array [{ field: 'email', message: 'invalid' }]
      else if (Array.isArray(body.errors)) {
        for (const e of body.errors) {
          if (e && typeof e === 'object' && e.field && e.message) {
            errors.push({ field: String(e.field), message: String(e.message) });
          }
        }
      }
    } catch { /* non-fatal */ }
    return errors.length > 0 ? errors : undefined;
  }
}
