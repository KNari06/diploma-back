import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { BrowserContext, Page } from 'playwright';
import { stopTracingAndGetVideo } from './artifacts-handler';

/**
 * Cleanup browser resources (page and context)
 * ✅ NOTE: Page may already be closed by stopTracingAndGetVideo (for video finalization)
 */
export async function cleanupBrowserResources(
  page: Page | null,
  context: BrowserContext | null,
  _tracePath: string | undefined
): Promise<void> {
  void _tracePath; // Cleanup is best-effort; trace file is handled by artifact collector/uploader

  // ✅ Page may already be closed by stopTracingAndGetVideo - check isClosed()
  if (page && !page.isClosed()) {
    try {
      await page.close();
      logger.debug('[PLAYWRIGHT] Page closed');
    } catch (pageError) {
      // Ignore "already closed" errors
      const msg = pageError instanceof Error ? pageError.message : String(pageError);
      if (!msg.includes('closed') && !msg.includes('Target closed')) {
        logger.warn('[PLAYWRIGHT] Failed to close page', { error: msg });
      }
    }
  }

  if (context) {
    try {
      await context.close();
      logger.debug('[PLAYWRIGHT] Context closed');
    } catch (contextError) {
      // Ignore "already closed" errors
      const msg = contextError instanceof Error ? contextError.message : String(contextError);
      if (!msg.includes('closed') && !msg.includes('Target closed')) {
        logger.warn('[PLAYWRIGHT] Failed to close context', { error: msg });
      }
    }
  }
}

/**
 * Collect artifacts and cleanup resources
 */
export async function collectArtifactsAndCleanup(
  testData: TestJobData,
  context: BrowserContext | null,
  page: Page | null,
  tracePath: string | undefined
): Promise<{
  videoPath?: string;
  tracePath?: string;
}> {
  let videoPath: string | undefined;
  let tracePathResult: string | undefined = tracePath;

  // Stop tracing and get video path before closing
  try {
    const artifacts = await stopTracingAndGetVideo(context, page, tracePath, {
      testId: testData.testId,
      browser: testData.browser,
    });
    videoPath = artifacts.videoPath;
    tracePathResult = artifacts.tracePath;
  } catch (artifactError) {
    logger.debug('[PLAYWRIGHT] Failed to collect artifacts', {
      testId: testData.testId,
      browser: testData.browser,
      error: artifactError instanceof Error ? artifactError.message : String(artifactError),
    });
  }

  // Cleanup browser resources
  await cleanupBrowserResources(page, context, tracePathResult);

  // Note: Artifact upload is handled separately in test-executor.ts
  // to allow screenshots to be uploaded first, then video/trace together
  return {
    videoPath,
    tracePath: tracePathResult,
  };
}
