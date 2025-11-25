import { Page } from 'playwright';
import { logger } from '@/utils/logger';

export interface CollectedResults {
  screenshot?: string;
  dom?: string;
  logs: string[];
  networkLogs: NetworkLog[];
  errors: TestError[];
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
  type: 'javascript' | 'network' | 'timeout' | 'assertion' | 'other';
  message: string;
  stack?: string;
  url?: string;
  timestamp: Date;
}

interface PerformanceMetrics {
  loadTime: number;
  domContentLoaded: number;
  firstContentfulPaint: number;
}

/**
 * Collect test results from Playwright page
 */
export class ResultCollector {
  public logs: string[] = [];
  public networkLogs: NetworkLog[] = [];
  public errors: TestError[] = [];
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
  }

  /**
   * Collect all results from page
   */
  async collect(page: Page, captureScreenshot = true): Promise<CollectedResults> {
    const results: CollectedResults = {
      logs: this.logs,
      networkLogs: this.networkLogs,
      errors: this.errors,
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

    // Performance metrics (simplified for compatibility)
    try {
      const metrics = await page.evaluate(() => {
        const entries = performance.getEntries();
        const navigationEntry = entries.find((e: any) => e.entryType === 'navigation') as any;
        const paintEntries = entries.filter((e: any) => e.entryType === 'paint');
        const fcp = paintEntries.find((e: any) => e.name === 'first-contentful-paint') as any;

        if (navigationEntry) {
          return {
            loadTime: Math.round(navigationEntry.loadEventEnd - navigationEntry.fetchStart),
            domContentLoaded: Math.round(navigationEntry.domContentLoadedEventEnd - navigationEntry.fetchStart),
            firstContentfulPaint: fcp ? Math.round(fcp.startTime) : 0,
          };
        }

        // Fallback to simple timing
        return {
          loadTime: 0,
          domContentLoaded: 0,
          firstContentfulPaint: 0,
        };
      });

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
    this.startTime = Date.now();
  }

  /**
   * Get elapsed time since start
   */
  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }
}
