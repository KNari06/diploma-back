import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { executePlaywrightTest } from './test-executor';

/**
 * Execute Playwright test with automatic retry
 */
export async function executePlaywrightTestWithRetry(
  testData: TestJobData,
  maxRetries: number = 2
): Promise<ReturnType<typeof executePlaywrightTest>> {
  let lastError: any;

  logger.info('[PLAYWRIGHT_RETRY] Starting test with retry logic', {
    testId: testData.testId,
    url: testData.url,
    browser: testData.browser,
    intelligentMode: testData.intelligentMode || false,
    maxRetries,
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const retryDelay = 2000 * attempt;
      logger.info('[PLAYWRIGHT_RETRY] Retrying Playwright test', {
        testId: testData.testId,
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        retryDelay: `${retryDelay}ms`,
        lastError: lastError instanceof Error ? lastError.message : String(lastError),
      });
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    } else {
      logger.info('[PLAYWRIGHT_RETRY] Initial test attempt', {
        testId: testData.testId,
        url: testData.url,
      });
    }

    try {
      const result = await executePlaywrightTest(testData);

      // Check if test was cancelled (result will have cancelled status)
      if (result.status === 'cancelled' || (result.error && result.error.includes('cancelled'))) {
        logger.info('[PLAYWRIGHT_RETRY] Test was cancelled', {
          testId: testData.testId,
          attempt: attempt + 1,
        });
        return result; // Return cancelled result immediately, don't retry
      }

      if (result.success) {
        if (attempt > 0) {
          logger.info('[PLAYWRIGHT_RETRY] Test succeeded after retry', {
            testId: testData.testId,
            successfulAttempt: attempt + 1,
            totalAttempts: maxRetries + 1,
          });
        }
        return result;
      }

      lastError = result.error;
      logger.warn('[PLAYWRIGHT_RETRY] Test attempt returned failure', {
        testId: testData.testId,
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        status: result.status,
        error: result.error,
      });
    } catch (error) {
      // Check if error is about cancellation
      if (error instanceof Error && error.message.includes('cancelled')) {
        logger.info('[PLAYWRIGHT_RETRY] Test was cancelled during execution', {
          testId: testData.testId,
          attempt: attempt + 1,
        });
        // Return cancelled result
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
        };
      }

      lastError = error;
      logger.warn('[PLAYWRIGHT_RETRY] Test attempt threw exception', {
        testId: testData.testId,
        attempt: attempt + 1,
        url: testData.url,
        browser: testData.browser,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
      });
    }
  }

  // All retries exhausted
  logger.error('[PLAYWRIGHT_RETRY] Test failed after all retries', {
    testId: testData.testId,
    url: testData.url,
    browser: testData.browser,
    intelligentMode: testData.intelligentMode || false,
    maxRetries,
    totalAttempts: maxRetries + 1,
    lastError: lastError instanceof Error ? {
      message: lastError.message,
      name: lastError.name,
      stack: lastError.stack,
    } : String(lastError),
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
