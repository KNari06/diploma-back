import { Page } from 'playwright';
import { logger } from '@/utils/core/logger';

export interface CollectedResults {
  screenshot?: string;
  dom?: string;
  logs: string[];
  networkLogs: NetworkLog[];
  errors: TestError[];
  dialogs?: Array<{ type: string; message: string; timestamp: Date }>;
  performance?: PerformanceMetrics;
}

interface NetworkLog {
  url: string;
  method: string;
  status: number;
  statusText: string;
  responseTime: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  responseBody?: any; // ✅ NEW: Response body for API requests
  timestamp: Date;
}

interface TestError {
  type: 'javascript' | 'network' | 'timeout' | 'assertion' | 'dialog' | 'other';
  message: string;
  stack?: string;
  url?: string;
  timestamp: Date;
  dialogType?: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
}

interface PerformanceMetrics {
  loadTime: number;
  domContentLoaded: number;
  firstContentfulPaint: number;
  largestContentfulPaint: number;
  firstInputDelay: number;
  cumulativeLayoutShift: number;
  totalBlockingTime: number;
}

/**
 * Collect test results from Playwright page
 */
export class ResultCollector {
  public logs: string[] = [];
  public networkLogs: NetworkLog[] = [];
  public errors: TestError[] = [];
  public dialogs: Array<{ type: string; message: string; timestamp: Date }> = [];
  private startTime: number = Date.now();

  /**
   * Setup listeners for a page
   */
  setupListeners(page: Page): void {
    // Console logs
    page.on('console', (msg) => {
      const logText = `[${msg.type()}] ${msg.text()}`;
      this.logs.push(logText);
      logger.debug('Console log captured', { type: msg.type(), text: msg.text() });
    });

    // JavaScript errors
    page.on('pageerror', (error) => {
      this.errors.push({
        type: 'javascript',
        message: error.message,
        stack: error.stack,
        timestamp: new Date(),
      });
      logger.warn('JavaScript error captured', { message: error.message });
    });

    // Network requests with response bodies for intelligent mode
    page.on('response', async (response) => {
      try {
        const url = response.url();

        // ✅ FIX: Ignore external services (Google Analytics, Firebase, etc.)
        // These are third-party services used by the user's website, not part of the platform
        const externalServicePatterns = [
          'google-analytics.com',
          'googleapis.com',
          'firebase.googleapis.com',
          'googletagmanager.com',
          'doubleclick.net',
          'googleadservices.com',
          'facebook.com',
          'facebook.net',
          'analytics.js',
          'gtag.js',
          'ga.js',
          'adservice',
          'adsystem',
        ];

        const isExternalService = externalServicePatterns.some(pattern => url.includes(pattern));
        if (isExternalService) {
          return; // Skip logging external services
        }

        const request = response.request();
        const timing = response.request().timing();

        // ✅ FIX: Collect response bodies for important API requests (intelligent mode needs this)
        let responseBody: any = null;
        const isImportantRequest =
          url.includes('/api/') ||
          url.includes('/graphql') ||
          url.includes('/rest/') ||
          (request.resourceType() === 'xhr' || request.resourceType() === 'fetch');

        if (isImportantRequest && response.status() < 400) {
          try {
            // Try to get response body (with size limit to avoid memory issues)
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('application/json') || contentType.includes('text/')) {
              const body = await response.text();
              // Limit body size to 100KB to avoid memory issues
              if (body.length <= 100 * 1024) {
                try {
                  responseBody = JSON.parse(body); // Try to parse as JSON
                } catch {
                  responseBody = body.substring(0, 10000); // If not JSON, truncate to 10KB
                }
              } else {
                responseBody = { _truncated: true, _size: body.length };
              }
            }
          } catch (bodyError) {
            // Failed to get body - continue without it
            logger.debug('[RESULT_COLLECTOR] Failed to capture response body', {
              url: url.substring(0, 100),
              error: bodyError instanceof Error ? bodyError.message : String(bodyError),
            });
          }
        }

        this.networkLogs.push({
          url,
          method: request.method(),
          status: response.status(),
          statusText: response.statusText(),
          responseTime: timing?.responseEnd || 0,
          requestHeaders: await request.allHeaders(),
          responseHeaders: await response.allHeaders(),
          responseBody, // ✅ NEW: Include response body for API requests
          timestamp: new Date(),
        });
      } catch (error) {
        logger.debug('Failed to capture network log', { error });
      }
    });

    // Request failures
    page.on('requestfailed', (request) => {
      const url = request.url();

      // ✅ FIX: Ignore external services failures (not our concern)
      const externalServicePatterns = [
        'google-analytics.com',
        'googleapis.com',
        'firebase.googleapis.com',
        'googletagmanager.com',
        'doubleclick.net',
        'googleadservices.com',
        'facebook.com',
        'facebook.net',
        'analytics.js',
        'gtag.js',
        'ga.js',
        'adservice',
        'adsystem',
      ];

      const isExternalService = externalServicePatterns.some(pattern => url.includes(pattern));
      if (isExternalService) {
        return; // Skip logging external service failures
      }

      this.errors.push({
        type: 'network',
        message: `Request failed: ${url}`,
        url,
        timestamp: new Date(),
      });
      logger.warn('Request failed', { url });
    });

    // ✅ NEW: Capture dialogs (alert, confirm, prompt, beforeunload)
    page.on('dialog', async (dialog) => {
      const dialogType = dialog.type(); // 'alert' | 'confirm' | 'prompt' | 'beforeunload'
      const message = dialog.message();

      // Log dialog
      this.dialogs.push({
        type: dialogType,
        message,
        timestamp: new Date(),
      });

      // Add to errors for visibility (dialogs are often errors or warnings)
      this.errors.push({
        type: 'dialog',
        message: `${dialogType}: ${message}`,
        dialogType: dialogType as 'alert' | 'confirm' | 'prompt' | 'beforeunload',
        timestamp: new Date(),
      });

      // Add to logs
      this.logs.push(`[DIALOG ${dialogType.toUpperCase()}] ${message}`);

      logger.info('Dialog detected', { type: dialogType, message });

      // Auto-dismiss dialogs to prevent blocking test execution
      try {
        await dialog.dismiss();
        logger.debug('Dialog auto-dismissed', { type: dialogType });
      } catch (dismissError) {
        logger.warn('Failed to dismiss dialog', {
          type: dialogType,
          error: dismissError instanceof Error ? dismissError.message : String(dismissError),
        });
      }
    });
  }

  /**
   * Collect all results from page
   */
  async collect(page: Page, captureScreenshot = true): Promise<CollectedResults> {
    const results: CollectedResults = {
      logs: this.logs,
      networkLogs: this.networkLogs,
      errors: this.errors,
      dialogs: this.dialogs.length > 0 ? this.dialogs : undefined,
    };

    // Screenshot
    if (captureScreenshot) {
      try {
        const screenshotBuffer = await page.screenshot({
          fullPage: false,
          type: 'png',
        });
        results.screenshot = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
        logger.debug('Screenshot captured');
      } catch (error) {
        logger.error('Failed to capture screenshot', { error });
      }
    }

    // DOM
    try {
      results.dom = await page.content();
      logger.debug('DOM captured', { length: results.dom.length });
    } catch (error) {
      logger.error('Failed to capture DOM', { error });
    }

    // Performance metrics (full Web Vitals)
    try {
      const metrics = await page.evaluate(`
        (function() {
          var entries = performance.getEntries();
          var navigationEntry = entries.find(function(e) { return e.entryType === 'navigation'; });
          var paintEntries = entries.filter(function(e) { return e.entryType === 'paint'; });
          var fcp = paintEntries.find(function(e) { return e.name === 'first-contentful-paint'; });

          // LCP: last entry of largest-contentful-paint
          var lcpEntries = [];
          try { lcpEntries = performance.getEntriesByType('largest-contentful-paint'); } catch(e) {}
          var lcp = lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1] : null;

          // CLS: sum of layout-shift entries without recent input
          var layoutShiftEntries = [];
          try { layoutShiftEntries = performance.getEntriesByType('layout-shift'); } catch(e) {}
          var cls = 0;
          for (var i = 0; i < layoutShiftEntries.length; i++) {
            if (!layoutShiftEntries[i].hadRecentInput) {
              cls += layoutShiftEntries[i].value;
            }
          }

          // TBT: sum of (duration - 50ms) for long tasks
          var longTaskEntries = [];
          try { longTaskEntries = performance.getEntriesByType('longtask'); } catch(e) {}
          var tbt = 0;
          for (var j = 0; j < longTaskEntries.length; j++) {
            tbt += Math.max(0, longTaskEntries[j].duration - 50);
          }

          var loadTime = 0;
          var domContentLoaded = 0;
          if (navigationEntry && navigationEntry.loadEventEnd > 0 && navigationEntry.fetchStart > 0) {
            var calcLoadTime = Math.round(navigationEntry.loadEventEnd - navigationEntry.fetchStart);
            loadTime = calcLoadTime > 0 ? calcLoadTime : 0;
          }
          if (navigationEntry && navigationEntry.domContentLoadedEventEnd > 0 && navigationEntry.fetchStart > 0) {
            var calcDCL = Math.round(navigationEntry.domContentLoadedEventEnd - navigationEntry.fetchStart);
            domContentLoaded = calcDCL > 0 ? calcDCL : 0;
          }

          return {
            loadTime: loadTime,
            domContentLoaded: domContentLoaded,
            firstContentfulPaint: fcp ? Math.round(fcp.startTime) : 0,
            largestContentfulPaint: lcp ? Math.round(lcp.startTime) : 0,
            firstInputDelay: 0,
            cumulativeLayoutShift: Math.round(cls * 1000) / 1000,
            totalBlockingTime: Math.round(tbt),
          };
        })()
      `) as PerformanceMetrics;

      results.performance = metrics;
      logger.debug('Performance metrics captured', metrics);
    } catch (error) {
      logger.debug('Failed to capture performance metrics', { error });
    }

    return results;
  }

  /**
   * Reset collector for new test
   */
  reset(): void {
    this.logs = [];
    this.networkLogs = [];
    this.errors = [];
    this.dialogs = [];
    this.startTime = Date.now();
  }

  /**
   * Get elapsed time since start
   */
  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }
}
