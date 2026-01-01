import { analyzeScreenshotWithVision } from '@/services/ai/analysis/vision-analyzer.service';
import { analyzeDOMStructure } from '@/services/testing/ui/autonomous/dom-analyzer.service';
import { logger } from '@/utils/core/logger';
import * as fs from 'fs';
import * as path from 'path';
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

  // ✅ FIX: Initialize with default rejected state to ensure type safety
  let visualResult: PromiseSettledResult<any> = { status: 'rejected' as const, reason: 'Not started' };
  let domResult: PromiseSettledResult<any> = { status: 'rejected' as const, reason: 'Not started' };

  try {
    // ✅ IMPROVED: Use Promise.race to handle timeout
    // Promise.allSettled always resolves (never rejects), so we race it with timeout
    const raceResult = await Promise.race([
      Promise.allSettled([visualAnalysisPromise, domAnalysisPromise]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Analysis timeout after 30s')), ANALYSIS_TIMEOUT)
      ),
    ]);

    // ✅ FIX: Type guard to ensure raceResult is an array (from Promise.allSettled)
    if (Array.isArray(raceResult) && raceResult.length === 2) {
      [visualResult, domResult] = raceResult;
    } else {
      // This should never happen, but handle it gracefully
      logger.error('Unexpected result from Promise.race', { raceResult });
      visualResult = { status: 'rejected' as const, reason: 'Unexpected result format' };
      domResult = { status: 'rejected' as const, reason: 'Unexpected result format' };
    }
  } catch (timeoutError) {
    // ✅ FIX: Timeout occurred - both analyses are still running in background
    // We mark them as rejected, but they continue executing (no way to cancel)
    logger.error('Analysis timed out, using fallback data', {
      error: timeoutError instanceof Error ? timeoutError.message : String(timeoutError),
      note: 'Analyses continue running in background but results are ignored',
    });

    visualResult = { status: 'rejected' as const, reason: 'Timeout' };
    domResult = { status: 'rejected' as const, reason: 'Timeout' };

    // ✅ NOTE: Promises continue executing in background - this is acceptable
    // because they don't block and will eventually complete
    // In production, you might want to add AbortController for cancellation
  }

  // Extract results with fallbacks
  const visualAnalysis = visualResult.status === 'fulfilled'
    ? visualResult.value
    : {
        elements: [],
        layout: 'unknown',
        suggestions: [],
        pageType: 'unknown',
        description: 'Vision analysis failed',
        warnings: ['Vision analysis failed'],
        modals: [],
      };

  const domAnalysis = domResult.status === 'fulfilled'
    ? domResult.value
    : {
        // ✅ FIX: Complete fallback structure matching DOMAnalysisResult interface
        forms: [],
        buttons: [],
        links: [],
        inputs: [],
        checkboxes: undefined,
        radios: undefined,
        interactiveElements: undefined,
        hiddenInteractive: undefined,
      };

  // ✅ IMPROVED: Log analysis status with clear indication of partial success
  const visualSuccess = visualResult.status === 'fulfilled';
  const domSuccess = domResult.status === 'fulfilled';

  if (!visualSuccess) {
    const visualError = visualResult.status === 'rejected' ? visualResult.reason : 'Unknown error';
    logger.warn('Visual analysis failed', {
      error: visualError,
      note: 'Using fallback empty structure. DOM analysis will be used if available.',
    });
  }
  if (!domSuccess) {
    const domError = domResult.status === 'rejected' ? domResult.reason : 'Unknown error';
    logger.warn('DOM analysis failed', {
      error: domError,
      note: 'Using fallback empty structure. Visual analysis will be used if available.',
    });
  }

  // ✅ IMPROVED: Log summary with success status
  if (!visualSuccess && !domSuccess) {
    const visualError = visualResult.status === 'rejected' ? visualResult.reason : 'Unknown error';
    const domError = domResult.status === 'rejected' ? domResult.reason : 'Unknown error';
    logger.error('Both analyses failed - using fallback data for both', {
      visualError,
      domError,
      impact: 'Recommendations will be limited due to missing analysis data',
    });
  } else if (!visualSuccess || !domSuccess) {
    logger.warn('Partial analysis success - one analysis failed', {
      visualSuccess,
      domSuccess,
      impact: 'Recommendations may be less accurate due to missing data',
    });
  }

  // ✅ DEBUG: Log DOM analysis results for inspection
  logger.info('DOM analysis completed', {
    success: domSuccess,
    formsCount: domAnalysis.forms?.length || 0,
    buttonsCount: domAnalysis.buttons?.length || 0,
    linksCount: domAnalysis.links?.length || 0,
    inputsCount: domAnalysis.inputs?.length || 0,
    checkboxesCount: domAnalysis.checkboxes?.length || 0,
    radiosCount: domAnalysis.radios?.length || 0,
    interactiveElementsCount: domAnalysis.interactiveElements?.length || 0,
    hiddenInteractiveCount: domAnalysis.hiddenInteractive?.length || 0,
    // ✅ DEBUG: Log full structure in debug mode (can be toggled via env var)
    fullStructure: process.env.DEBUG_DOM_ANALYSIS === 'true' ? domAnalysis : undefined,
  });

  // ✅ DEBUG: Save DOM analysis to file if enabled (for detailed inspection)
  if (process.env.SAVE_DOM_ANALYSIS === 'true') {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `dom-analysis-${timestamp}.json`;
      const filepath = path.join(process.cwd(), 'debug', filename);

      // Ensure debug directory exists
      const debugDir = path.dirname(filepath);
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      fs.writeFileSync(
        filepath,
        JSON.stringify(domAnalysis, null, 2),
        'utf-8'
      );

      logger.info('DOM analysis saved to file', { filepath });
    } catch (fileError) {
      logger.warn('Failed to save DOM analysis to file', {
        error: fileError instanceof Error ? fileError.message : String(fileError),
      });
    }
  }

  return { visualAnalysis, domAnalysis };
}
