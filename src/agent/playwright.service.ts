import { TestJobData } from '@/types';
import { logger } from '@/utils/logger';
import { devices, Page } from 'playwright';
import { browserPool } from './browser-pool';
import { ResultCollector } from './result-collector';
import { CommandExecutor } from './command-executor';
import { IntelligentTestOrchestrator } from './intelligent-test-orchestrator';
import { IntelligentTestConfig } from './types/intelligent-testing.types';
import { DEFAULT_SAFETY_CONFIG } from './safety-guard';

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
  error?: string;
}> {
  let page: Page | null = null;
  const collector = new ResultCollector();

  try {
    logger.info('Starting Playwright test', {
      testId: testData.testId,
      url: testData.url,
      browser: testData.browser,
      intelligentMode: testData.intelligentMode || false,
    });

    // Get browser from pool
    const browser = await browserPool.getBrowser(testData.browser);

    // Create context with options
    const contextOptions: any = {
      viewport: testData.options?.viewport || { width: 1920, height: 1080 },
      userAgent: testData.options?.headers?.['User-Agent'] || undefined,
    };

    // Mobile emulation
    if (testData.options?.mobile || testData.browser.includes('mobile')) {
      const device = testData.browser === 'mobile-safari'
        ? devices['iPhone 12']
        : devices['Pixel 5'];
      Object.assign(contextOptions, device);
    }

    const context = await browser.newContext(contextOptions);
    page = await context.newPage();

    // ═══════════════════════════════════════════════════════════════════════
    // INTELLIGENT MODE: Use IntelligentTestOrchestrator
    // ═══════════════════════════════════════════════════════════════════════
    if (testData.intelligentMode) {
      logger.info('Using Intelligent Testing Mode', {
        testId: testData.testId,
        goal: testData.testGoal || testData.intent || 'General testing',
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

      logger.info('Intelligent test completed', {
        testId: testData.testId,
        success: intelligentResult.success,
        pagesVisited: intelligentResult.pagesVisited,
        actionsTaken: intelligentResult.actionsTaken,
        cost: `$${intelligentResult.cost.toFixed(3)}`,
      });

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

    // Close page and context
    await page.close();
    await context.close();

    logger.info('Playwright test completed successfully', {
      testId: testData.testId,
      browser: testData.browser,
      logsCount: results.logs.length,
      networkLogsCount: results.networkLogs.length,
      errorsCount: results.errors.length,
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
