import { dbAdminService } from '@/db/supabase';
import { TestJobData } from '@/types';
import { logger } from '@/utils/logger';
import { webSocketService } from '@/websocket/websocket.service';
import { BrowserContext, BrowserContextOptions, devices, Page } from 'playwright';
import { browserPool } from './browser-pool';
import { IntelligentTestOrchestrator } from './intelligent-test-orchestrator';
import { ResultCollector } from './result-collector';
import { DEFAULT_SAFETY_CONFIG } from './safety-guard';
import { IntelligentTestConfig } from './types/intelligent-testing.types';

/**
 * Check if test is cancelled and throw error if so
 */
async function checkTestCancelled(testId: string): Promise<void> {
  try {
    const test = await dbAdminService.getTest(testId) as any;
    if (test?.status === 'cancelled') {
      throw new Error(`Test ${testId} was cancelled`);
    }
  } catch (error) {
    // If error is already about cancellation, rethrow it
    if (error instanceof Error && error.message.includes('cancelled')) {
      throw error;
    }
    // Otherwise, log warning but don't block execution
    logger.warn(`[PLAYWRIGHT] Failed to check test status: ${testId}`, error);
  }
}

/**
 * Request tracker for intelligent mode
 * Setup BEFORE navigation to catch all API requests
 * ✅ FIX: Uses Map with counters to track duplicate requests to the same URL
 */
class RequestTracker {
  private page: import('playwright').Page;
  // Active requests tracked by Request object (most reliable)
  private pendingRequests: Set<import('playwright').Request> = new Set();
  // Counters per URL for metrics/logging
  private pendingCountsByUrl: Map<string, number> = new Map();
  private completedCountsByUrl: Map<string, number> = new Map();

  // Patterns for external services we want to ignore
  private readonly externalServicePatterns = [
    'google-analytics.com',
    'googletagmanager.com',
    'facebook.net',
    'sentry.io',
    'browserstack',
    'rollbar',
    'hotjar',
  ];

  constructor(page: import('playwright').Page) {
    this.page = page;
    this.setupListeners();
  }

  private isPotentialApiRequest(url: string, resourceType?: string) {
    if (!url) return false;
    const lower = url.toLowerCase();
    if (this.externalServicePatterns.some(p => lower.includes(p))) return false;
    // Heuristic: treat XHR/fetch and URLs with /api/ /graphql/ /rest/ as important
    if (resourceType === 'xhr' || resourceType === 'fetch') return true;
    if (lower.includes('/api/') || lower.includes('/graphql') || lower.includes('/rest/')) return true;
    // otherwise skip noisy assets
    return false;
  }

  private setupListeners() {
    this.page.on('request', (request) => {
      try {
        const url = request.url();
        const rt = request.resourceType();
        if (!this.isPotentialApiRequest(url, rt)) return;

        this.pendingRequests.add(request);
        const prev = this.pendingCountsByUrl.get(url) || 0;
        this.pendingCountsByUrl.set(url, prev + 1);

        // debug log
        // eslint-disable-next-line no-console
        console.debug('[RequestTracker] request added', { url: url.slice(0, 200), totalPending: this.pendingRequests.size });
      } catch (e) {
        // ignore listener errors
      }
    });

    // Use requestfinished and requestfailed to reliably remove pending requests
    this.page.on('requestfinished', (request) => this.markCompleted(request, 'finished'));
    this.page.on('requestfailed', (request) => this.markCompleted(request, 'failed'));
  }

  private markCompleted(request: import('playwright').Request, reason: string) {
    try {
      if (!this.pendingRequests.has(request)) return;
      this.pendingRequests.delete(request);
      const url = request.url();
      const prev = this.pendingCountsByUrl.get(url) || 1;
      if (prev <= 1) {
        this.pendingCountsByUrl.delete(url);
        this.completedCountsByUrl.set(url, (this.completedCountsByUrl.get(url) || 0) + 1);
      } else {
        this.pendingCountsByUrl.set(url, prev - 1);
      }

      // eslint-disable-next-line no-console
      console.debug('[RequestTracker] request completed', { url: url.slice(0,200), reason, remaining: this.pendingRequests.size });
    } catch (e) {
      // ignore
    }
  }

  /**
   * Wait for outstanding tracked requests to settle or until timeout.
   * Returns true if all tracked requests completed, false if timed out.
   */
  async waitForNetworkIdle(timeout = 15000, checkInterval = 200) {
    const start = Date.now();
    while (this.pendingRequests.size > 0 && (Date.now() - start) < timeout) {
      await new Promise(r => setTimeout(r, checkInterval));
    }

    const completed = this.pendingRequests.size === 0;
    if (!completed) {
      // Log details about remaining requests for debugging
      const leftoverUrls = Array.from(this.pendingCountsByUrl.keys()).slice(0, 10);
      // eslint-disable-next-line no-console
      console.warn('[RequestTracker] network idle wait timed out', { remaining: this.pendingRequests.size, leftoverUrls });
    }
    return completed;
  }

  getPendingCount() {
    return this.pendingRequests.size;
  }

  getPendingCountsByUrl() {
    return new Map(this.pendingCountsByUrl);
  }
}
// class RequestTracker {
//   // ✅ FIX: Use Map<URL, count> to track multiple requests to same URL
//   private pendingRequests = new Map<string, number>();
//   private completedRequests = new Map<string, number>();
//   private page: Page;

//   constructor(page: Page) {
//     this.page = page;
//     this.setupListeners();
//   }

//   private setupListeners() {
//     // Track all requests
//     this.page.on('request', (request) => {
//       const url = request.url();

//       // ✅ FIX: Ignore external services (Google Analytics, Firebase, etc.)
//       // These are third-party services used by the user's website, not part of the platform
//       const externalServicePatterns = [
//         'google-analytics.com',
//         'googleapis.com',
//         'firebase.googleapis.com',
//         'googletagmanager.com',
//         'doubleclick.net',
//         'googleadservices.com',
//         'facebook.com',
//         'facebook.net',
//         'analytics.js',
//         'gtag.js',
//         'ga.js',
//         'adservice',
//         'adsystem',
//       ];

//       const isExternalService = externalServicePatterns.some(pattern => url.includes(pattern));
//       if (isExternalService) {
//         return; // Skip tracking external services
//       }

//       // Filter: only track API requests (not static assets, not websockets, not long-polling)
//       if (
//         url.includes('/api/') ||
//         url.includes('/graphql') ||
//         url.includes('/rest/') ||
//         (request.resourceType() === 'xhr' || request.resourceType() === 'fetch')
//       ) {
//         // Ignore websockets and long-polling patterns
//         if (
//           !url.includes('ws://') &&
//           !url.includes('wss://') &&
//           !url.includes('/poll') &&
//           !url.includes('/stream') &&
//           !url.includes('/events') &&
//           !url.includes('/sse')
//         ) {
//           // ✅ FIX: Increment counter for this URL (supports duplicate requests)
//           const currentCount = this.pendingRequests.get(url) || 0;
//           this.pendingRequests.set(url, currentCount + 1);
//           // ✅ IMPORTANT: These logs are valuable for debugging SPA loading issues
//           // Shows which API requests are being made and their status
//           logger.debug('[PLAYWRIGHT] Tracking API request', {
//             url: url.substring(0, 100),
//             requestCount: currentCount + 1,
//             totalPending: this.pendingRequests.size, // Total unique URLs pending
//           });
//         }
//       }
//     });

//     // Track completed requests
//     this.page.on('response', (response) => {
//       const url = response.url();

//       // ✅ FIX: Ignore external services (Google Analytics, Firebase, etc.)
//       const externalServicePatterns = [
//         'google-analytics.com',
//         'googleapis.com',
//         'firebase.googleapis.com',
//         'googletagmanager.com',
//         'doubleclick.net',
//         'googleadservices.com',
//         'facebook.com',
//         'facebook.net',
//         'analytics.js',
//         'gtag.js',
//         'ga.js',
//         'adservice',
//         'adsystem',
//       ];

//       const isExternalService = externalServicePatterns.some(pattern => url.includes(pattern));
//       if (isExternalService) {
//         return; // Skip tracking external services
//       }

//       const pendingCount = this.pendingRequests.get(url);

//       if (pendingCount !== undefined && pendingCount > 0) {
//         // ✅ FIX: Decrement counter instead of deleting immediately
//         const newCount = pendingCount - 1;

//         if (newCount === 0) {
//           // All requests to this URL completed
//           this.pendingRequests.delete(url);
//           const completedCount = this.completedRequests.get(url) || 0;
//           this.completedRequests.set(url, completedCount + 1);
//         } else {
//           // Still have pending requests to this URL
//           this.pendingRequests.set(url, newCount);
//         }

//         // ✅ IMPORTANT: These logs are valuable for debugging SPA loading issues
//         // Shows request completion status and remaining pending requests
//         logger.debug('[PLAYWRIGHT] API request completed', {
//           url: url.substring(0, 100),
//           status: response.status(),
//           remainingPending: newCount, // Requests to this specific URL still pending
//           totalPendingUrls: this.pendingRequests.size, // Total unique URLs still pending
//         });
//       }
//     });
//   }

//   async waitForCompletion(timeout: number = 15000): Promise<void> {
//     const startTime = Date.now();
//     const checkInterval = 500; // Check every 500ms

//     // ✅ FIX: Wait for all tracked requests to complete (using Map.size which counts all pending)
//     while (this.pendingRequests.size > 0 && (Date.now() - startTime) < timeout) {
//       await this.page.waitForTimeout(checkInterval);
//     }

//     const duration = Date.now() - startTime;

//     // Calculate total completed requests
//     const totalCompleted = Array.from(this.completedRequests.values()).reduce((sum, count) => sum + count, 0);

//     if (this.pendingRequests.size > 0) {
//       // Calculate total pending requests
//       const totalPending = Array.from(this.pendingRequests.values()).reduce((sum, count) => sum + count, 0);

//       logger.warn('[PLAYWRIGHT] Some API requests did not complete within timeout', {
//         pendingUrlCount: this.pendingRequests.size, // Unique URLs
//         pendingRequestCount: totalPending, // Total requests
//         completedUrlCount: this.completedRequests.size,
//         completedRequestCount: totalCompleted,
//         duration: `${duration}ms`,
//         pendingUrls: Array.from(this.pendingRequests.keys()).slice(0, 3).map(url => url.substring(0, 100)),
//       });
//     } else {
//       logger.info('[PLAYWRIGHT] All important API requests completed', {
//         completedUrlCount: this.completedRequests.size,
//         completedRequestCount: totalCompleted,
//         duration: `${duration}ms`,
//       });
//     }

//     // Additional wait for DOM to render API data (common patterns)
//     try {
//       // Wait for common content indicators to appear
//       await Promise.race([
//         this.page.waitForSelector('[data-loaded], .content-loaded, [class*="list"], [class*="grid"]', { timeout: 3000 }).catch(() => null),
//         this.page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => null),
//         this.page.waitForTimeout(2000), // Fallback: wait 2 seconds for rendering
//       ]);
//     } catch (error) {
//       // Continue anyway - data might already be rendered
//       logger.debug('[PLAYWRIGHT] Content rendering wait completed or timed out');
//     }
//   }
// }

/**
 * Execute Playwright test
 */
export async function executePlaywrightTest(testData: TestJobData): Promise<{
  success: boolean;
  status: string;
  screenshot?: string;
  dom?: string;
  logs: string[];
  networkLogs: any[];
  errors: any[];
  performance?: any;
  // ✅ NEW: Video & Trace support
  videoUrl?: string;
  videoPath?: string;
  traceUrl?: string;
  tracePath?: string;
  error?: string;
}> {
  let page: Page | null = null;
  let context: BrowserContext | null = null;
  let videoPath: string | undefined;
  let tracePath: string | undefined;
  const collector = new ResultCollector();

  try {
    // Check if test was cancelled before starting
    await checkTestCancelled(testData.testId);

    logger.info('[PLAYWRIGHT] Starting test', {
      testId: testData.testId,
      url: testData.url,
      browser: testData.browser,
      intelligentMode: testData.intelligentMode || false,
      projectId: testData.projectId,
      userId: testData.userId,
    });

    // Emit progress: Browser launching (10%)
    webSocketService.emitTestProgress(testData.testId, {
      testId: testData.testId,
      browser: testData.browser,
      progress: 10,
      phase: 'initialization',
      currentStep: '🌐 Launching browser...',
      status: 'running',
      timestamp: new Date().toISOString(),
    });

    // Get browser from pool
    const browser = await browserPool.getBrowser(testData.browser);

    // Emit progress: Browser ready (15%)
    webSocketService.emitTestProgress(testData.testId, {
      testId: testData.testId,
      browser: testData.browser,
      progress: 15,
      phase: 'initialization',
      currentStep: '✅ Browser ready',
      status: 'running',
      timestamp: new Date().toISOString(),
    });

    // ✅ FIX: Prepare video & trace directories
    const fs = await import('fs/promises');
    const path = await import('path');

    const videosDir = path.join(process.cwd(), 'test-results', 'videos');
    const tracesDir = path.join(process.cwd(), 'test-results', 'traces');

    await fs.mkdir(videosDir, { recursive: true });
    await fs.mkdir(tracesDir, { recursive: true });

    // Create context with options
    // ✅ FIX: Use realistic User-Agent to avoid bot detection
    const defaultUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const contextOptions: BrowserContextOptions = {
      viewport: testData.options?.viewport
        ? {
            width: testData.options.viewport.width || 1920,
            height: testData.options.viewport.height || 1080
          }
        : { width: 1920, height: 1080 },
      userAgent: testData.options?.headers?.['User-Agent'] || defaultUserAgent,
      // ✅ FIX: Add extra HTTP headers to look like real browser
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
      },
      // ✅ NEW: Enable video recording
      recordVideo: {
        dir: videosDir,
        size: { width: 1920, height: 1080 }
      },
      // ✅ FIX: Set locale and timezone to look more realistic
      locale: 'en-US',
      timezoneId: 'America/New_York',
      // ✅ FIX: Ignore HTTPS errors (in case of SSL issues)
      ignoreHTTPSErrors: false, // Keep false for security, but we can enable if needed
    };

    // Mobile emulation
    if (testData.options?.mobile || testData.browser.includes('mobile')) {
      const device = testData.browser === 'mobile-safari'
        ? devices['iPhone 12']
        : devices['Pixel 5'];
      Object.assign(contextOptions, device);
      // Update video size for mobile
      if (contextOptions.recordVideo && contextOptions.viewport) {
        contextOptions.recordVideo.size = {
          width: contextOptions.viewport.width,
          height: contextOptions.viewport.height,
        };
      }
    }

    context = await browser.newContext(contextOptions);

    // ✅ NEW: Start tracing
    tracePath = path.join(tracesDir, `trace-${testData.testId}-${Date.now()}.zip`);
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });

    logger.info('[PLAYWRIGHT] Video & Trace recording started', {
      testId: testData.testId,
      videoDir: videosDir,
      tracePath,
    });

    page = await context.newPage();

    // ✅ FIX: Ensure page is not null
    if (!page) {
      throw new Error('Failed to create page');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ✅ UNIFIED MODE: Always use Intelligent Mode (Standard Mode removed)
    // - Commands from plan are converted to "hints" for AI guidance
    // - AI adapts to actual page elements instead of failing on broken selectors
    // - Self-healing, Vision AI, and adaptive testing always enabled
    // ═══════════════════════════════════════════════════════════════════════

    const hasCommands = !!(testData.commands && testData.commands.length > 0);
    const goal = testData.testGoal || testData.intent || 'Test the application';

    // ✅ NEW: Convert commands to hints for AI guidance
    const hintsFromCommands = hasCommands && testData.commands
      ? testData.commands.map((cmd, i) => ({
          id: `cmd_${i}`,
          description: cmd.description || `${cmd.action} on ${cmd.selector || 'page'}`,
          action: cmd.action,
          target: cmd.selector,
          value: cmd.value !== undefined ? String(cmd.value) : undefined, // Convert to string
          priority: 'medium' as const,
        }))
      : [];

    logger.info('[PLAYWRIGHT] Unified Intelligent Mode activated', {
      testId: testData.testId,
      goal,
      hasCommands,
      hintsCount: hintsFromCommands.length,
      mode: 'balanced',
    });

    // ═══════════════════════════════════════════════════════════════════════
    // INTELLIGENT MODE: Use IntelligentTestOrchestrator for ALL tests
    // ═══════════════════════════════════════════════════════════════════════
    {
      logger.info('[PLAYWRIGHT] Starting intelligent test execution', {
        testId: testData.testId,
        goal,
        hintsCount: hintsFromCommands.length,
      });

      // Emit progress: Navigating to page (20%)
      webSocketService.emitTestProgress(testData.testId, {
        testId: testData.testId,
        browser: testData.browser,
        progress: 20,
        phase: 'initialization',
        currentStep: `📄 Navigating to ${testData.url}...`,
        status: 'running',
        timestamp: new Date().toISOString(),
      });

      // ✅ FIX: Setup request tracking BEFORE navigation
      const requestTracker = new RequestTracker(page);

      // Navigate to URL with smart waiting strategy for intelligent mode
      try {
        // ✅ FIX: Hide webdriver property to avoid bot detection
        await page.addInitScript(() => {
          // @ts-expect-error - browser context
          Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
          });
          // @ts-expect-error - browser context
          window.chrome = {
            runtime: {},
          };
          // @ts-expect-error - browser context
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
          });
          // @ts-expect-error - browser context
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
          });
        });

        logger.info('[PLAYWRIGHT] Starting navigation', {
          testId: testData.testId,
          targetUrl: testData.url,
          userAgent: contextOptions.userAgent,
        });

        // Try navigation with different wait strategies
        let navigationResponse = null;
        try {
          navigationResponse = await page.goto(testData.url, {
            waitUntil: 'domcontentloaded', // Faster and more reliable than 'load'
            timeout: 45000, // Increase timeout
          });
        } catch (timeoutError) {
          // Try with 'networkidle' as fallback
          logger.warn('[PLAYWRIGHT] Navigation with domcontentloaded timed out, trying networkidle', {
            testId: testData.testId,
          });
          navigationResponse = await page.goto(testData.url, {
            waitUntil: 'networkidle',
            timeout: 30000,
          });
        }

        // ✅ FIX: Check response status
        if (navigationResponse) {
          const status = navigationResponse.status();
          if (status >= 400) {
            logger.error('[PLAYWRIGHT] Navigation returned error status', {
              testId: testData.testId,
              targetUrl: testData.url,
              status,
              statusText: navigationResponse.statusText(),
            });
            throw new Error(`Navigation failed with HTTP ${status}: ${navigationResponse.statusText()}`);
          }

          logger.info('[PLAYWRIGHT] Navigation response received', {
            testId: testData.testId,
            status,
            url: navigationResponse.url(),
          });
        }

        // Wait a bit for JavaScript to execute
        await page.waitForTimeout(2000);

        // ✅ CRITICAL FIX: Verify navigation succeeded
        const currentUrl = page.url();
        if (currentUrl === 'about:blank' || !currentUrl || currentUrl.includes('about:')) {
          logger.error('[PLAYWRIGHT] Navigation failed - page stuck on about:blank', {
            testId: testData.testId,
            targetUrl: testData.url,
            currentUrl,
            responseStatus: navigationResponse?.status(),
          });
          throw new Error(`Navigation failed: page is at "${currentUrl}" instead of "${testData.url}"`);
        }

        // Check if we got redirected somewhere unexpected
        if (currentUrl !== testData.url && !currentUrl.startsWith(testData.url.split('?')[0])) {
          logger.warn('[PLAYWRIGHT] Navigation redirected to different URL', {
            testId: testData.testId,
            targetUrl: testData.url,
            actualUrl: currentUrl,
          });
          // Don't throw - redirects are sometimes normal (HTTP to HTTPS, etc)
        }

        logger.info('[PLAYWRIGHT] Navigation successful', {
          testId: testData.testId,
          targetUrl: testData.url,
          actualUrl: currentUrl,
          responseStatus: navigationResponse?.status(),
        });
      } catch (navError) {
        const currentUrl = page.url();
        const errorDetails = navError instanceof Error ? {
          message: navError.message,
          name: navError.name,
          stack: navError.stack,
        } : String(navError);

        logger.error('[PLAYWRIGHT] Navigation error', {
          testId: testData.testId,
          targetUrl: testData.url,
          currentUrl,
          error: errorDetails,
        });

        // Try to get page title for debugging
        try {
          const title = await page.title();
          logger.debug('[PLAYWRIGHT] Page title after failed navigation', { title });
        } catch {
          // Ignore errors getting title
        }

        throw new Error(`Failed to navigate to ${testData.url}: ${navError instanceof Error ? navError.message : 'Unknown error'}`);
      }

      // ✅ FIX: Wait for important API requests to complete (network idle heuristic)
      await requestTracker.waitForNetworkIdle(15000);

      // Check if test was cancelled after navigation
      await checkTestCancelled(testData.testId);

      // ✅ CRITICAL FIX: Double-check URL after waiting
      const finalUrl = page.url();
      if (finalUrl === 'about:blank' || !finalUrl || finalUrl.includes('about:')) {
        logger.error('[PLAYWRIGHT] Page redirected to about:blank after navigation', {
          testId: testData.testId,
          targetUrl: testData.url,
          finalUrl,
        });
        throw new Error(`Page redirected to "${finalUrl}" instead of staying on "${testData.url}"`);
      }

      // ✅ REMOVED: WebSocketService - workers should not emit WebSocket events directly
      logger.debug('[PLAYWRIGHT] Page loaded', {
        testId: testData.testId,
        browser: testData.browser,
        url: finalUrl,
      });

      // Build intelligent test config with hints from commands (if any)
      const intelligentConfig: IntelligentTestConfig = {
        mode: 'balanced', // Use balanced mode by default
        safety: {
          ...DEFAULT_SAFETY_CONFIG,
          level: 'normal',
        },
        goal,
        startUrl: testData.url,
        browser: testData.browser, // Add browser for progress tracking
        credentials: testData.options?.credentials,
        userContext: {
          projectId: testData.projectId,
          testId: testData.testId,
        },
        // ✅ NEW: Features migrated from Standard Mode
        hints: hintsFromCommands.length > 0 ? hintsFromCommands : undefined,
        waitForSelector: testData.options?.waitForSelector,
        customScripts: testData.options?.customScripts,
        commands: testData.commands, // Keep original commands for reference
      };

      // Create orchestrator (with testId for cancellation checks)
      const orchestrator = new IntelligentTestOrchestrator(
        intelligentConfig,
        testData.userId,
        testData.testId
      );

      // Execute intelligent test (will check cancellation internally)
      const intelligentResult = await orchestrator.execute(browser, page);

      logger.info('[PLAYWRIGHT] Intelligent test completed', {
        testId: testData.testId,
        success: intelligentResult.success,
        pagesVisited: intelligentResult.pagesVisited,
        actionsTaken: intelligentResult.actionsTaken,
        duration: `${Math.round(intelligentResult.duration / 1000)}s`,
        cost: `$${intelligentResult.cost.toFixed(3)}`,
      });

      // ═══════════════════════════════════════════════════════════════════════
      // SAVE TO SPECIALIZED INTELLIGENT TEST TABLES
      // ═══════════════════════════════════════════════════════════════════════
      try {
        const { IntelligentTestStorageService } = await import('@/services/testing/results/intelligent-test-storage.service');

        await IntelligentTestStorageService.saveTestSession({
          testId: testData.testId,
          userId: testData.userId || 'anonymous',
          projectId: testData.projectId,
          result: intelligentResult,
          config: {
            goal: intelligentConfig.goal,
            startUrl: intelligentConfig.startUrl,
            mode: intelligentConfig.mode,
            browser: testData.browser || 'chrome',
            viewport: testData.options?.viewport,
            credentialsUsed: !!testData.options?.credentials,
          },
          graphData: intelligentResult.graphData, // ✅ NEW: Save complete graph
        });

        logger.info('[PLAYWRIGHT] Test data saved to database', {
          testId: testData.testId,
          tables: ['intelligent_test_sessions', 'intelligent_page_visits', 'intelligent_test_actions'],
        });
      } catch (storageError) {
        logger.error('[PLAYWRIGHT] Failed to save test data', {
          testId: testData.testId,
          error: storageError instanceof Error ? storageError.message : 'Unknown error',
        });
        // Don't fail the test if storage fails
      }

      // ✅ NEW: Upload screenshots from intelligent test to Supabase Storage
      const screenshotUrls: string[] = [];
      logger.info('[PLAYWRIGHT] Checking screenshots for upload', {
        testId: testData.testId,
        screenshotsCount: intelligentResult.screenshots?.length || 0,
        hasScreenshots: !!(intelligentResult.screenshots && intelligentResult.screenshots.length > 0),
      });
      if (intelligentResult.screenshots && intelligentResult.screenshots.length > 0) {
        try {
          const { uploadScreenshotToStorage } = await import('@/services/storage/test-artifacts-storage.service');

          for (let i = 0; i < intelligentResult.screenshots.length; i++) {
            const screenshot = intelligentResult.screenshots[i];
            if (screenshot.screenshot) {
              try {
                const screenshotUrl = await uploadScreenshotToStorage(
                  screenshot.screenshot,
                  testData.testId,
                  testData.userId || 'anonymous',
                  i
                );
                screenshotUrls.push(screenshotUrl);
                logger.info('[PLAYWRIGHT] Intelligent test screenshot uploaded', {
                  testId: testData.testId,
                  index: i,
                  url: screenshotUrl,
                });
              } catch (screenshotError) {
                logger.error('[PLAYWRIGHT] Failed to upload intelligent test screenshot', {
                  testId: testData.testId,
                  index: i,
                  error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
                });
              }
            }
          }
        } catch (uploadError) {
          logger.error('[PLAYWRIGHT] Failed to upload intelligent test screenshots', {
            testId: testData.testId,
            error: uploadError instanceof Error ? uploadError.message : String(uploadError),
          });
        }
      }

      // ✅ CRITICAL FIX: Stop tracing before closing (intelligent mode)
      if (context && tracePath) {
        try {
          await context.tracing.stop({ path: tracePath });
          logger.info('[PLAYWRIGHT] Trace saved (intelligent mode)', { tracePath });
        } catch (traceError) {
          logger.warn('[PLAYWRIGHT] Failed to stop tracing (intelligent mode)', { error: traceError });
        }
      }

      // ✅ CRITICAL FIX: Get video path before closing page (intelligent mode)
      if (page) {
        try {
          const video = page.video();
          if (video) {
            videoPath = await video.path();
            logger.info('[PLAYWRIGHT] Video saved (intelligent mode)', { videoPath });
          }
        } catch (videoError) {
          logger.warn('[PLAYWRIGHT] Failed to get video path (intelligent mode)', { error: videoError });
        }
      }

      // ✅ CRITICAL FIX: Close page and context after intelligent test (free resources)
      if (page) {
        try {
          await page.close();
          logger.debug('[PLAYWRIGHT] Page closed (intelligent mode)');
        } catch (pageError) {
          logger.warn('[PLAYWRIGHT] Failed to close page (intelligent mode)', { error: pageError });
        }
      }

      if (context) {
        try {
          await context.close();
          logger.debug('[PLAYWRIGHT] Context closed (intelligent mode)');
        } catch (contextError) {
          logger.warn('[PLAYWRIGHT] Failed to close context (intelligent mode)', { error: contextError });
        }
      }

      // ✅ NEW: Upload video and trace for intelligent tests
      let videoUrl: string | undefined;
      let traceUrl: string | undefined;

      try {
        const { uploadVideoToStorage, uploadTraceToStorage } = await import('@/services/storage/test-artifacts-storage.service');

        if (videoPath) {
          videoUrl = await uploadVideoToStorage(videoPath, testData.testId, testData.userId || 'anonymous');
          logger.info('[PLAYWRIGHT] Video uploaded to storage (intelligent mode)', { videoUrl });
        }

        if (tracePath) {
          traceUrl = await uploadTraceToStorage(tracePath, testData.testId, testData.userId || 'anonymous');
          logger.info('[PLAYWRIGHT] Trace uploaded to storage (intelligent mode)', { traceUrl });
        }
      } catch (uploadError) {
        logger.error('[PLAYWRIGHT] Failed to upload artifacts (intelligent mode)', {
          error: uploadError instanceof Error ? uploadError.message : String(uploadError),
        });
        // Don't fail the test if upload fails
      }

      // Convert intelligent result to standard format
      return {
        success: intelligentResult.success,
        status: intelligentResult.success ? 'completed' : 'failed',
        screenshot: intelligentResult.screenshots[0]?.screenshot,
        dom: '', // DOM will be in page visits
        logs: [`Intelligent test: ${intelligentResult.summary}`],
        networkLogs: [],
        errors: intelligentResult.errors.map(e => ({
          type: 'other' as const,
          message: e.message,
          timestamp: new Date(),
        })),
        performance: {
          pagesVisited: intelligentResult.pagesVisited,
          actionsTaken: intelligentResult.actionsTaken,
          duration: intelligentResult.duration,
          cost: intelligentResult.cost,
        },
        // ✅ NEW: Include video and trace URLs
        videoUrl,
        videoPath,
        traceUrl,
        tracePath,
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ✅ REMOVED: Standard Mode code - now all tests use Intelligent Mode
    // Commands are converted to hints and AI adapts to actual page elements
    // This provides self-healing, better accuracy, and adaptive testing
    // ═══════════════════════════════════════════════════════════════════════

  } catch (error) {
    // Check if error is about cancellation
    const isCancelled = error instanceof Error && error.message.includes('cancelled');

    if (isCancelled) {
      logger.info('[PLAYWRIGHT] Test was cancelled', {
        testId: testData.testId,
        browser: testData.browser,
      });

      // Cleanup resources
      if (page) {
        try {
          await page.close();
        } catch (cleanupError) {
          logger.warn('Failed to close page during cancellation', { error: cleanupError });
        }
      }

      if (context) {
        try {
          if (tracePath) {
            await context.tracing.stop({ path: tracePath }).catch(() => {});
          }
          await context.close();
        } catch (contextError) {
          logger.warn('Failed to close context during cancellation', { error: contextError });
        }
      }

      return {
        success: false,
        status: 'cancelled',
        logs: [],
        networkLogs: [],
        errors: [{
          type: 'cancelled',
          message: 'Test was cancelled by user',
          timestamp: new Date(),
        }],
        error: 'Test cancelled',
      };
    }

    // ✅ FIX: Explicitly extract error details for better debugging
    logger.error('Playwright test failed', {
      testId: testData.testId,
      browser: testData.browser,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack,
      } : String(error),
      url: testData.url,
      intelligentMode: testData.intelligentMode || false,
    });

    // ✅ CRITICAL FIX: Try to collect partial results and cleanup (works for both standard and intelligent mode)
    let partialResults = null;
    if (page) {
      try {
        // Only collect if not in intelligent mode (intelligent mode doesn't use collector)
        if (!testData.intelligentMode) {
          partialResults = await collector.collect(page, true);
        }

        // ✅ FIX: Get video path before closing page (error scenario)
        try {
          const video = page.video();
          if (video) {
            videoPath = await video.path();
            logger.debug('[PLAYWRIGHT] Video path saved (error scenario)', { videoPath });
          }
        } catch (videoError) {
          logger.debug('[PLAYWRIGHT] Failed to get video path (error scenario)', { error: videoError });
        }

        await page.close();
        logger.debug('[PLAYWRIGHT] Page closed (error cleanup)');
      } catch (cleanupError) {
        logger.error('Failed to collect partial results or close page', { error: cleanupError });
      }
    }

    // ✅ CRITICAL FIX: Cleanup context if it exists (error scenario)
    if (context) {
      try {
        // Stop tracing if it was started
        if (tracePath) {
          await context.tracing.stop({ path: tracePath }).catch(() => {
            // Ignore errors when stopping trace in error scenario
          });
        }
        await context.close();
        logger.debug('[PLAYWRIGHT] Context closed (error cleanup)');
      } catch (contextError) {
        logger.error('Failed to close context during error cleanup', { error: contextError });
      }
    }

    return {
      success: false,
      status: 'failed',
      screenshot: partialResults?.screenshot,
      dom: partialResults?.dom,
      logs: partialResults?.logs || collector.logs,
      networkLogs: partialResults?.networkLogs || collector.networkLogs,
      errors: partialResults?.errors || [
        ...collector.errors,
        {
          type: 'other',
          message: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date(),
        },
      ],
      error: error instanceof Error ? error.message : 'Test execution failed',
    };
  }
}

/**
 * Execute Playwright test with automatic retry
 */
export async function executePlaywrightTestWithRetry(
  testData: TestJobData,
  maxRetries: number = 2
): Promise<ReturnType<typeof executePlaywrightTest>> {
  let lastError: any;

  logger.info('[PLAYWRIGHT_RETRY] Starting test with retry logic', {
    testId: testData.testId,
    url: testData.url,
    browser: testData.browser,
    intelligentMode: testData.intelligentMode || false,
    maxRetries,
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
        const retryDelay = 2000 * attempt;
        logger.info('[PLAYWRIGHT_RETRY] Retrying Playwright test', {
          testId: testData.testId,
          attempt: attempt + 1, // ✅ FIX: Human-readable numbering (2, 3, 4)
          maxAttempts: maxRetries + 1,
          retryDelay: `${retryDelay}ms`,
          lastError: lastError instanceof Error ? lastError.message : String(lastError),
        });
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    } else {
      logger.info('[PLAYWRIGHT_RETRY] Initial test attempt', {
        testId: testData.testId,
        url: testData.url,
      });
    }

    try {
      const result = await executePlaywrightTest(testData);

      // Check if test was cancelled (result will have cancelled status)
      if (result.status === 'cancelled' || (result.error && result.error.includes('cancelled'))) {
        logger.info('[PLAYWRIGHT_RETRY] Test was cancelled', {
          testId: testData.testId,
          attempt: attempt + 1,
        });
        return result; // Return cancelled result immediately, don't retry
      }

      if (result.success) {
        if (attempt > 0) {
          logger.info('[PLAYWRIGHT_RETRY] Test succeeded after retry', {
            testId: testData.testId,
            successfulAttempt: attempt + 1, // ✅ FIX: Human-readable numbering
            totalAttempts: maxRetries + 1, // ✅ FIX: Total attempts = maxRetries + 1 (initial + retries)
          });
        }
        return result;
      }

      lastError = result.error;
      logger.warn('[PLAYWRIGHT_RETRY] Test attempt returned failure', {
        testId: testData.testId,
        attempt: attempt + 1, // ✅ FIX: Human-readable numbering (1, 2, 3, 4)
        maxAttempts: maxRetries + 1,
        status: result.status,
        error: result.error,
      });
    } catch (error) {
      // Check if error is about cancellation
      if (error instanceof Error && error.message.includes('cancelled')) {
        logger.info('[PLAYWRIGHT_RETRY] Test was cancelled during execution', {
          testId: testData.testId,
          attempt: attempt + 1,
        });
        // Return cancelled result
        return {
          success: false,
          status: 'cancelled',
          logs: [],
          networkLogs: [],
          errors: [{
            type: 'cancelled',
            message: 'Test was cancelled by user',
            timestamp: new Date(),
          }],
          error: 'Test cancelled',
        };
      }

      lastError = error;
      // ✅ FIX: Enhanced error logging with full context
      logger.warn('[PLAYWRIGHT_RETRY] Test attempt threw exception', {
        testId: testData.testId,
        attempt: attempt + 1,
        url: testData.url,
        browser: testData.browser,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
      });
    }
  }

  // All retries exhausted
  logger.error('[PLAYWRIGHT_RETRY] Test failed after all retries', {
    testId: testData.testId,
    url: testData.url,
    browser: testData.browser,
    intelligentMode: testData.intelligentMode || false,
    maxRetries,
    totalAttempts: maxRetries + 1,
    lastError: lastError instanceof Error ? {
      message: lastError.message,
      name: lastError.name,
      stack: lastError.stack,
    } : String(lastError),
  });

  return {
    success: false,
    status: 'failed',
    logs: [],
    networkLogs: [],
    errors: [
      {
        type: 'other',
        message: `Test failed after ${maxRetries} retries: ${lastError}`,
        timestamp: new Date(),
      },
    ],
    error: `Failed after ${maxRetries} retries`,
  };
}

/**
 * Get agent status
 */
export async function getAgentStatus(): Promise<{
  available: boolean;
  browserPool: ReturnType<typeof browserPool.getStatus>;
}> {
  return {
    available: true,
    browserPool: browserPool.getStatus(),
  };
}
