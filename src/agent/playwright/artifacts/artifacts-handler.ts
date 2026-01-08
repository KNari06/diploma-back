import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { BrowserContext, Page } from 'playwright';

/**
 * Stop tracing and get video path before closing resources
 */
export async function stopTracingAndGetVideo(
  context: BrowserContext | null,
  page: Page | null,
  tracePath: string | undefined
): Promise<{ videoPath?: string; tracePath?: string }> {
  const result: { videoPath?: string; tracePath?: string } = {};

  // ✅ CRITICAL FIX: Stop tracing before closing
  if (context && tracePath) {
    try {
      await context.tracing.stop({ path: tracePath });
      result.tracePath = tracePath;
      logger.info('[PLAYWRIGHT] Trace saved', { tracePath });
    } catch (traceError) {
      logger.warn('[PLAYWRIGHT] Failed to stop tracing', { error: traceError });
    }
  }

  // ✅ CRITICAL FIX: Get video path before closing page
  if (page) {
    try {
      const video = page.video();
      if (video) {
        result.videoPath = await video.path();
        logger.info('[PLAYWRIGHT] Video saved', { videoPath: result.videoPath });
      }
    } catch (videoError) {
      logger.warn('[PLAYWRIGHT] Failed to get video path', { error: videoError });
    }
  }

  return result;
}

/**
 * Upload artifacts (video, trace, screenshots) to storage
 */
export async function uploadArtifacts(
  testData: TestJobData,
  videoPath?: string,
  tracePath?: string,
  _screenshotUrls?: string[]
): Promise<{ videoUrl?: string; traceUrl?: string }> {
  const result: { videoUrl?: string; traceUrl?: string } = {};
  void _screenshotUrls; // Intentionally not used here (screenshots are uploaded elsewhere)

  try {
    const { uploadVideoToStorage, uploadTraceToStorage } = await import('@/services/storage/test-artifacts-storage.service');

    if (videoPath) {
      result.videoUrl = await uploadVideoToStorage(videoPath, testData.testId, testData.userId || 'anonymous');
      logger.info('[PLAYWRIGHT] Video uploaded to storage', { videoUrl: result.videoUrl });
    }

    if (tracePath) {
      result.traceUrl = await uploadTraceToStorage(tracePath, testData.testId, testData.userId || 'anonymous');
      logger.info('[PLAYWRIGHT] Trace uploaded to storage', { traceUrl: result.traceUrl });
    }
  } catch (uploadError) {
    logger.error('[PLAYWRIGHT] Failed to upload artifacts', {
      error: uploadError instanceof Error ? uploadError.message : String(uploadError),
    });
    // Don't fail the test if upload fails
  }

  return result;
}

/**
 * Upload intelligent test screenshots to storage
 */
export async function uploadIntelligentTestScreenshots(
  testData: TestJobData,
  screenshots: Array<{ screenshot?: string }>
): Promise<string[]> {
  const screenshotUrls: string[] = [];

  if (!screenshots || screenshots.length === 0) {
    return screenshotUrls;
  }

  logger.info('[PLAYWRIGHT] Checking screenshots for upload', {
    testId: testData.testId,
    screenshotsCount: screenshots.length,
  });

  try {
    const { uploadScreenshotToStorage } = await import('@/services/storage/test-artifacts-storage.service');

    for (let i = 0; i < screenshots.length; i++) {
      const screenshot = screenshots[i];
      if (screenshot.screenshot) {
        try {
          const screenshotUrl = await uploadScreenshotToStorage(
            screenshot.screenshot,
            testData.testId,
            testData.userId || 'anonymous',
            i
          );
          screenshotUrls.push(screenshotUrl);
          logger.info('[PLAYWRIGHT] Intelligent test screenshot uploaded', {
            testId: testData.testId,
            index: i,
            url: screenshotUrl,
          });
        } catch (screenshotError) {
          logger.error('[PLAYWRIGHT] Failed to upload intelligent test screenshot', {
            testId: testData.testId,
            index: i,
            error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
          });
        }
      }
    }
  } catch (uploadError) {
    logger.error('[PLAYWRIGHT] Failed to upload intelligent test screenshots', {
      testId: testData.testId,
      error: uploadError instanceof Error ? uploadError.message : String(uploadError),
    });
  }

  return screenshotUrls;
}

/**
 * Save intelligent test results to database
 */
export async function saveIntelligentTestResults(
  testData: TestJobData,
  intelligentResult: any,
  intelligentConfig: any
): Promise<void> {
  try {
    const { IntelligentTestStorageService } = await import('@/services/testing/results/intelligent-test-storage.service');

    logger.info('[PLAYWRIGHT] Saving test session with graph data', {
      testId: testData.testId,
      hasGraphData: !!intelligentResult.graphData,
      graphNodes: intelligentResult.graphData?.nodes?.length || 0,
      graphEdges: intelligentResult.graphData?.edges?.length || 0,
    });

    await IntelligentTestStorageService.saveTestSession({
      testId: testData.testId,
      userId: testData.userId || 'anonymous',
      projectId: testData.projectId,
      result: intelligentResult,
      config: {
        goal: intelligentConfig.goal,
        startUrl: intelligentConfig.startUrl,
        mode: intelligentConfig.mode,
        browser: testData.browser || 'chrome',
        viewport: testData.options?.viewport,
        credentialsUsed: !!testData.options?.credentials,
      },
      graphData: intelligentResult.graphData, // ✅ NEW: Save complete graph
    });

    logger.info('[PLAYWRIGHT] Test data saved to database', {
      testId: testData.testId,
      tables: ['intelligent_test_sessions', 'intelligent_page_visits', 'intelligent_test_actions'],
      graphDataSaved: !!intelligentResult.graphData,
    });
  } catch (storageError) {
    logger.error('[PLAYWRIGHT] Failed to save test data', {
      testId: testData.testId,
      error: storageError instanceof Error ? storageError.message : 'Unknown error',
    });
    // Don't fail the test if storage fails
  }
}
