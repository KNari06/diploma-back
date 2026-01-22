import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { BrowserContext, Page } from 'playwright';

/**
 * Stop tracing and get video path
 * ✅ CRITICAL: video.path() only works AFTER page is closed!
 * This function now:
 * 1. Stops tracing (must be done before context close)
 * 2. Gets video reference
 * 3. Closes page (finalizes video)
 * 4. Gets video path after page is closed
 */
export async function stopTracingAndGetVideo(
  context: BrowserContext | null,
  page: Page | null,
  tracePath: string | undefined,
  meta?: { testId?: string; browser?: string }
): Promise<{ videoPath?: string; tracePath?: string }> {
  const result: { videoPath?: string; tracePath?: string } = {};

  // ✅ Step 1: Stop tracing before closing context
  if (context && tracePath) {
    try {
      await context.tracing.stop({ path: tracePath });
      result.tracePath = tracePath;
      logger.info('[PLAYWRIGHT] Trace saved', { tracePath });
    } catch (traceError) {
      logger.warn('[PLAYWRIGHT] Failed to stop tracing', {
        error: traceError instanceof Error ? traceError.message : String(traceError),
      });
    }
  }

  // ✅ Step 2: Get video reference BEFORE closing page
  if (page) {
    try {
      const video = page.video();
      if (video) {
        // ✅ Step 3: Close page FIRST to finalize video recording (preferred path)
        // video.path() is reliable only after page is closed.
        try {
          await page.close();
          logger.debug('[PLAYWRIGHT] Page closed for video finalization', {
            testId: meta?.testId,
            browser: meta?.browser,
          });
        } catch (closeError) {
          logger.warn('[PLAYWRIGHT] Failed to close page for video finalization', {
            testId: meta?.testId,
            browser: meta?.browser,
            error: closeError instanceof Error ? closeError.message : String(closeError),
          });
        }

        // ✅ Step 4: Get video path if page is closed; otherwise fallback to saveAs
        if (page.isClosed()) {
          result.videoPath = await video.path();
          logger.info('[PLAYWRIGHT] Video path resolved (after page close)', {
            testId: meta?.testId,
            browser: meta?.browser,
            videoPath: result.videoPath,
          });
        } else {
          // Fallback: saveAs is safe even while recording; it waits until video is ready.
          const fs = await import('fs/promises');
          const path = await import('path');
          const videosDir = path.join(process.cwd(), 'test-results', 'videos');
          await fs.mkdir(videosDir, { recursive: true });

          const fileName = `video-${meta?.testId || 'unknown'}-${Date.now()}.webm`;
          const fallbackPath = path.join(videosDir, fileName);
          await video.saveAs(fallbackPath);
          result.videoPath = fallbackPath;

          logger.info('[PLAYWRIGHT] Video saved via saveAs fallback (page not closed)', {
            testId: meta?.testId,
            browser: meta?.browser,
            videoPath: result.videoPath,
          });
        }
      } else {
        logger.warn('[PLAYWRIGHT] No video recording available (page.video() returned null)', {
          testId: meta?.testId,
          browser: meta?.browser,
          hint: 'Check if recordVideo is enabled in browser context options',
        });
      }
    } catch (videoError) {
      logger.warn('[PLAYWRIGHT] Failed to get video path', {
        testId: meta?.testId,
        browser: meta?.browser,
        error: videoError instanceof Error ? videoError.message : String(videoError),
      });
    }
  } else {
    logger.warn('[PLAYWRIGHT] Cannot get video path - page is null');
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
    // ✅ IMPROVED: More detailed error logging for debugging session save failures
    logger.error('[PLAYWRIGHT] Failed to save test data to intelligent_test_sessions', {
      testId: testData.testId,
      userId: testData.userId,
      projectId: testData.projectId,
      hasGoal: !!intelligentConfig?.goal,
      hasStartUrl: !!intelligentConfig?.startUrl,
      error: storageError instanceof Error ? {
        message: storageError.message,
        name: storageError.name,
        stack: storageError.stack?.substring(0, 500),
      } : String(storageError),
    });
    // Don't fail the test if storage fails
  }
}
