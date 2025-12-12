import { TestJobData } from '@/types';
import { logger } from '@/utils/logger';
import { BrowserContext, Page } from 'playwright';
import { stopTracingAndGetVideo } from './artifacts-handler';

/**
 * Cleanup browser resources (page and context)
 */
export async function cleanupBrowserResources(
  page: Page | null,
  context: BrowserContext | null,
  tracePath: string | undefined
): Promise<void> {
  if (page) {
    try {
      await page.close();
      logger.debug('[PLAYWRIGHT] Page closed');
    } catch (pageError) {
      logger.warn('[PLAYWRIGHT] Failed to close page', { error: pageError });
    }
  }

  if (context) {
    try {
      await context.close();
      logger.debug('[PLAYWRIGHT] Context closed');
    } catch (contextError) {
      logger.warn('[PLAYWRIGHT] Failed to close context', { error: contextError });
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
    const artifacts = await stopTracingAndGetVideo(context, page, tracePath);
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
