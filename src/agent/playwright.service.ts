import { dbAdminService } from '@/db/supabase';
import { TestJobData } from '@/types';
import { logger } from '@/utils/logger';
import { webSocketService } from '@/websocket/websocket.service';
import { BrowserContext, BrowserContextOptions, devices, Page } from 'playwright';
import { browserPool } from './browser-pool';
import { CommandExecutor } from './command-executor';
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
  // ✅ FIX: Use Map<URL, count> to track multiple requests to same URL
  private pendingRequests = new Map<string, number>();
  private completedRequests = new Map<string, number>();
  private page: Page;

  constructor(page: Page) {
    this.page = page;
    this.setupListeners();
  }

  private setupListeners() {
    // Track all requests
    this.page.on('request', (request) => {
      const url = request.url();
      // Filter: only track API requests (not static assets, not websockets, not long-polling)
      if (
        url.includes('/api/') ||
        url.includes('/graphql') ||
        url.includes('/rest/') ||
        (request.resourceType() === 'xhr' || request.resourceType() === 'fetch')
      ) {
        // Ignore websockets and long-polling patterns
        if (
          !url.includes('ws://') &&
          !url.includes('wss://') &&
          !url.includes('/poll') &&
          !url.includes('/stream') &&
          !url.includes('/events') &&
          !url.includes('/sse')
        ) {
          // ✅ FIX: Increment counter for this URL (supports duplicate requests)
          const currentCount = this.pendingRequests.get(url) || 0;
          this.pendingRequests.set(url, currentCount + 1);
          logger.debug('[PLAYWRIGHT] Tracking API request', {
            url: url.substring(0, 100),
            requestCount: currentCount + 1,
          });
        }
      }
    });

    // Track completed requests
    this.page.on('response', (response) => {
      const url = response.url();
      const pendingCount = this.pendingRequests.get(url);

      if (pendingCount !== undefined && pendingCount > 0) {
        // ✅ FIX: Decrement counter instead of deleting immediately
        const newCount = pendingCount - 1;

        if (newCount === 0) {
          // All requests to this URL completed
          this.pendingRequests.delete(url);
          const completedCount = this.completedRequests.get(url) || 0;
          this.completedRequests.set(url, completedCount + 1);
        } else {
          // Still have pending requests to this URL
          this.pendingRequests.set(url, newCount);
        }

        logger.debug('[PLAYWRIGHT] API request completed', {
          url: url.substring(0, 100),
          status: response.status(),
          remainingPending: newCount,
        });
      }
    });
  }

  async waitForCompletion(timeout: number = 15000): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 500; // Check every 500ms

    // ✅ FIX: Wait for all tracked requests to complete (using Map.size which counts all pending)
    while (this.pendingRequests.size > 0 && (Date.now() - startTime) < timeout) {
      await this.page.waitForTimeout(checkInterval);
    }

    const duration = Date.now() - startTime;

    // Calculate total completed requests
    const totalCompleted = Array.from(this.completedRequests.values()).reduce((sum, count) => sum + count, 0);

    if (this.pendingRequests.size > 0) {
      // Calculate total pending requests
      const totalPending = Array.from(this.pendingRequests.values()).reduce((sum, count) => sum + count, 0);

      logger.warn('[PLAYWRIGHT] Some API requests did not complete within timeout', {
        pendingUrlCount: this.pendingRequests.size, // Unique URLs
        pendingRequestCount: totalPending, // Total requests
        completedUrlCount: this.completedRequests.size,
        completedRequestCount: totalCompleted,
        duration: `${duration}ms`,
        pendingUrls: Array.from(this.pendingRequests.keys()).slice(0, 3).map(url => url.substring(0, 100)),
      });
    } else {
      logger.info('[PLAYWRIGHT] All important API requests completed', {
        completedUrlCount: this.completedRequests.size,
        completedRequestCount: totalCompleted,
        duration: `${duration}ms`,
      });
    }

    // Additional wait for DOM to render API data (common patterns)
    try {
      // Wait for common content indicators to appear
      await Promise.race([
        this.page.waitForSelector('[data-loaded], .content-loaded, [class*="list"], [class*="grid"]', { timeout: 3000 }).catch(() => null),
        this.page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => null),
        this.page.waitForTimeout(2000), // Fallback: wait 2 seconds for rendering
      ]);
    } catch (error) {
      // Continue anyway - data might already be rendered
      logger.debug('[PLAYWRIGHT] Content rendering wait completed or timed out');
    }
  }
}

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
    // INTELLIGENT MODE: Use IntelligentTestOrchestrator
    // ═══════════════════════════════════════════════════════════════════════
    if (testData.intelligentMode) {
      logger.info('[PLAYWRIGHT] Intelligent mode activated', {
        testId: testData.testId,
        goal: testData.testGoal || testData.intent || 'General testing',
        mode: 'balanced',
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

      // ✅ FIX: Wait for important API requests to complete
      await requestTracker.waitForCompletion(15000);

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

      // Emit progress: Page loaded (25%)
      webSocketService.emitTestProgress(testData.testId, {
        testId: testData.testId,
        browser: testData.browser,
        progress: 25,
        phase: 'initialization',
        currentStep: `✅ Page loaded: ${finalUrl}`,
        status: 'running',
        timestamp: new Date().toISOString(),
      });

      // Build intelligent test config
      const intelligentConfig: IntelligentTestConfig = {
        mode: 'balanced', // Use balanced mode by default
        safety: {
          ...DEFAULT_SAFETY_CONFIG,
          level: 'normal',
        },
        goal: testData.testGoal || testData.intent || 'Test the application',
        startUrl: testData.url,
        browser: testData.browser, // Add browser for progress tracking
        credentials: testData.options?.credentials,
        userContext: {
          projectId: testData.projectId,
          testId: testData.testId,
        },
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
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STANDARD MODE: Execute commands or legacy flow
    // ═══════════════════════════════════════════════════════════════════════

    // Setup result collectors
    collector.setupListeners(page);

    // Set timeout
    const timeout = testData.options?.timeout || 30000;
    page.setDefaultTimeout(timeout);

    // Execute Playwright commands if provided
    if (testData.commands && testData.commands.length > 0) {
      logger.info(`Executing ${testData.commands.length} Playwright commands`, {
        testId: testData.testId,
        commandCount: testData.commands.length,
      });

      const executor = new CommandExecutor(page);
      const commandResults = await executor.executeCommands(testData.commands);

      if (!commandResults.success) {
        logger.warn('Some commands failed during execution', {
          failedCount: commandResults.errors.length,
          errors: commandResults.errors,
        });

        // Add command errors to collector
        for (const { error } of commandResults.errors) {
          collector.errors.push({
            type: 'other',
            message: `Command execution error: ${error}`,
            timestamp: new Date(),
          });
        }
      } else {
        logger.info('All commands executed successfully', {
          successCount: commandResults.results.length,
        });
      }
    } else {
      // Legacy flow: Navigate to URL if no commands provided
      logger.info('No commands provided, using legacy navigation flow');
      logger.info('Navigating to URL', { url: testData.url });
      await page.goto(testData.url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });

      // Wait for selector if specified
      if (testData.options?.waitForSelector) {
        logger.info('Waiting for selector', { selector: testData.options.waitForSelector });
        await page.waitForSelector(testData.options.waitForSelector, { timeout });
      } else {
        // Default wait for network idle
        await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 10000) });
      }

      // Execute custom scripts if provided
      if (testData.options?.customScripts && testData.options.customScripts.length > 0) {
        for (const script of testData.options.customScripts) {
          try {
            logger.info('Executing custom script');
            await page.evaluate(script);
          } catch (scriptError) {
            logger.warn('Custom script failed', { error: scriptError });
            collector.errors.push({
              type: 'other',
              message: `Custom script failed: ${scriptError instanceof Error ? scriptError.message : 'Unknown'}`,
              timestamp: new Date(),
            });
          }
        }
      }

      // Small delay to let page settle
      await page.waitForTimeout(1000);
    }

    // Collect results
    const results = await collector.collect(page, true);

    // ✅ NEW: Stop tracing before closing
    if (context && tracePath) {
      try {
        await context.tracing.stop({ path: tracePath });
        logger.info('[PLAYWRIGHT] Trace saved', { tracePath });
      } catch (traceError) {
        logger.warn('[PLAYWRIGHT] Failed to stop tracing', { error: traceError });
      }
    }

    // ✅ NEW: Get video path before closing page
    if (page) {
      try {
        const video = page.video();
        await page.close();

        if (video) {
          videoPath = await video.path();
          logger.info('[PLAYWRIGHT] Video saved', { videoPath });
        }
      } catch (pageError) {
        logger.warn('[PLAYWRIGHT] Failed to close page', { error: pageError });
      }
    }

    // Close context
    if (context) {
      try {
        await context.close();
      } catch (contextError) {
        logger.warn('[PLAYWRIGHT] Failed to close context', { error: contextError });
      }
    }

    // ✅ NEW: Upload video & trace to Supabase Storage
    let videoUrl: string | undefined;
    let traceUrl: string | undefined;

    try {
      const { uploadVideoToStorage, uploadTraceToStorage } = await import('@/services/storage/test-artifacts-storage.service');

      if (videoPath) {
        videoUrl = await uploadVideoToStorage(videoPath, testData.testId, testData.userId || 'anonymous');
        logger.info('[PLAYWRIGHT] Video uploaded to storage', { videoUrl });
      }

      if (tracePath) {
        traceUrl = await uploadTraceToStorage(tracePath, testData.testId, testData.userId || 'anonymous');
        logger.info('[PLAYWRIGHT] Trace uploaded to storage', { traceUrl });
      }
    } catch (uploadError) {
      logger.error('[PLAYWRIGHT] Failed to upload artifacts', {
        error: uploadError instanceof Error ? uploadError.message : String(uploadError),
      });
      // Don't fail the test if upload fails
    }

    logger.info('Playwright test completed successfully', {
      testId: testData.testId,
      browser: testData.browser,
      logsCount: results.logs.length,
      networkLogsCount: results.networkLogs.length,
      errorsCount: results.errors.length,
      hasVideo: !!videoUrl,
      hasTrace: !!traceUrl,
    });

    return {
      success: true,
      status: 'completed',
      screenshot: results.screenshot,
      dom: results.dom,
      logs: results.logs,
      networkLogs: results.networkLogs,
      errors: results.errors,
      performance: results.performance,
      // ✅ NEW: Return video & trace paths/URLs
      videoUrl,
      videoPath,
      traceUrl,
      tracePath,
    };
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

    // Try to collect partial results and cleanup
    let partialResults = null;
    if (page) {
      try {
        partialResults = await collector.collect(page, true);
        await page.close();
      } catch (cleanupError) {
        logger.error('Failed to collect partial results', { error: cleanupError });
      }
    }

    // Cleanup context if it exists
    if (context) {
      try {
        // Stop tracing if it was started
        if (tracePath) {
          await context.tracing.stop({ path: tracePath }).catch(() => {
            // Ignore errors when stopping trace in error scenario
          });
        }
        await context.close();
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
            totalAttempts: attempt + 1,
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
