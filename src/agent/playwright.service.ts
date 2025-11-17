import { TestJobData } from '@/types';
import { logger } from '@/utils/logger';
import { devices, Page } from 'playwright';
import { browserPool } from './browser-pool';
import { CommandExecutor } from './command-executor';
import { IntelligentTestOrchestrator } from './intelligent-test-orchestrator';
import { ResultCollector } from './result-collector';
import { DEFAULT_SAFETY_CONFIG } from './safety-guard';
import { IntelligentTestConfig } from './types/intelligent-testing.types';
import { webSocketService } from '@/websocket/websocket.service';

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
  // ✅ NEW: Video & Trace support
  videoUrl?: string;
  videoPath?: string;
  traceUrl?: string;
  tracePath?: string;
  error?: string;
}> {
  let page: Page | null = null;
  let context: any = null;
  let videoPath: string | undefined;
  let tracePath: string | undefined;
  const collector = new ResultCollector();

  try {
    logger.info('[PLAYWRIGHT] Starting test', {
      testId: testData.testId,
      url: testData.url,
      browser: testData.browser,
      intelligentMode: testData.intelligentMode || false,
      projectId: testData.projectId,
      userId: testData.userId,
    });

    // Emit progress: Browser launching (10%)
    webSocketService.emitTestProgress(testData.testId, {
      testId: testData.testId,
      browser: testData.browser,
      progress: 10,
      phase: 'initialization',
      currentStep: '🌐 Launching browser...',
      status: 'running',
      timestamp: new Date().toISOString(),
    });

    // Get browser from pool
    const browser = await browserPool.getBrowser(testData.browser);

    // Emit progress: Browser ready (15%)
    webSocketService.emitTestProgress(testData.testId, {
      testId: testData.testId,
      browser: testData.browser,
      progress: 15,
      phase: 'initialization',
      currentStep: '✅ Browser ready',
      status: 'running',
      timestamp: new Date().toISOString(),
    });

    // ✅ FIX: Prepare video & trace directories
    const fs = await import('fs/promises');
    const path = await import('path');

    const videosDir = path.join(process.cwd(), 'test-results', 'videos');
    const tracesDir = path.join(process.cwd(), 'test-results', 'traces');

    await fs.mkdir(videosDir, { recursive: true });
    await fs.mkdir(tracesDir, { recursive: true });

    // Create context with options
    const contextOptions: any = {
      viewport: testData.options?.viewport || { width: 1920, height: 1080 },
      userAgent: testData.options?.headers?.['User-Agent'] || undefined,
      // ✅ NEW: Enable video recording
      recordVideo: {
        dir: videosDir,
        size: { width: 1920, height: 1080 }
      },
    };

    // Mobile emulation
    if (testData.options?.mobile || testData.browser.includes('mobile')) {
      const device = testData.browser === 'mobile-safari'
        ? devices['iPhone 12']
        : devices['Pixel 5'];
      Object.assign(contextOptions, device);
      // Update video size for mobile
      contextOptions.recordVideo.size = contextOptions.viewport;
    }

    context = await browser.newContext(contextOptions);

    // ✅ NEW: Start tracing
    tracePath = path.join(tracesDir, `trace-${testData.testId}-${Date.now()}.zip`);
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });

    logger.info('[PLAYWRIGHT] Video & Trace recording started', {
      testId: testData.testId,
      videoDir: videosDir,
      tracePath,
    });

    page = await context.newPage();

    // ✅ FIX: Ensure page is not null
    if (!page) {
      throw new Error('Failed to create page');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTELLIGENT MODE: Use IntelligentTestOrchestrator
    // ═══════════════════════════════════════════════════════════════════════
    if (testData.intelligentMode) {
      logger.info('[PLAYWRIGHT] Intelligent mode activated', {
        testId: testData.testId,
        goal: testData.testGoal || testData.intent || 'General testing',
        mode: 'balanced',
      });

      // Emit progress: Navigating to page (20%)
      webSocketService.emitTestProgress(testData.testId, {
        testId: testData.testId,
        browser: testData.browser,
        progress: 20,
        phase: 'initialization',
        currentStep: `📄 Navigating to ${testData.url}...`,
        status: 'running',
        timestamp: new Date().toISOString(),
      });

      // Navigate to URL
      await page.goto(testData.url, { waitUntil: 'networkidle', timeout: 30000 });

      // Emit progress: Page loaded (25%)
      webSocketService.emitTestProgress(testData.testId, {
        testId: testData.testId,
        browser: testData.browser,
        progress: 25,
        phase: 'initialization',
        currentStep: '✅ Page loaded',
        status: 'running',
        timestamp: new Date().toISOString(),
      });

      // Build intelligent test config
      const intelligentConfig: IntelligentTestConfig = {
        mode: 'balanced', // Use balanced mode by default
        safety: {
          ...DEFAULT_SAFETY_CONFIG,
          level: 'normal',
        },
        goal: testData.testGoal || testData.intent || 'Test the application',
        startUrl: testData.url,
        browser: testData.browser, // Add browser for progress tracking
        credentials: testData.options?.credentials,
        userContext: {
          projectId: testData.projectId,
          testId: testData.testId,
        },
      };

      // Create orchestrator
      const orchestrator = new IntelligentTestOrchestrator(
        intelligentConfig,
        testData.userId,
        testData.testId
      );

      // Execute intelligent test
      const intelligentResult = await orchestrator.execute(browser, page);

      logger.info('[PLAYWRIGHT] Intelligent test completed', {
        testId: testData.testId,
        success: intelligentResult.success,
        pagesVisited: intelligentResult.pagesVisited,
        actionsTaken: intelligentResult.actionsTaken,
        duration: `${Math.round(intelligentResult.duration / 1000)}s`,
        cost: `$${intelligentResult.cost.toFixed(3)}`,
      });

      // ═══════════════════════════════════════════════════════════════════════
      // SAVE TO SPECIALIZED INTELLIGENT TEST TABLES
      // ═══════════════════════════════════════════════════════════════════════
      try {
        const { IntelligentTestStorageService } = await import('@/services/testing/results/intelligent-test-storage.service');

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
        });

        logger.info('[PLAYWRIGHT] Test data saved to database', {
          testId: testData.testId,
          tables: ['intelligent_test_sessions', 'intelligent_page_visits', 'intelligent_test_actions'],
        });
      } catch (storageError) {
        logger.error('[PLAYWRIGHT] Failed to save test data', {
          testId: testData.testId,
          error: storageError instanceof Error ? storageError.message : 'Unknown error',
        });
        // Don't fail the test if storage fails
      }

      // Convert intelligent result to standard format
      return {
        success: intelligentResult.success,
        status: intelligentResult.success ? 'completed' : 'failed',
        screenshot: intelligentResult.screenshots[0]?.screenshot,
        dom: '', // DOM will be in page visits
        logs: [`Intelligent test: ${intelligentResult.summary}`],
        networkLogs: [],
        errors: intelligentResult.errors.map(e => ({
          type: 'other' as const,
          message: e.message,
          timestamp: new Date(),
        })),
        performance: {
          pagesVisited: intelligentResult.pagesVisited,
          actionsTaken: intelligentResult.actionsTaken,
          duration: intelligentResult.duration,
          cost: intelligentResult.cost,
        },
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STANDARD MODE: Execute commands or legacy flow
    // ═══════════════════════════════════════════════════════════════════════

    // Setup result collectors
    collector.setupListeners(page);

    // Set timeout
    const timeout = testData.options?.timeout || 30000;
    page.setDefaultTimeout(timeout);

    // Execute Playwright commands if provided
    if (testData.commands && testData.commands.length > 0) {
      logger.info(`Executing ${testData.commands.length} Playwright commands`, {
        testId: testData.testId,
        commandCount: testData.commands.length,
      });

      const executor = new CommandExecutor(page);
      const commandResults = await executor.executeCommands(testData.commands);

      if (!commandResults.success) {
        logger.warn('Some commands failed during execution', {
          failedCount: commandResults.errors.length,
          errors: commandResults.errors,
        });

        // Add command errors to collector
        for (const { error } of commandResults.errors) {
          collector.errors.push({
            type: 'other',
            message: `Command execution error: ${error}`,
            timestamp: new Date(),
          });
        }
      } else {
        logger.info('All commands executed successfully', {
          successCount: commandResults.results.length,
        });
      }
    } else {
      // Legacy flow: Navigate to URL if no commands provided
      logger.info('No commands provided, using legacy navigation flow');
      logger.info('Navigating to URL', { url: testData.url });
      await page.goto(testData.url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });

      // Wait for selector if specified
      if (testData.options?.waitForSelector) {
        logger.info('Waiting for selector', { selector: testData.options.waitForSelector });
        await page.waitForSelector(testData.options.waitForSelector, { timeout });
      } else {
        // Default wait for network idle
        await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 10000) });
      }

      // Execute custom scripts if provided
      if (testData.options?.customScripts && testData.options.customScripts.length > 0) {
        for (const script of testData.options.customScripts) {
          try {
            logger.info('Executing custom script');
            await page.evaluate(script);
          } catch (scriptError) {
            logger.warn('Custom script failed', { error: scriptError });
            collector.errors.push({
              type: 'other',
              message: `Custom script failed: ${scriptError instanceof Error ? scriptError.message : 'Unknown'}`,
              timestamp: new Date(),
            });
          }
        }
      }

      // Small delay to let page settle
      await page.waitForTimeout(1000);
    }

    // Collect results
    const results = await collector.collect(page, true);

    // ✅ NEW: Stop tracing before closing
    await context.tracing.stop({ path: tracePath });
    logger.info('[PLAYWRIGHT] Trace saved', { tracePath });

    // ✅ NEW: Get video path before closing page
    const video = page.video();
    await page.close();

    if (video) {
      videoPath = await video.path();
      logger.info('[PLAYWRIGHT] Video saved', { videoPath });
    }

    await context.close();

    // ✅ NEW: Upload video & trace to Supabase Storage
    let videoUrl: string | undefined;
    let traceUrl: string | undefined;

    try {
      const { uploadVideoToStorage, uploadTraceToStorage } = await import('@/services/storage/test-artifacts-storage.service');

      if (videoPath) {
        videoUrl = await uploadVideoToStorage(videoPath, testData.testId, testData.userId || 'anonymous');
        logger.info('[PLAYWRIGHT] Video uploaded to storage', { videoUrl });
      }

      if (tracePath) {
        traceUrl = await uploadTraceToStorage(tracePath, testData.testId, testData.userId || 'anonymous');
        logger.info('[PLAYWRIGHT] Trace uploaded to storage', { traceUrl });
      }
    } catch (uploadError) {
      logger.error('[PLAYWRIGHT] Failed to upload artifacts', {
        error: uploadError instanceof Error ? uploadError.message : String(uploadError),
      });
      // Don't fail the test if upload fails
    }

    logger.info('Playwright test completed successfully', {
      testId: testData.testId,
      browser: testData.browser,
      logsCount: results.logs.length,
      networkLogsCount: results.networkLogs.length,
      errorsCount: results.errors.length,
      hasVideo: !!videoUrl,
      hasTrace: !!traceUrl,
    });

    return {
      success: true,
      status: 'completed',
      screenshot: results.screenshot,
      dom: results.dom,
      logs: results.logs,
      networkLogs: results.networkLogs,
      errors: results.errors,
      performance: results.performance,
      // ✅ NEW: Return video & trace paths/URLs
      videoUrl,
      videoPath,
      traceUrl,
      tracePath,
    };
  } catch (error) {
    logger.error('Playwright test failed', {
      testId: testData.testId,
      browser: testData.browser,
      error,
    });

    // Try to collect partial results
    let partialResults = null;
    if (page) {
      try {
        partialResults = await collector.collect(page, true);
        await page.close();
      } catch (cleanupError) {
        logger.error('Failed to collect partial results', { error: cleanupError });
      }
    }

    return {
      success: false,
      status: 'failed',
      screenshot: partialResults?.screenshot,
      dom: partialResults?.dom,
      logs: partialResults?.logs || collector.logs,
      networkLogs: partialResults?.networkLogs || collector.networkLogs,
      errors: partialResults?.errors || [
        ...collector.errors,
        {
          type: 'other',
          message: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date(),
        },
      ],
      error: error instanceof Error ? error.message : 'Test execution failed',
    };
  }
}

/**
 * Execute Playwright test with automatic retry
 */
export async function executePlaywrightTestWithRetry(
  testData: TestJobData,
  maxRetries: number = 2
): Promise<ReturnType<typeof executePlaywrightTest>> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      logger.info('Retrying Playwright test', {
        testId: testData.testId,
        attempt,
        maxRetries,
      });
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }

    try {
      const result = await executePlaywrightTest(testData);

      if (result.success) {
        return result;
      }

      lastError = result.error;
    } catch (error) {
      lastError = error;
      logger.warn('Test attempt failed', {
        testId: testData.testId,
        attempt,
        error,
      });
    }
  }

  // All retries exhausted
  logger.error('Test failed after all retries', {
    testId: testData.testId,
    maxRetries,
    lastError,
  });

  return {
    success: false,
    status: 'failed',
    logs: [],
    networkLogs: [],
    errors: [
      {
        type: 'other',
        message: `Test failed after ${maxRetries} retries: ${lastError}`,
        timestamp: new Date(),
      },
    ],
    error: `Failed after ${maxRetries} retries`,
  };
}

/**
 * Get agent status
 */
export async function getAgentStatus(): Promise<{
  available: boolean;
  browserPool: ReturnType<typeof browserPool.getStatus>;
}> {
  return {
    available: true,
    browserPool: browserPool.getStatus(),
  };
}
