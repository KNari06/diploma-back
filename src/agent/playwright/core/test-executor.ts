import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { getActionIcon } from '@/websocket/types/types';
import { BrowserContext, Page } from 'playwright';
import { IntelligentTestOrchestrator } from '../../core/intelligent-test-orchestrator';
import { LiteEngine, ModeRouter } from '../../core/lite';
import { saveIntelligentTestResults, uploadArtifacts, uploadIntelligentTestScreenshots } from '../artifacts/artifacts-handler';
import { collectArtifactsAndCleanup } from '../artifacts/test-cleanup';
import { formatTestResult } from '../artifacts/test-result-formatter';
import { VideoStreamRegistry } from '../artifacts/video-stream-registry';
import { createVideoStreamService, VideoStreamService } from '../artifacts/video-stream.service';
import { navigateToUrl } from '../execution/navigation-handler';
import { RequestTracker } from '../execution/request-tracker';
import { getBrowserWithProgress, setupBrowserContext } from '../setup/browser-setup';
import { buildAllHintsWithMetadata } from '../setup/hints-builder';
import { buildIntelligentTestConfig } from '../setup/test-config-builder';
import { checkTestCancelled } from '../utils/test-cancellation-checker';

/**
 * Execute Playwright test
 */
export async function executePlaywrightTest(testData: TestJobData): Promise<{
  success: boolean;
  status: string;
  screenshot?: string;
  dom?: string;
  logs: string[];
  networkLogs: any[];
  errors: any[];
  performance?: any;
  videoUrl?: string;
  videoPath?: string;
  traceUrl?: string;
  tracePath?: string;
  error?: string;
}> {
  let page: Page | null = null;
  let context: BrowserContext | null = null;
  let tracePath: string | undefined;
  let videoStreamService: VideoStreamService | null = null;

  try {
    // Pre-flight checks
    await checkTestCancelled(testData.testId);
    const retryCount = testData.retryCount ?? 0;

    logger.info('[PLAYWRIGHT] Starting test', {
      testId: testData.testId,
      url: testData.url,
      browser: testData.browser,
      intelligentMode: testData.intelligentMode || false,
      projectId: testData.projectId,
      userId: testData.userId,
      retryCount,
    });

    // Setup browser and page
    const browser = await getBrowserWithProgress(testData);
    const setupResult = await setupBrowserContext(testData, browser);
    context = setupResult.context;
    tracePath = setupResult.tracePath;

    page = await context.newPage();
    if (!page) {
      throw new Error('Failed to create page');
    }

    // Start video streaming for Chrome (CDP screencast)
    if (testData.browser.toLowerCase().includes('chrome') || testData.browser.toLowerCase().includes('chromium')) {
      try {
        videoStreamService = createVideoStreamService();
        await videoStreamService.start(page, testData.testId, testData.browser, testData.userId, testData.url);

        if (videoStreamService.isActive()) {
          VideoStreamRegistry.register(testData.testId, videoStreamService);
          logger.info('[PLAYWRIGHT] Video streaming started', {
            testId: testData.testId,
            browser: testData.browser,
          });
        }
      } catch (videoError) {
        // Video streaming is optional - don't fail the test
        logger.warn('[PLAYWRIGHT] Failed to start video streaming', {
          testId: testData.testId,
          error: videoError instanceof Error ? videoError.message : String(videoError),
        });
        videoStreamService = null;
      }
    }

    // Build hints (commands + feedback from previous runs)
    const goal = testData.testGoal || testData.intent || 'Test the application';
    const { hints, hintsFromCommandsCount, feedbackHintsCount } = await buildAllHintsWithMetadata(testData, retryCount);

    logger.info('[PLAYWRIGHT] Unified Intelligent Mode activated', {
      testId: testData.testId,
      goal,
      hasCommands: !!(testData.commands && testData.commands.length > 0),
      hintsCount: hints.length,
      hintsFromCommandsCount,
      feedbackHintsCount,
      mode: 'balanced',
      retryCount,
    });

    // Navigate to URL
    webSocketService.emitTestProgress(testData.testId, {
      testId: testData.testId,
      browser: testData.browser,
      progress: 20,
      phase: 'initialization',
      currentStep: `📄 Navigating to ${testData.url}...`,
      icon: getActionIcon('goto', 'initialization'),
      status: 'running',
      timestamp: new Date().toISOString(),
      userId: testData.userId,
    });

    const requestTracker = new RequestTracker(page);
    await navigateToUrl(page, testData, requestTracker);
    await checkTestCancelled(testData.testId);

    // Determine which mode to use (Lite vs Pro)
    const modeSelection = ModeRouter.selectMode({
      goal,
      url: testData.url,
      userId: testData.userId,
      userMode: testData.mode || 'lite', // Pass user-selected mode from frontend
    });

    logger.info('[PLAYWRIGHT] Selected test mode', {
      testId: testData.testId,
      mode: modeSelection.mode,
      reason: modeSelection.reason,
    });

    let intelligentResult: any;

    if (modeSelection.mode === 'lite') {
      // Use Lite Engine
      logger.info('[PLAYWRIGHT] Starting Lite Engine execution', {
        testId: testData.testId,
        goal,
      });

      const liteEngine = new LiteEngine(page, {
        testId: testData.testId,
        userId: testData.userId,
        browser: testData.browser,
        goal,
        url: testData.url,
        timeout: 5 * 60 * 1000, // 5 minutes
      });

      const liteResult = await liteEngine.execute();

      logger.info('[PLAYWRIGHT] Lite Engine completed', {
        testId: testData.testId,
        success: liteResult.success,
        iterations: liteResult.iterations,
        reason: liteResult.reason,
        screenshotsCount: liteResult.screenshots.length,
      });

      // Lite screenshots are uploaded during execution in LiteEngine (for real-time graph updates).
      // IMPORTANT: Do NOT upload again here — avoids duplicates and broken index mapping on partial failures.

      // Convert Lite result to format expected by rest of system (IntelligentTestResult)
      // ✅ FIXED: Now includes all required fields for Pro parity

      // Build screenshots array from graphData (source of truth for URLs + screenshot URLs)
      const screenshots: Array<{ url: string; screenshot: string }> = [];
      const seenScreenshotUrls = new Set<string>();
      if (liteResult.graphData?.nodes) {
        for (const node of liteResult.graphData.nodes as any[]) {
          if (!node?.meta) continue;

          const urlAfter: string | undefined = node.meta.urlAfter;
          const urlBefore: string | undefined = node.meta.urlBefore;
          const screenshotAfter: string | undefined = node.meta.screenshotAfter;
          const screenshotBefore: string | undefined = node.meta.screenshotBefore;
          const pageScreenshot: string | undefined = node.meta.screenshot; // page nodes

          const pushIfNew = (url: string | undefined, screenshotUrl: string | undefined) => {
            if (!screenshotUrl) return;
            if (seenScreenshotUrls.has(screenshotUrl)) return;
            seenScreenshotUrls.add(screenshotUrl);
            screenshots.push({ url: url || testData.url, screenshot: screenshotUrl });
          };

          pushIfNew(urlBefore, screenshotBefore);
          pushIfNew(urlAfter, screenshotAfter);
          pushIfNew(urlAfter, pageScreenshot);
        }
      }

      intelligentResult = {
        // Core fields
        success: liteResult.success,
        goal: goal,
        startUrl: testData.url,
        pagesVisited: 1,
        actionsTaken: liteResult.iterations,
        duration: liteResult.duration || 0,
        cost: liteResult.iterations * 0.001, // Approximate cost

        // Error/warning tracking
        errors: [], // Lite doesn't track errors in same format yet
        warnings: [],

        // Summary
        summary: liteResult.reason,

        // Page visits (minimal for Lite)
        pageVisits: [],

        // Screenshots: Pro format, derived from graphData (already URLs)
        screenshots,

        // ✅ NEW: Full graph data like Pro
        graphData: liteResult.graphData,

        // Internal flags
        _liteMode: true, // Flag to skip uploadIntelligentTestScreenshots
      };
    } else {
      // Use Pro Mode (existing IntelligentTestOrchestrator)
      logger.info('[PLAYWRIGHT] Starting Pro Mode execution', {
        testId: testData.testId,
        goal,
        hintsCount: hints.length,
      });

      const intelligentConfig = buildIntelligentTestConfig(testData, goal, hints, retryCount);
      const orchestrator = new IntelligentTestOrchestrator(
        intelligentConfig,
        testData.userId,
        testData.testId
      );

      intelligentResult = await orchestrator.execute(browser, page);

      logger.info('[PLAYWRIGHT] Pro Mode completed', {
        testId: testData.testId,
        success: intelligentResult.success,
        pagesVisited: intelligentResult.pagesVisited,
        actionsTaken: intelligentResult.actionsTaken,
        duration: `${Math.round(intelligentResult.duration / 1000)}s`,
        cost: `$${intelligentResult.cost.toFixed(3)}`,
      });
    }

    // Save results and upload artifacts
    // For Lite mode, create a minimal config for compatibility
    const finalConfig = modeSelection.mode === 'lite'
      ? { mode: 'lite', goal, hints: [] }
      : buildIntelligentTestConfig(testData, goal, hints, retryCount);

    await saveIntelligentTestResults(testData, intelligentResult, finalConfig);

    // Upload screenshots:
    // - Lite mode: screenshots already uploaded as URLs, just extract them
    // - Pro mode: screenshots are base64, need to upload to storage
    let screenshotUrls: string[] = [];
    if (intelligentResult._liteMode) {
      // Lite mode: screenshots are already URLs
      screenshotUrls = (intelligentResult.screenshots || [])
        .map((s: { screenshot?: string }) => s.screenshot)
        .filter((url: string | undefined): url is string => !!url);

      logger.debug('[PLAYWRIGHT] Lite mode: using pre-uploaded screenshot URLs', {
        testId: testData.testId,
        count: screenshotUrls.length,
      });
    } else {
      // Pro mode: upload base64 screenshots to storage
      screenshotUrls = await uploadIntelligentTestScreenshots(
        testData,
        intelligentResult.screenshots || []
      );
    }

    // Stop video streaming
    if (videoStreamService?.isActive()) {
      try {
        await videoStreamService.stop('completed');
        VideoStreamRegistry.unregister(testData.testId);
      } catch (videoError) {
        logger.warn('[PLAYWRIGHT] Failed to stop video streaming', {
          testId: testData.testId,
          error: videoError instanceof Error ? videoError.message : String(videoError),
        });
      }
    }

    // Collect artifacts and cleanup (best-effort)
    let artifacts: { videoPath?: string; tracePath?: string } = {};
    try {
      artifacts = await collectArtifactsAndCleanup(testData, context, page, tracePath);
    } catch (cleanupError) {
      logger.warn('[PLAYWRIGHT] Failed to collect artifacts during cleanup', {
        testId: testData.testId,
        browser: testData.browser,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    // Upload video/trace (screenshots already uploaded separately)
    const uploadedArtifacts = await uploadArtifacts(
      testData,
      artifacts.videoPath,
      artifacts.tracePath,
      screenshotUrls
    ).catch((uploadError) => {
      logger.debug('[PLAYWRIGHT] Failed to upload artifacts', {
        testId: testData.testId,
        browser: testData.browser,
        error: uploadError instanceof Error ? uploadError.message : String(uploadError),
      });
      return { videoUrl: undefined, traceUrl: undefined };
    });

    // Format and return result
    return formatTestResult(intelligentResult, {
      videoUrl: uploadedArtifacts.videoUrl,
      videoPath: artifacts.videoPath,
      traceUrl: uploadedArtifacts.traceUrl,
      tracePath: artifacts.tracePath,
    });

  } catch (error) {
    // Handle cancellation
    const isCancelled = error instanceof Error && error.message.includes('cancelled');
    if (isCancelled) {
      logger.info('[PLAYWRIGHT] Test was cancelled', {
        testId: testData.testId,
        browser: testData.browser,
      });

      // Stop video streaming on cancellation
      if (videoStreamService?.isActive()) {
        try {
          await videoStreamService.stop('cancelled');
          VideoStreamRegistry.unregister(testData.testId);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Collect artifacts and cleanup (best-effort)
      let artifacts: { videoPath?: string; tracePath?: string } = {};
      try {
        artifacts = await collectArtifactsAndCleanup(testData, context, page, tracePath);
      } catch (cleanupError) {
        logger.warn('[PLAYWRIGHT] Failed to collect artifacts during cancellation cleanup', {
          testId: testData.testId,
          browser: testData.browser,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      // Upload artifacts (best-effort)
      const uploadedArtifacts = await uploadArtifacts(testData, artifacts.videoPath, artifacts.tracePath, [])
        .catch(() => ({ videoUrl: undefined, traceUrl: undefined }));

      return {
        success: false,
        status: 'cancelled',
        logs: [],
        networkLogs: [],
        errors: [{
          type: 'cancelled',
          message: 'Test was cancelled by user',
          timestamp: new Date(),
        }],
        error: 'Test cancelled',
        videoUrl: uploadedArtifacts.videoUrl,
        videoPath: artifacts.videoPath,
        traceUrl: uploadedArtifacts.traceUrl,
        tracePath: artifacts.tracePath,
      };
    }

    // Handle failure
    logger.error('Playwright test failed', {
      testId: testData.testId,
      browser: testData.browser,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack,
      } : String(error),
      url: testData.url,
      intelligentMode: testData.intelligentMode || false,
    });

    // Stop video streaming on error
    if (videoStreamService?.isActive()) {
      try {
        await videoStreamService.stop('error');
        VideoStreamRegistry.unregister(testData.testId);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Collect artifacts and cleanup (best-effort)
    let artifacts: { videoPath?: string; tracePath?: string } = {};
    try {
      artifacts = await collectArtifactsAndCleanup(testData, context, page, tracePath);
    } catch (cleanupError) {
      logger.warn('[PLAYWRIGHT] Failed to collect artifacts during error cleanup', {
        testId: testData.testId,
        browser: testData.browser,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    // Upload artifacts (best-effort)
    const uploadedArtifacts = await uploadArtifacts(testData, artifacts.videoPath, artifacts.tracePath, [])
      .catch(() => ({ videoUrl: undefined, traceUrl: undefined }));

    return {
      success: false,
      status: 'failed',
      screenshot: undefined,
      dom: '',
      logs: [],
      networkLogs: [],
      errors: [{
        type: 'other',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date(),
      }],
      error: error instanceof Error ? error.message : 'Test execution failed',
      videoUrl: uploadedArtifacts.videoUrl,
      videoPath: artifacts.videoPath,
      traceUrl: uploadedArtifacts.traceUrl,
      tracePath: artifacts.tracePath,
    };
  }
}
