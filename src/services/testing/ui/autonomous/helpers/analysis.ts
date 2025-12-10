import { analyzeScreenshotWithVision } from '@/services/ai/vision-analyzer.service';
import { analyzeDOMStructure } from '@/services/testing/ui/autonomous/dom-analyzer.service';
import { logger } from '@/utils/logger';
import { Page } from 'playwright';
import { emitExplorationProgress } from './progress';

/**
 * Get page metadata (title, URL)
 * ✅ SIMPLIFIED: Removed unreliable hasAuth detection (auth is handled via needsAuth parameter)
 */
export async function getPageMetadata(page: Page, fallbackUrl: string): Promise<{
  title: string;
  url: string;
  hasAuth: boolean; // Kept for backward compatibility, always false (auth handled separately)
}> {
  try {
    const pageInfo = await page.evaluate(() => {
      return {
        // @ts-expect-error - browser context
        title: document.title || 'Unknown',
        // @ts-expect-error
        url: window.location.href,
      };
    });

    return {
      ...pageInfo,
      hasAuth: false, // Auth is handled via needsAuth parameter in exploreProduct
    };
  } catch (evalError) {
    logger.warn('Failed to evaluate page info, using defaults', {
      error: evalError instanceof Error ? evalError.message : String(evalError),
    });

    return {
      title: 'Unknown',
      url: fallbackUrl,
      hasAuth: false,
    };
  }
}

/**
 * Analyze page with Vision AI and DOM analysis (parallel)
 */
export async function analyzePageWithAI(
  page: Page,
  screenshotBase64: string,
  scope: string,
  url: string,
  sessionId?: string
): Promise<{
  visualAnalysis: any;
  domAnalysis: any;
}> {
  logger.info('Analyzing screenshot with GPT-4o Vision');
  emitExplorationProgress(sessionId, '🤖 Analyzing screenshot with GPT-4o Vision...');

  const visualAnalysisPromise = analyzeScreenshotWithVision(screenshotBase64, { scope, url });

  logger.info('Analyzing DOM structure');
  emitExplorationProgress(sessionId, '🔍 Analyzing DOM structure...');

  const domAnalysisPromise = analyzeDOMStructure(page);

  // Timeout: 30 seconds
  const ANALYSIS_TIMEOUT = 30000;
  let visualResult, domResult;

  try {
    [visualResult, domResult] = await Promise.race([
      Promise.allSettled([visualAnalysisPromise, domAnalysisPromise]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Analysis timeout after 30s')), ANALYSIS_TIMEOUT)
      ),
    ]);
  } catch (timeoutError) {
    logger.error('Analysis timed out, using fallback data', {
      error: timeoutError instanceof Error ? timeoutError.message : String(timeoutError),
    });

    visualResult = { status: 'rejected' as const, reason: 'Timeout' };
    domResult = { status: 'rejected' as const, reason: 'Timeout' };
  }

  // Extract results with fallbacks
  const visualAnalysis = visualResult.status === 'fulfilled'
    ? visualResult.value
    : {
        elements: [],
        layout: 'unknown',
        suggestions: [],
      };

  const domAnalysis = domResult.status === 'fulfilled'
    ? domResult.value
    : {
        forms: [],
        buttons: [],
        links: [],
        inputs: [],
      };

  if (visualResult.status === 'rejected') {
    logger.warn('Visual analysis failed', { error: visualResult.reason });
  }
  if (domResult.status === 'rejected') {
    logger.warn('DOM analysis failed', { error: domResult.reason });
  }

  return { visualAnalysis, domAnalysis };
}
