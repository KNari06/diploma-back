import { Browser, chromium, firefox, webkit } from 'playwright';
import { logger } from '@/utils/logger';
import { BrowserType } from '@/types';

/**
 * Browser pool manager for reusing browser instances
 */
class BrowserPool {
  private browsers: Map<BrowserType, Browser> = new Map();
  private initialized = false;

  /**
   * Get or create browser instance
   */
  async getBrowser(browserType: BrowserType): Promise<Browser> {
    // Map browser types to Playwright browsers
    const browserMap: Record<string, typeof chromium | typeof firefox | typeof webkit> = {
      'chrome': chromium,
      'chromium': chromium,
      'edge': chromium,
      'mobile-chrome': chromium,
      'firefox': firefox,
      'safari': webkit,
      'webkit': webkit,
      'mobile-safari': webkit,
    };

    const playwrightBrowser = browserMap[browserType] || chromium;

    // Check if browser already exists and is connected
    if (this.browsers.has(browserType)) {
      const browser = this.browsers.get(browserType)!;
      if (browser.isConnected()) {
        logger.debug('Reusing existing browser instance', { browserType });
        return browser;
      } else {
        // Browser disconnected, remove from pool
        this.browsers.delete(browserType);
      }
    }

    // Launch new browser
    logger.info('Launching new browser instance', { browserType });
    const browser = await playwrightBrowser.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    this.browsers.set(browserType, browser);
    return browser;
  }

  /**
   * Close all browsers
   */
  async closeAll(): Promise<void> {
    logger.info('Closing all browsers', { count: this.browsers.size });

    for (const [browserType, browser] of this.browsers.entries()) {
      try {
        if (browser.isConnected()) {
          await browser.close();
          logger.debug('Browser closed', { browserType });
        }
      } catch (error) {
        logger.error('Failed to close browser', { browserType, error });
      }
    }

    this.browsers.clear();
    this.initialized = false;
  }

  /**
   * Close specific browser
   */
  async closeBrowser(browserType: BrowserType): Promise<void> {
    const browser = this.browsers.get(browserType);
    if (browser) {
      try {
        if (browser.isConnected()) {
          await browser.close();
          logger.debug('Browser closed', { browserType });
        }
      } catch (error) {
        logger.error('Failed to close browser', { browserType, error });
      }
      this.browsers.delete(browserType);
    }
  }

  /**
   * Health check for browser pool
   */
  getStatus(): { total: number; connected: number; browsers: string[] } {
    const connected = Array.from(this.browsers.entries())
      .filter(([, browser]) => browser.isConnected())
      .map(([type]) => type);

    return {
      total: this.browsers.size,
      connected: connected.length,
      browsers: connected,
    };
  }
}

// Singleton instance
export const browserPool = new BrowserPool();

// Cleanup on process termination
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing browsers...');
  await browserPool.closeAll();
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing browsers...');
  await browserPool.closeAll();
});
