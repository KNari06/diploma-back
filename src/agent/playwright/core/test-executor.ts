import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { getActionIcon } from '@/websocket/types/types';
import { webSocketService } from '@/websocket/core/websocket.service';
import { BrowserContext, Page } from 'playwright';
import { IntelligentTestOrchestrator } from '../../core/intelligent-test-orchestrator';
import { saveIntelligentTestResults, uploadArtifacts, uploadIntelligentTestScreenshots } from '../artifacts/artifacts-handler';
import { getBrowserWithProgress, setupBrowserContext } from '../setup/browser-setup';
import { buildAllHintsWithMetadata } from '../setup/hints-builder';
import { navigateToUrl } from '../execution/navigation-handler';
import { RequestTracker } from '../execution/request-tracker';
import { checkTestCancelled } from '../utils/test-cancellation-checker';
import { collectArtifactsAndCleanup } from '../artifacts/test-cleanup';
import { buildIntelligentTestConfig } from '../setup/test-config-builder';
import { formatTestResult } from '../artifacts/test-result-formatter';

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

    // Build config and execute test
    const intelligentConfig = buildIntelligentTestConfig(testData, goal, hints, retryCount);
    const orchestrator = new IntelligentTestOrchestrator(
      intelligentConfig,
      testData.userId,
      testData.testId
    );

    logger.info('[PLAYWRIGHT] Starting intelligent test execution', {
      testId: testData.testId,
      goal,
      hintsCount: hints.length,
      hintsFromCommandsCount,
      feedbackHintsCount,
      retryCount,
    });

    // Execute matest using the orchestrator
    const intelligentResult = await orchestrator.execute(browser, page);

    logger.info('[PLAYWRIGHT] Intelligent test completed', {
      testId: testData.testId,
      success: intelligentResult.success,
      pagesVisited: intelligentResult.pagesVisited,
      actionsTaken: intelligentResult.actionsTaken,
      duration: `${Math.round(intelligentResult.duration / 1000)}s`,
      cost: `$${intelligentResult.cost.toFixed(3)}`,
    });

    // Save results and upload artifacts
    await saveIntelligentTestResults(testData, intelligentResult, intelligentConfig);
    const screenshotUrls = await uploadIntelligentTestScreenshots(
      testData,
      intelligentResult.screenshots || []
    );

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
