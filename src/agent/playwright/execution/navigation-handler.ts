import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { Page } from 'playwright';
import { RequestTracker } from './request-tracker';

/**
 * Navigate to URL with anti-bot detection and validation
 */
export async function navigateToUrl(
  page: Page,
  testData: TestJobData,
  requestTracker: RequestTracker
): Promise<void> {
  // Stealth script is now applied at context level via setupBrowserContext / applyStealthScript.
  // No per-page injection needed — context.addInitScript auto-applies to all pages.

  logger.info('[PLAYWRIGHT] Starting navigation', {
    testId: testData.testId,
    targetUrl: testData.url,
  });

  // Try navigation with different wait strategies
  // Use 'load' to ensure JS hydration completes (SPA frameworks like Framer, React, Next.js)
  let navigationResponse = null;
  let usedWaitStrategy: 'load' | 'domcontentloaded' | 'networkidle' = 'load';
  const navStartMs = Date.now();
  try {
    navigationResponse = await page.goto(testData.url, {
      waitUntil: 'load',
      timeout: 45000,
    });
  } catch (timeoutError) {
    usedWaitStrategy = 'domcontentloaded';
    logger.warn('[PLAYWRIGHT] Navigation with load timed out, trying domcontentloaded', {
      testId: testData.testId,
      elapsedMs: Date.now() - navStartMs,
    });
    try {
      navigationResponse = await page.goto(testData.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (timeoutError2) {
      usedWaitStrategy = 'networkidle';
      logger.warn('[PLAYWRIGHT] Navigation with domcontentloaded timed out, trying networkidle', {
        testId: testData.testId,
        elapsedMs: Date.now() - navStartMs,
      });
      navigationResponse = await page.goto(testData.url, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    }
  }
  const navDurationMs = Date.now() - navStartMs;

  logger.info('[PLAYWRIGHT] Initial page load complete', {
    testId: testData.testId,
    waitStrategy: usedWaitStrategy,
    navDurationMs,
    url: testData.url,
  });

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

  // ✅ FIX: Wait for important API requests to complete (network idle heuristic)
  await requestTracker.waitForNetworkIdle(15000);

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

  logger.debug('[PLAYWRIGHT] Page loaded', {
    testId: testData.testId,
    browser: testData.browser,
    url: finalUrl,
  });
}
