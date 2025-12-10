import { browserPool } from '@/agent';
import { logger } from '@/utils/logger';
import { Page } from 'playwright';
import { emitExplorationProgress } from './progress';

/**
 * Setup browser and create page
 */
export async function setupBrowserAndPage(sessionId?: string): Promise<{ page: Page; context: any }> {
  emitExplorationProgress(sessionId, '🌐 Connecting to browser...');
  const browser = await browserPool.getBrowser('chrome');
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  const page = await context.newPage();

  if (!page) {
    throw new Error('Failed to create page');
  }

  return { page, context };
}

/**
 * Cleanup browser resources
 */
export async function cleanupBrowserResources(page: Page | null, context: any): Promise<void> {
  try {
    if (page) await page.close();
    if (context) await context.close();
  } catch (cleanupError) {
    logger.warn('Failed to cleanup page/context', {
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}
