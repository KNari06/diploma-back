import { QueueManager } from '@/config/infrastructure/queues';
import { dbAdminService, supabaseAdmin } from '@/db/supabase';
import { ApiResponse, Test, TestRunRequest, ValidationError } from '@/types';
import { logTestEvent, logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { TestCreatedPayload } from '@/websocket/types/types';
import { cancelTestJobs } from './test-cancellation';
import { createTest } from './test-creator';
import { validateTestRequest } from './test-validator';

/**
 * Find existing active test (pending/running) for same user/url/project
 * Prevents duplicate test creation when frontend rapidly calls /run
 *
 * @param testRequest - Test request parameters
 * @returns Existing test if found, null otherwise
 */
async function findExistingActiveTest(testRequest: TestRunRequest): Promise<Test | null> {
  if (!testRequest.userId || !testRequest.url) {
    return null;
  }

  try {
    // Query for active tests matching: userId + url + projectId + status IN (pending, running)
    // Time window: created in last 5 minutes (avoid matching very old stuck tests)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from('tests')
      .select('*')
      .eq('user_id', testRequest.userId)
      .eq('url', testRequest.url)
      .eq('project_id', testRequest.projectId)
      .in('status', ['pending', 'running'])
      .gte('created_at', fiveMinutesAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.warn('[ACTIVE_TEST_GUARD] Failed to query existing tests', {
        error: error.message,
        userId: testRequest.userId,
        url: testRequest.url,
      });
      return null; // On error, allow test creation (fail-open)
    }

    return data as Test | null;
  } catch (error) {
    logger.warn('[ACTIVE_TEST_GUARD] Exception checking for active test', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null; // Fail-open
  }
}

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

    // ✅ FIX: Active-test guard - prevent duplicate tests for same user/url/project
    // If user already has a pending/running test for the same target, return it instead of creating new
    const existingActiveTest = await findExistingActiveTest(testRequest);
    if (existingActiveTest) {
      logger.info('🟢 [MANUAL_TEST_FLOW] Active test exists, returning existing instead of creating duplicate', {
        existingTestId: existingActiveTest.id,
        status: existingActiveTest.status,
        url: testRequest.url,
        userId: testRequest.userId,
      });

      return {
        success: true,
        data: existingActiveTest,
        // ✅ IMPORTANT: Callers that deduct credits must skip charging when we reuse an active test.
        message: 'ACTIVE_TEST_REUSED',
        timestamp: new Date(),
      };
    }

    // Create test record
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 4: Creating test record in DB');
    const test = await createTest(testRequest);
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 5: Test record created', { testId: test.id });

    // Add jobs to queue for each browser
    logger.info('🟢 [MANUAL_TEST_FLOW] Step 6: Adding jobs to queue');

    const queuedBrowsers: string[] = [];
    const effectiveMode =
      testRequest.mode ||
      ((testRequest.options as any)?.mode as 'lite' | 'pro' | undefined) ||
      'lite';
    try {
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
          mode: effectiveMode, // Test execution mode (supports fallback to options.mode)
          chatSessionId: testRequest.chatSessionId, // Pass chat session ID for WebSocket routing isolation
          prefilledSteps: (testRequest as any).prefilledSteps, // Smart Resolver: prefilled steps for fast replay
          // Resource bindings (Login, Environment, Secret, ...) — runner
          // applies each to the browser context before navigation.
          resourceBindings: testRequest.resourceBindings,
        });

        queuedBrowsers.push(browser);

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
    } catch (queueError) {
      // Important: if queuing fails after we already created the test record,
      // avoid leaving a "pending" test that will never run.
      logger.error('[MANUAL_TEST_FLOW] Failed to queue one or more jobs; cancelling test', {
        testId: test.id,
        queuedBrowsers,
        error: queueError instanceof Error ? queueError.message : String(queueError),
      });

      // Best-effort: remove waiting/delayed jobs that were already queued
      try {
        if (queuedBrowsers.length > 0) {
          await cancelTestJobs(test.id, queuedBrowsers);
        }
      } catch {
        // never throw from cleanup
      }

      // Best-effort: mark test as cancelled so workers stop quickly if any job already became active
      try {
        await dbAdminService.updateTestIfNotCancelled(test.id, {
          status: 'cancelled',
          completed_at: new Date().toISOString(),
        });
      } catch (statusError) {
        logger.warn('[MANUAL_TEST_FLOW] Failed to mark test as cancelled after queue failure', {
          testId: test.id,
          error: statusError instanceof Error ? statusError.message : String(statusError),
        });
      }

      throw queueError;
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
