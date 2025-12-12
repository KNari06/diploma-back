import { TestJobData } from '@/types';
import { logger } from '@/utils/logger';
import { webSocketService } from '@/websocket/websocket.service';
import { getActionIcon } from '@/websocket/types';
import { Browser, BrowserContext, BrowserContextOptions, devices } from 'playwright';
import { browserPool } from '../browser-pool';

/**
 * Setup browser context with all necessary options
 */
export async function setupBrowserContext(
  testData: TestJobData,
  browser: Browser
): Promise<{ context: BrowserContext; tracePath: string }> {
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

  const context = await browser.newContext(contextOptions);

  // ✅ NEW: Start tracing
  const tracePath = path.join(tracesDir, `trace-${testData.testId}-${Date.now()}.zip`);
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
      userId: testData.userId, // ✅ FIX: Include userId for user room broadcast
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
        userId: testData.userId, // ✅ FIX: Include userId for user room broadcast
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
        // Align with client expectations: 'queued' | 'running' | 'completed' | 'failed'
        status: 'failed',
        timestamp: new Date().toISOString(),
        userId: testData.userId,
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
