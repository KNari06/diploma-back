import { TestRunRegistry } from '@/agent/playwright/core/test-run-registry';
import { dbService } from '@/db/supabase';
import { ApiResponse, NotFoundError, Test, ValidationError } from '@/types';
import { logger, logTestEvent } from '@/utils/core/logger';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';

/**
 * Get all running tests for a user
 */
export async function getRunningTestsForUser(userId: string): Promise<Test[]> {
  try {
    const { data: tests, error } = await dbService.supabaseAdmin
      .from('tests')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false });

    if (error) {
      logger.error(`[CANCEL_TEST] Failed to get running tests for user: ${userId}`, error);
      return [];
    }

    return (tests || []) as Test[];
  } catch (error) {
    logger.error(`[CANCEL_TEST] Error getting running tests for user: ${userId}`, error);
    return [];
  }
}

/**
 * Get all running tests for a chat session
 */
export async function getRunningTestsForChatSession(chatSessionId: string): Promise<Test[]> {
  try {
    // Get test IDs from test_chat_mappings
    const testIds = await TestChatMappingService.getTestIdsForChatSession(chatSessionId);

    if (testIds.length === 0) {
      return [];
    }

    const { data: tests, error } = await dbService.supabaseAdmin
      .from('tests')
      .select('*')
      .in('id', testIds)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false });

    if (error) {
      logger.error(`[CANCEL_TEST] Failed to get running tests for chat session: ${chatSessionId}`, error);
      return [];
    }

    return (tests || []) as Test[];
  } catch (error) {
    logger.error(`[CANCEL_TEST] Error getting running tests for chat session: ${chatSessionId}`, error);
    return [];
  }
}

/**
 * Cancel all running tests for a user
 */
export async function cancelAllRunningTestsForUser(userId: string): Promise<{
  success: boolean;
  cancelledCount: number;
  errors: string[];
}> {
  try {
    const runningTests = await getRunningTestsForUser(userId);
    const errors: string[] = [];
    let cancelledCount = 0;

    for (const test of runningTests) {
      try {
        await cancelTest(test.id, userId);
        cancelledCount++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to cancel test ${test.id}: ${errorMsg}`);
        logger.error(`[CANCEL_TEST] Failed to cancel test ${test.id}`, error);
      }
    }

    logger.info(`[CANCEL_TEST] Cancelled ${cancelledCount} tests for user: ${userId}`, {
      totalRunning: runningTests.length,
      cancelledCount,
      errorsCount: errors.length,
    });

    return {
      success: true,
      cancelledCount,
      errors,
    };
  } catch (error) {
    logger.error(`[CANCEL_TEST] Error cancelling all tests for user: ${userId}`, error);
    return {
      success: false,
      cancelledCount: 0,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * Cancel all running tests for a chat session
 * Note: Cancels ONLY tests linked via test_chat_mappings to avoid cancelling unrelated user tests.
 */
export async function cancelAllRunningTestsForChatSession(
  chatSessionId: string,
  userId?: string
): Promise<{
  success: boolean;
  cancelledCount: number;
  errors: string[];
}> {
  try {
    const runningTests = await getRunningTestsForChatSession(chatSessionId);
    const errors: string[] = [];
    let cancelledCount = 0;

    for (const test of runningTests) {
      try {
        // Verify user has access if userId provided
        // NOTE: service-level types use camelCase, DB rows may be snake_case
        const testUserId = (test as any).user_id ?? (test as any).userId;
        if (userId && testUserId && testUserId !== userId) {
          errors.push(`Access denied to test ${test.id}`);
          continue;
        }

        await cancelTest(test.id, userId);
        cancelledCount++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to cancel test ${test.id}: ${errorMsg}`);
        logger.error(`[CANCEL_TEST] Failed to cancel test ${test.id}`, error);
      }
    }

    logger.info(`[CANCEL_TEST] Cancelled ${cancelledCount} tests for chat session: ${chatSessionId}`, {
      totalRunning: runningTests.length,
      cancelledCount,
      errorsCount: errors.length,
    });

    return {
      success: true,
      cancelledCount,
      errors,
    };
  } catch (error) {
    logger.error(`[CANCEL_TEST] Error cancelling all tests for chat session: ${chatSessionId}`, error);
    return {
      success: false,
      cancelledCount: 0,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * Cancel all queue jobs for a test
 * Removes waiting jobs and marks active jobs for cancellation
 */
export async function cancelTestJobs(testId: string, browsers: string[]): Promise<void> {
  try {
    const { testRunQueue } = await import('@/config/infrastructure/queues');
    let cancelledCount = 0;

    // Cancel jobs for each browser
    for (const browser of browsers) {
      const jobId = `${testId}-${browser}`;

      try {
        // Get job from queue
        const job = await testRunQueue.getJob(jobId);

        if (job) {
          // Check job state
          const state = await job.getState();

          if (state === 'waiting' || state === 'delayed') {
            // Remove waiting/delayed jobs
            await job.remove();
            cancelledCount++;
            logger.info(`[CANCEL_TEST] Removed waiting job: ${jobId}`, {
              testId,
              browser,
              state,
            });
          } else if (state === 'active') {
            // Active jobs will be checked by worker and stopped
            // Worker checks test status in DB via checkTestCancelled()
            // No need to update job.data - status in DB is the source of truth
            logger.info(`[CANCEL_TEST] Active job will be cancelled by worker: ${jobId}`, {
              testId,
              browser,
              state,
              note: 'Worker checks test status in DB',
            });
          } else {
            logger.debug(`[CANCEL_TEST] Job already in final state: ${jobId}`, {
              testId,
              browser,
              state,
            });
          }
        } else {
          logger.debug(`[CANCEL_TEST] Job not found in queue: ${jobId}`, {
            testId,
            browser,
          });
        }
      } catch (jobError) {
        logger.warn(`[CANCEL_TEST] Failed to cancel job ${jobId}:`, {
          testId,
          browser,
          error: jobError instanceof Error ? jobError.message : String(jobError),
        });
      }
    }

    logger.info(`[CANCEL_TEST] Cancelled ${cancelledCount} jobs for test: ${testId}`, {
      testId,
      totalBrowsers: browsers.length,
      cancelledJobs: cancelledCount,
    });
  } catch (error) {
    logger.error(`[CANCEL_TEST] Error cancelling jobs for test ${testId}:`, error);
    // Don't throw - test status is already updated, workers will check it
  }
}

/**
 * Cancel a running test
 * - Updates test status to 'cancelled' in database
 * - Removes all related jobs from queue (waiting and active)
 * - Emits WebSocket event for cancellation
 */
export async function cancelTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
  try {
    // ✅ FIX: Use supabaseAdmin directly to bypass RLS and ensure we can find the test
    // This is important because RLS might prevent finding tests in some cases
    let test: any;

    try {
      // First try the service method (uses RLS)
      test = await dbService.getTest(testId) as any;
    } catch (getTestError) {
      // If getTest fails (RLS issue or other), try direct admin query
      logger.debug(`[CANCEL_TEST] getTest failed, trying admin query: ${testId}`, {
        error: getTestError instanceof Error ? getTestError.message : String(getTestError),
      });
    }

    // If still not found, try direct admin query
    if (!test) {
      const { data, error } = await dbService.supabaseAdmin
        .from('tests')
        .select('*')
        .eq('id', testId)
        .maybeSingle();

      if (error) {
        logger.error(`[CANCEL_TEST] Admin query failed: ${testId}`, {
          error: error.message,
          code: error.code,
        });
        throw new NotFoundError('Test', testId);
      }

      if (!data) {
        throw new NotFoundError('Test', testId);
      }

      test = data;
    }

    if (userId && test.user_id && test.user_id !== userId) {
      throw new ValidationError('Access denied to this test');
    }

    if (test.status === 'completed' || test.status === 'failed') {
      throw new ValidationError('Cannot cancel completed or failed test');
    }

    // Update test status first (so workers can check it)
    const updatedTest = await dbService.updateTest(testId, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    }) as any;

    // Cancel all jobs in queue for this test
    await cancelTestJobs(testId, test.browsers || []);

    // ✅ FIX: Abort all test runs for this testId (immediate stop)
    // This closes BrowserContext and stops video streaming for all browser runs
    try {
      await TestRunRegistry.abortByTestId(testId, 'cancelled');
      logger.info(`[CANCEL_TEST] Aborted test runs in current process: ${testId}`);
    } catch (abortError) {
      // Test might not be running in this process (runs in worker)
      logger.debug(`[CANCEL_TEST] No active test run to abort in main process: ${testId}`, {
        error: abortError instanceof Error ? abortError.message : String(abortError),
      });
    }

    // Emit WebSocket event
    const { webSocketService } = await import('@/websocket/core/websocket.service');
    webSocketService.emitTestCancelled(testId, {
      testId,
      timestamp: new Date().toISOString(),
    });

    logTestEvent('cancelled', testId, { userId });

    return {
      success: true,
      data: updatedTest,
      message: 'Test cancelled successfully',
      timestamp: new Date(),
    };

  } catch (error) {
    logger.error(`Failed to cancel test ${testId}:`, error);
    throw error;
  }
}
