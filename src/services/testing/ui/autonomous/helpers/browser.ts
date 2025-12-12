import { browserPool } from '@/agent';
import { logger } from '@/utils/logger';
import { BrowserContext, Page } from 'playwright';
import { emitExplorationProgress } from './progress';

/**
 * Get user's timezone
 * ✅ NEW: Detects system timezone or uses environment variable
 * Priority: process.env.TZ > Intl.DateTimeFormat > fallback
 */
function getUserTimezone(): string {
  // 1. Check environment variable (highest priority)
  if (process.env.TZ) {
    logger.debug('Using timezone from TZ environment variable', { timezone: process.env.TZ });
    return process.env.TZ;
  }

  // 2. Try to detect system timezone using Intl API
  try {
    const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (systemTimezone) {
      logger.debug('Detected system timezone', { timezone: systemTimezone });
      return systemTimezone;
    }
  } catch (error) {
    logger.debug('Failed to detect system timezone using Intl API', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 3. Fallback to default (if detection fails)
  const fallbackTimezone = 'America/New_York';
  logger.debug('Using fallback timezone', { timezone: fallbackTimezone });
  return fallbackTimezone;
}

/**
 * Setup browser and create page
 * ✅ FIXED: Added proper error handling, type safety, and browser configuration
 */
export async function setupBrowserAndPage(sessionId?: string): Promise<{ page: Page; context: BrowserContext }> {
  try {
    emitExplorationProgress(sessionId, '🌐 Connecting to browser...');

    // ✅ FIX: Get browser with error handling
    const browser = await browserPool.getBrowser('chrome');
    if (!browser) {
      throw new Error('Failed to get browser instance from pool');
    }

    // ✅ FIX: Complete user agent string (matches playwright.service.ts)
    const defaultUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    // ✅ NEW: Get user's timezone (system or from env)
    const userTimezone = getUserTimezone();

    // ✅ FIX: Enhanced context options to look like real browser
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: defaultUserAgent,
      // ✅ NEW: Add extra HTTP headers to look like real browser
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
      // ✅ NEW: Set locale and timezone to match user's system
      locale: 'en-US',
      timezoneId: userTimezone, // ✅ FIX: Uses user's timezone instead of hardcoded
      // ✅ NEW: Ignore HTTPS errors (in case of SSL issues)
      ignoreHTTPSErrors: false, // Keep false for security, but can enable if needed
    });

    if (!context) {
      throw new Error('Failed to create browser context');
    }

    // ✅ FIX: Create page with error handling
    const page = await context.newPage();
    if (!page) {
      throw new Error('Failed to create page');
    }

    // ✅ NEW: Set default timeouts for page
    page.setDefaultTimeout(30000); // 30 seconds
    page.setDefaultNavigationTimeout(30000); // 30 seconds

    logger.info('Browser and page setup completed', {
      viewport: { width: 1920, height: 1080 },
      userAgent: defaultUserAgent,
      timezone: userTimezone, // ✅ NEW: Log timezone being used
    });

    return { page, context };
  } catch (error) {
    logger.error('Failed to setup browser and page', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Cleanup browser resources
 * ✅ FIXED: Added proper checks for closed state and better error handling
 */
export async function cleanupBrowserResources(page: Page | null, context: BrowserContext | null): Promise<void> {
  try {
    // ✅ FIX: Check if page is already closed before attempting to close
    if (page && !page.isClosed()) {
      await page.close();
      logger.debug('Page closed successfully');
    } else if (page) {
      logger.debug('Page was already closed, skipping');
    }

    // ✅ FIX: Check if context is already closed before attempting to close
    if (context) {
      // BrowserContext doesn't have isClosed() method, but we can catch the error
      try {
        await context.close();
        logger.debug('Browser context closed successfully');
      } catch (closeError) {
        // Context might already be closed, which is fine
        if (closeError instanceof Error && closeError.message.includes('closed')) {
          logger.debug('Browser context was already closed, skipping');
        } else {
          throw closeError; // Re-throw if it's a different error
        }
      }
    }
  } catch (cleanupError) {
    logger.warn('Failed to cleanup page/context', {
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      pageClosed: page?.isClosed() ?? 'N/A',
    });
    // ✅ NOTE: Don't throw - cleanup errors shouldn't break the flow
  }
}
