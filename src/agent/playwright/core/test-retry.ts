import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { executePlaywrightTest } from './test-executor';
import { classifyRetry, type RetryDecision } from './retry-classifier.service';

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
 * Ask the LLM classifier whether a non-deterministic failure is a genuine
 * infra-transient issue worth retrying. Wraps `classifyRetry` with safe
 * logging + a guarantee that exceptions never leak out as a "retry" signal.
 */
async function shouldRetryByClassifier(
  testId: string,
  errorMessage: string,
): Promise<RetryDecision | null> {
  try {
    const decision = await classifyRetry({ errorMessage });
    logger.info('[PLAYWRIGHT_RETRY] LLM classifier verdict', {
      testId,
      shouldRetry: decision.shouldRetry,
      category: decision.category,
      reasoning: decision.reasoning,
      elapsedMs: decision.elapsedMs,
      fallbackUsed: !!decision.fallbackUsed,
    });
    return decision;
  } catch (err) {
    // classifyRetry is designed to never throw, but defend-in-depth: any
    // unexpected explosion here must not produce a phantom retry.
    logger.error('[PLAYWRIGHT_RETRY] classifyRetry threw unexpectedly', {
      testId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Execute Playwright test with automatic retry.
 *
 * Retry strategy (April 2026 refactor):
 *   1. If the error matches NON_RETRYABLE_ERROR_PATTERNS → fail immediately.
 *   2. Otherwise, ask a fast LLM ("is this a genuine infra issue?").
 *      Only retry when the classifier returns category=infra_transient.
 *   3. maxRetries defaults to 1 — one retry is enough for a true infra hiccup;
 *      anything beyond hides real bugs and wastes engineer time.
 *
 * Background: before this refactor we retried up to 3 times on every
 * non-deterministic failure. QA reported the UI looked like the test was
 * "cycling" because the frontend rendered each retry as a replay of steps.
 * Worse, real product bugs (like a missing button) were sometimes masked
 * when a later retry happened to succeed because of a timing change.
 */
export async function executePlaywrightTestWithRetry(
  testData: TestJobData,
  maxRetries: number = 1
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
      // - Skip compiled plan on retry (go straight to LLM resolver)
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

      // 🧠 LLM gate: ask the classifier whether this non-deterministic failure
      // is a genuine infra-transient issue worth retrying. Product bugs and
      // test issues fall through to an immediate return so QA can see them.
      // Skip the classifier on the last attempt (nothing to decide).
      if (attempt < maxRetries && result.error) {
        const decision = await shouldRetryByClassifier(
          testData.testId,
          String(result.error),
        );
        if (decision && !decision.shouldRetry) {
          logger.info('[PLAYWRIGHT_RETRY] LLM classifier says do NOT retry', {
            testId: testData.testId,
            attempt: attempt + 1,
            category: decision.category,
            reasoning: decision.reasoning,
            error: result.error,
          });
          return result;
        }
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

      // 🧠 LLM gate: same logic as the result-error path. Thrown exceptions
      // from the executor are usually genuine infra hiccups (browser closed,
      // CDP lost, socket reset), but we still want the classifier to confirm
      // before burning a retry budget.
      const exceptionMessage = error instanceof Error ? error.message : String(error);
      if (attempt < maxRetries && exceptionMessage) {
        const decision = await shouldRetryByClassifier(
          testData.testId,
          exceptionMessage,
        );
        if (decision && !decision.shouldRetry) {
          logger.info('[PLAYWRIGHT_RETRY] LLM classifier says do NOT retry (exception path)', {
            testId: testData.testId,
            attempt: attempt + 1,
            category: decision.category,
            reasoning: decision.reasoning,
            error: exceptionMessage,
          });
          return {
            success: false,
            status: 'failed',
            logs: [],
            networkLogs: [],
            errors: [{
              type: 'other',
              message: exceptionMessage,
              timestamp: new Date(),
            }],
            error: exceptionMessage,
          };
        }
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
