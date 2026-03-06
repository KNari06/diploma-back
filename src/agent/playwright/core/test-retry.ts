import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { executePlaywrightTest } from './test-executor';

/**
 * Errors that are deterministic and should NOT be retried.
 * These indicate application-level failures, not transient infra issues.
 * Checked via substring match (case-insensitive).
 */
const NON_RETRYABLE_ERROR_PATTERNS = [
  'insufficient credits',
  'goal not reached',
  'assertion failed',
  'test goal was not achieved',
  'max iterations reached',
  'navigation timeout',       // Page itself is broken, retry won't help
  'net::err_name_not_resolved', // DNS failure for target URL
  'net::err_connection_refused', // Target server is down
];

/**
 * Check if an error message indicates a deterministic (non-retryable) failure.
 */
function isDeterministicError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return NON_RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

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
      // Pass attempt number so executor can adapt strategy:
      // - Skip compiled plan on retry (go straight to embeddings)
      // - Enable video on retry (test already failed, need debug recording)
      const testDataWithRetry = {
        ...testData,
        _retryAttempt: attempt,
      };
      const result = await executePlaywrightTest(testDataWithRetry);

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

      // ✅ IMPORTANT: Do not retry "valid test failures" (goal not reached / assertions failed)
      // Retry is reserved for transient infra errors where `executePlaywrightTest` reports an explicit error string.
      if (result.status === 'failed' && (!result.error || String(result.error).trim().length === 0)) {
        logger.info('[PLAYWRIGHT_RETRY] Not retrying failed test without explicit error (treated as deterministic failure)', {
          testId: testData.testId,
          attempt: attempt + 1,
          status: result.status,
        });
        return result;
      }

      // ✅ Do not retry deterministic errors (credits, DNS, goal failures with error string)
      if (result.error && isDeterministicError(String(result.error))) {
        logger.info('[PLAYWRIGHT_RETRY] Not retrying deterministic error', {
          testId: testData.testId,
          attempt: attempt + 1,
          error: result.error,
        });
        return result;
      }

      lastError = result.error;
      logger.warn('[PLAYWRIGHT_RETRY] Test attempt returned failure (retryable)', {
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

      // ✅ Do not retry deterministic exceptions
      if (error instanceof Error && isDeterministicError(error.message)) {
        logger.info('[PLAYWRIGHT_RETRY] Not retrying deterministic exception', {
          testId: testData.testId,
          attempt: attempt + 1,
          error: error.message,
        });
        return {
          success: false,
          status: 'failed',
          logs: [],
          networkLogs: [],
          errors: [{
            type: 'other',
            message: error.message,
            timestamp: new Date(),
          }],
          error: error.message,
        };
      }

      lastError = error;
      logger.warn('[PLAYWRIGHT_RETRY] Test attempt threw exception (retryable)', {
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
