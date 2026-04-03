import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { BROWSER_USER_AGENT, BROWSER_EXTRA_HEADERS, BROWSER_STEALTH_SCRIPT } from '@/config/testing/playwright-tuning';
import { webSocketService } from '@/websocket/core/websocket.service';
import { getActionIcon } from '@/websocket/types/types';
import { Browser, BrowserContext, BrowserContextOptions, devices } from 'playwright';
import { browserPool } from '../../browser/browser-pool';

/**
 * Setup browser context with all necessary options
 */
export async function setupBrowserContext(
  testData: TestJobData,
  browser: Browser,
  options?: { disableVideo?: boolean; disableTracing?: boolean }
): Promise<{ context: BrowserContext; tracePath: string | undefined }> {
  // ✅ FIX: Prepare video & trace directories
  const fs = await import('fs/promises');
  const path = await import('path');

  const videosDir = path.join(process.cwd(), 'test-results', 'videos');
  const tracesDir = path.join(process.cwd(), 'test-results', 'traces');

  await fs.mkdir(videosDir, { recursive: true });
  await fs.mkdir(tracesDir, { recursive: true });

  // Create context with options
  const contextOptions: BrowserContextOptions = {
    viewport: testData.options?.viewport
      ? {
          width: testData.options.viewport.width || 1920,
          height: testData.options.viewport.height || 1080
        }
      : { width: 1920, height: 1080 },
    userAgent: testData.options?.headers?.['User-Agent'] || BROWSER_USER_AGENT,
    extraHTTPHeaders: { ...BROWSER_EXTRA_HEADERS },
    // Video recording (disabled for initial replay attempts to save resources)
    ...(options?.disableVideo ? {} : {
      recordVideo: {
        dir: videosDir,
        size: { width: 1920, height: 1080 },
      },
    }),
    locale: 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    ignoreHTTPSErrors: false,
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

  const context = await browser.newContext(contextOptions);

  // Apply stealth patches (hides headless/automation markers from bot detectors)
  await context.addInitScript(BROWSER_STEALTH_SCRIPT);

  // ✅ Start tracing (skip on initial replay attempts to save RAM)
  let tracePath: string | undefined;
  if (!options?.disableTracing) {
    tracePath = path.join(tracesDir, `trace-${testData.testId}-${Date.now()}.zip`);
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
  }

  logger.info('[PLAYWRIGHT] Browser context created', {
    testId: testData.testId,
    videoEnabled: !options?.disableVideo,
    tracingEnabled: !options?.disableTracing,
    tracePath: tracePath || 'disabled',
  });

  return { context, tracePath };
}

/**
 * Get browser from pool and emit progress
 */
export async function getBrowserWithProgress(testData: TestJobData): Promise<Browser> {
  // Emit progress: Browser launching (10%)
  try {
    webSocketService.emitTestProgress(testData.testId, {
      testId: testData.testId,
      browser: testData.browser,
      progress: 10,
      phase: 'initialization',
      currentStep: '🌐 Launching browser...',
      icon: getActionIcon(undefined, 'initialization'),
      status: 'running',
      timestamp: new Date().toISOString(),
      userId: testData.userId,
      sessionId: testData.chatSessionId, // Chat session for routing isolation
    });
  } catch (wsError) {
    // Non-critical: WebSocket errors shouldn't break test execution
    logger.debug('[BROWSER_SETUP] Failed to emit progress (launching)', {
      testId: testData.testId,
      error: wsError instanceof Error ? wsError.message : String(wsError),
    });
  }

  let browser: Browser;
  try {
    // Get browser from pool
    browser = await browserPool.getBrowser(testData.browser);

    // ✅ FIX: Validate browser was obtained
    if (!browser) {
      throw new Error(`Failed to get browser: browserPool.getBrowser returned null/undefined for ${testData.browser}`);
    }

    logger.info('[BROWSER_SETUP] Browser obtained from pool', {
      testId: testData.testId,
      browser: testData.browser,
      isConnected: browser.isConnected(),
    });

    // Emit progress: Browser ready (15%)
    try {
      webSocketService.emitTestProgress(testData.testId, {
        testId: testData.testId,
        browser: testData.browser,
        progress: 15,
        phase: 'initialization',
        currentStep: '✅ Browser ready',
        icon: getActionIcon(undefined, 'initialization'),
        status: 'running',
        timestamp: new Date().toISOString(),
        userId: testData.userId,
        sessionId: testData.chatSessionId, // Chat session for routing isolation
      });
    } catch (wsError) {
      // Non-critical: WebSocket errors shouldn't break test execution
      logger.debug('[BROWSER_SETUP] Failed to emit progress (ready)', {
        testId: testData.testId,
        error: wsError instanceof Error ? wsError.message : String(wsError),
      });
    }

    return browser;
  } catch (error) {
    // ✅ FIX: Emit error progress if browser acquisition failed
    try {
      webSocketService.emitTestProgress(testData.testId, {
        testId: testData.testId,
        browser: testData.browser,
        progress: 10, // Keep at 10% since we failed
        phase: 'initialization',
        currentStep: `❌ Failed to launch browser: ${error instanceof Error ? error.message : 'Unknown error'}`,
        icon: getActionIcon(undefined, 'initialization'),
        status: 'failed',
        timestamp: new Date().toISOString(),
        userId: testData.userId,
        sessionId: testData.chatSessionId, // Chat session for routing isolation
      });
    } catch (wsError) {
      // Ignore WebSocket errors during error handling
      logger.debug('[BROWSER_SETUP] Failed to emit error progress', {
        testId: testData.testId,
        error: wsError instanceof Error ? wsError.message : String(wsError),
      });
    }

    logger.error('[BROWSER_SETUP] Failed to get browser from pool', {
      testId: testData.testId,
      browser: testData.browser,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack,
      } : String(error),
    });

    throw error; // Re-throw to let caller handle
  }
}
