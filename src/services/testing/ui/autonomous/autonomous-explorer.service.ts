import { logger } from '@/utils/core/logger';
import { Page } from 'playwright';
import { analyzePageWithAI, getPageMetadata } from './helpers/analysis';
import { performAuthentication } from './helpers/auth';
import { cleanupBrowserResources, setupBrowserAndPage } from './helpers/browser';
import { attemptAIGuidedNavigation, navigateToInitialPage } from './helpers/navigation';
import { emitExplorationProgress } from './helpers/progress';
import { generateTestRecommendations } from './helpers/recommendations';
import { captureAndProcessScreenshot } from './helpers/screenshot';

/**
 * Product exploration result
 */
export interface ExplorationResult {
  url: string;
  originalUrl?: string; // ✅ NEW: Track base URL if navigation occurred
  timestamp: string;
  screenshot: string; // base64
  visualAnalysis: {
    elements: Array<{
      type: string;
      purpose: string;
      location: string;
      required?: boolean;
    }>;
    layout: string;
    suggestions: string[];
  };
  domAnalysis: {
    forms: Array<{
      id?: string;
      action?: string;
      method?: string;
      fields: Array<{
        name: string;
        type: string;
        required: boolean;
        selector: string;
        placeholder?: string;
      }>;
    }>;
    buttons: Array<{
      text: string;
      selector: string;
      type: string;
    }>;
    links: Array<{
      text: string;
      href: string;
      selector: string;
    }>;
    inputs: Array<{
      type: string;
      name?: string;
      placeholder?: string;
      selector: string;
      required: boolean;
    }>;
  };
  pageInfo: {
    title: string;
    url: string;
    hasAuth: boolean;
  };
  recommendations: string[];
  /** Visible text content of the page (up to 5k chars) */
  pageText?: string;
}

// Re-export NavigationRequiresClarificationError for external use
export { NavigationRequiresClarificationError } from './helpers/navigation';

/**
 * Autonomously explore a product page
 * ✅ REFACTORED: Split into smaller, readable helper functions
 * ✅ ENHANCED: Fixed memory leaks, timeouts, and error handling
 * ✅ NEW: AI-powered dynamic navigation to find target pages
 */
export async function exploreProduct(options: {
  url: string;
  scope: string;
  credentials?: {
    email?: string;
    username?: string;
    password: string;
  };
  needsAuth?: boolean;
  sessionId?: string;
  userMessage?: string;
}): Promise<ExplorationResult> {
  const { url, scope, credentials, needsAuth, sessionId, userMessage } = options;

  logger.info('Starting autonomous product exploration', {
    url,
    scope,
    needsAuth,
    hasSessionId: !!sessionId,
  });

  let page: Page | null = null;
  let context: any = null;

  try {
    // 1. Setup browser and page
    const browserSetup = await setupBrowserAndPage(sessionId);
    page = browserSetup.page;
    context = browserSetup.context;

    // 2. Handle authentication if needed
    if (needsAuth && credentials) {
      logger.info('Performing authentication before exploration');
      emitExplorationProgress(sessionId, '🔐 Performing authentication...');
      await performAuthentication(page, url, credentials);
    }

    // 3. Navigate to initial URL
    await navigateToInitialPage(page, url, sessionId);

    // 4. Attempt AI-guided navigation (if userMessage provided)
    let originalUrl: string | undefined;
    let finalUrl = url;

    if (userMessage) {
      const navigation = await attemptAIGuidedNavigation(page, context, url, userMessage, sessionId);
      originalUrl = navigation.originalUrl;
      finalUrl = navigation.finalUrl;
    }

    // 5. Capture and process screenshot
    const screenshotBase64 = await captureAndProcessScreenshot(page, sessionId);

    // 6. Get page metadata
    const pageInfo = await getPageMetadata(page, finalUrl);

    // 7. Analyze page with AI (Vision + DOM in parallel)
    const { visualAnalysis, domAnalysis } = await analyzePageWithAI(
      page,
      screenshotBase64,
      scope,
      finalUrl,
      sessionId
    );

    // 8. Generate recommendations
    const recommendations = await generateTestRecommendations(
      visualAnalysis,
      domAnalysis,
      scope,
      finalUrl,
      pageInfo.title
    );

    // 8.5. Extract visible page text for AI context (up to 5k chars)
    let pageText: string | undefined;
    try {
      pageText = await page.evaluate(() => {
        // @ts-expect-error - document available in browser context
        const text = document.body?.innerText || '';
        return text.trim().slice(0, 5000);
      });
    } catch {
      // Page may be closed or navigating, ignore
    }

    // 9. Cleanup
    await cleanupBrowserResources(page, context);

    // 10. Build and return result
    const result: ExplorationResult = {
      url: finalUrl,
      originalUrl,
      timestamp: new Date().toISOString(),
      screenshot: `data:image/png;base64,${screenshotBase64}`,
      visualAnalysis,
      domAnalysis,
      pageInfo,
      recommendations,
      pageText,
    };

    logger.info('Product exploration completed successfully', {
      finalUrl,
      originalUrl,
      formsFound: domAnalysis.forms.length,
      buttonsFound: domAnalysis.buttons.length,
      recommendationsCount: recommendations.length,
    });

    return result;
  } catch (error) {
    logger.error('Product exploration failed', { error, url });

    // Always cleanup browser resources on error
    await cleanupBrowserResources(page, context);

    throw error;
  }
}
