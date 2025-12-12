import { dbService } from '@/db/supabase';
import { ApiResponse, NotFoundError, Test, ValidationError } from '@/types';
import { logger, logTestEvent } from '@/utils/logger';

/**
 * Cancel all queue jobs for a test
 * Removes waiting jobs and marks active jobs for cancellation
 */
export async function cancelTestJobs(testId: string, browsers: string[]): Promise<void> {
  try {
    const { testRunQueue } = await import('@/config/queues');
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
    const test = await dbService.getTest(testId) as any;
    if (!test) {
      throw new NotFoundError('Test', testId);
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

    // Emit WebSocket event
    const { webSocketService } = await import('@/websocket/websocket.service');
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
