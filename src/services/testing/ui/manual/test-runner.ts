import { QueueManager } from '@/config/infrastructure/queues';
import { ApiResponse, Test, TestRunRequest, ValidationError } from '@/types';
import { logger, logTestEvent } from '@/utils/core/logger';
import { TestCreatedPayload } from '@/websocket/types/types';
import { webSocketService } from '@/websocket/core/websocket.service';
import { createTest } from './test-creator';
import { validateTestRequest } from './test-validator';

/**
 * Create and run a new test
 */
export async function runTest(testRequest: TestRunRequest): Promise<ApiResponse<Test>> {
  try {
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 1: runTest called', {
      url: testRequest.url,
      intelligentMode: testRequest.intelligentMode,
      testGoal: testRequest.testGoal ? `"${testRequest.testGoal.substring(0, 50)}..."` : undefined,
    });

    // Validate test request
    validateTestRequest(testRequest);
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 2: Validation passed');

    // Validate userId (required)
    if (!testRequest.userId) {
      throw new ValidationError('User ID is required - anonymous users are not supported');
    }

    // NOTE: Credits check and deduction should be done BEFORE calling runTest()
    // - Chat flow: Done in executeUiTestFlow via CreditCostTrackerService
    // - Direct API: Done in /manual-test/run controller via CreditCostTrackerService
    // - Retry: Done in retryTest() method via checkUserCredits + deductCredits
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 3: Credits check/deduction handled by caller');

    // Create test record
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 4: Creating test record in DB');
    const test = await createTest(testRequest);
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 5: Test record created', { testId: test.id });

    // Add jobs to queue for each browser
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 6: Adding jobs to queue');

    for (const browser of testRequest.browsers) {
      logger.info('🟢 [MANUAL_TEST_FLOW] Step 7: Adding job to queue', { browser, testId: test.id });

      const job = await QueueManager.addTestRunJob({
        testId: test.id,
        url: testRequest.url,
        browser,
        options: testRequest.options,
        projectId: testRequest.projectId,
        userId: testRequest.userId,
        // Pass Playwright commands if available
        commands: (testRequest as any).commands,
        intent: (testRequest as any).intent,
        // Pass intelligent mode settings
        intelligentMode: testRequest.intelligentMode,
        testGoal: testRequest.testGoal,
      });

      logger.info('🟢 [MANUAL_TEST_FLOW] Step 8: Job added to queue successfully', {
        browser,
        jobId: job?.id
      });

      // Monitor the job after adding
      if (job?.id) {
        const { QueueMonitor } = await import('@/utils/monitoring/queue-monitor');
        QueueMonitor.monitorAfterJobAdd(job.id, test.id);
      }
    }

    // NOTE: Credits should be deducted BEFORE calling runTest()
    // - Chat flow: Credits deducted in executeUiTestFlow via CreditCostTrackerService
    // - Direct API: Credits should be deducted in controller before calling runTest()
    // - Retry: Credits deducted in retryTest() method
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 9: Credits already deducted by caller');

    logTestEvent('created', test.id, { url: testRequest.url, browsers: testRequest.browsers });

    // Emit WebSocket event for test creation
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 10: Emitting WebSocket event');
    const testCreatedPayload: TestCreatedPayload = {
      testId: test.id,
      url: testRequest.url,
      browsers: testRequest.browsers,
      userId: testRequest.userId,
      timestamp: new Date().toISOString(),
    };
    webSocketService.emitTestCreated(test.id, testCreatedPayload);

    logger.info('🟢 [MANUAL_TEST_FLOW] Step 11: DONE! Returning test', {
      testId: test.id,
      success: true
    });

    return {
      success: true,
      data: test,
      message: 'Test created successfully',
      timestamp: new Date(),
    };

  } catch (error) {
    logger.error('Failed to run test:', error);
    throw error;
  }
}
