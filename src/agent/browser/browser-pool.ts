import { BrowserType } from '@/types';
import { logger } from '@/utils/core/logger';
import { BROWSER_LAUNCH_ARGS, BROWSER_HEADLESS_MODE } from '@/config/testing/playwright-tuning';
import { Browser, chromium, firefox, webkit } from 'playwright';

const RECYCLE_AFTER_CONTEXTS = Number(process.env.PLAYWRIGHT_BROWSER_RECYCLE_AFTER) || 150;

/**
 * Browser pool manager for reusing browser instances
 */
class BrowserPool {
  private browsers: Map<BrowserType, Browser> = new Map();
  /** Tracks how many times each browser has been handed out (≈ contexts created) */
  private useCounts: Map<BrowserType, number> = new Map();

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
        // Recycle if the browser has served enough runs AND has no live contexts.
        // Chromium accumulates memory per-context over time (playwright#21079);
        // restarting the browser between idle windows releases it.
        const uses = this.useCounts.get(browserType) || 0;
        if (uses >= RECYCLE_AFTER_CONTEXTS && browser.contexts().length === 0) {
          logger.info('Recycling browser instance after threshold', {
            browserType,
            uses,
            threshold: RECYCLE_AFTER_CONTEXTS,
          });
          try {
            await browser.close();
          } catch (err) {
            logger.warn('Failed to close browser during recycle', {
              browserType,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          this.browsers.delete(browserType);
          this.useCounts.delete(browserType);
        } else {
          logger.debug('Reusing existing browser instance', { browserType, uses });
          this.useCounts.set(browserType, uses + 1);
          return browser;
        }
      } else {
        // Browser disconnected, remove from pool
        this.browsers.delete(browserType);
        this.useCounts.delete(browserType);
      }
    }

    // Launch new browser
    logger.info('Launching new browser instance', { browserType });

    const browser = await playwrightBrowser.launch({
      headless: BROWSER_HEADLESS_MODE,
      args: [...BROWSER_LAUNCH_ARGS],
    });

    this.browsers.set(browserType, browser);
    this.useCounts.set(browserType, 1);
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
    this.useCounts.clear();
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
      this.useCounts.delete(browserType);
    }
  }

  /**
   * Get total context count across all browsers
   */
  getTotalContextCount(): number {
    let total = 0;
    for (const [, browser] of this.browsers) {
      if (browser.isConnected()) {
        total += browser.contexts().length;
      }
    }
    return total;
  }

  /**
   * Health check for browser pool
   */
  getStatus(): { total: number; connected: number; browsers: string[]; contexts: number } {
    const connected = Array.from(this.browsers.entries())
      .filter(([, browser]) => browser.isConnected())
      .map(([type]) => type);

    return {
      total: this.browsers.size,
      connected: connected.length,
      browsers: connected,
      contexts: this.getTotalContextCount(),
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
