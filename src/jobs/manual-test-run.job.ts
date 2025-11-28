import { executePlaywrightTestWithRetry } from '@/agent';
import { env } from '@/config/env';
import { QueueManager } from '@/config/queues';
import { dbAdminService } from '@/db/supabase';
import { AgentResponse, TestJobData } from '@/types';
import { calculateRetryDelay, handleAgentError, shouldRetry } from '@/utils/error-handler';
import { logger, logQueueEvent } from '@/utils/logger';
import {
  ResultErrorPayload,
  ResultReadyPayload,
  TestBrowserCompletedPayload,
  TestCancelledPayload,
  TestFailedPayload,
  TestStartedPayload,
} from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';
import { Job } from 'bullmq';

// Constants
const MAX_RETRIES = env.AGENT_MAX_RETRIES || 2;
const DEFAULT_ADMIN_EMAIL = 'admin@qai.so';

/**
 * Custom error for test cancellation
 */
export class TestCancelledError extends Error {
  constructor(testId: string, browser: string) {
    super(`Test ${testId} (${browser}) was cancelled`);
    this.name = 'TestCancelledError';
  }
}

export class ManualTestRunJobHandler {
  /**
   * Check if test is cancelled
   */
  private static async checkTestCancelled(testId: string): Promise<boolean> {
    try {
      const test = await dbAdminService.getTest(testId) as any;
      return test?.status === 'cancelled';
    } catch (error) {
      logger.warn(`[TEST-RUN] Failed to check test status: ${testId}`, error);
      return false; // Don't block execution if check fails
    }
  }

  /**
   * Process test run job
   */
  static async process(job: Job<TestJobData>) {
    const { testId, url, browser, options, projectId, userId, retryCount = 0, commands, intent, intelligentMode, testGoal } = job.data;

    // Validate required parameters
    if (!testId || !url || !browser) {
      throw new Error('Missing required parameters: testId, url, or browser');
    }

    // Check if test was cancelled before starting
    if (await this.checkTestCancelled(testId)) {
      logger.info(`[TEST-RUN] Test was cancelled before execution: ${testId} (${browser})`);
      throw new TestCancelledError(testId, browser);
    }

    // Check if job was marked for cancellation (via metadata or status)
    // Note: cancelled flag is not in TestJobData type, but can be checked via test status

    logger.info(`[TEST-RUN] Processing job for test: ${testId} (${browser})`, {
      hasCommands: !!commands,
      commandsCount: commands?.length,
      intent,
      intelligentMode,
      testGoal: testGoal ? `"${testGoal.substring(0, 50)}..."` : undefined,
      retryAttempt: retryCount,
    });
    logQueueEvent('processing', job.id!, { testId, browser });

    try {
      // Update test status to running
      logger.info(`[TEST-RUN] Updating test status to running: ${testId}`);
      await this.updateTestStatus(testId, 'running', new Date().toISOString());

      // Check again after status update (in case it was cancelled between checks)
      if (await this.checkTestCancelled(testId)) {
        logger.info(`[TEST-RUN] Test was cancelled after status update: ${testId} (${browser})`);
        throw new TestCancelledError(testId, browser);
      }

      // Emit WebSocket: test started
      this.emitTestStarted(testId, browser);

      logger.info(`[TEST-RUN] Executing Playwright test: ${testId}`, {
        browser,
        url,
        hasCommands: !!commands,
        intelligentMode,
      });

      // Execute test using local Playwright agent (integrated)
      const result = await executePlaywrightTestWithRetry(
        {
          testId,
          url,
          browser,
          options,
          projectId,
          userId,
          commands,
          intent,
          intelligentMode,
          testGoal,
        },
        MAX_RETRIES
      );

      // Process result
      logger.info(`[TEST-RUN] Test execution completed: ${testId}`, {
        success: result.success,
        status: result.status,
      });

      if (result.success) {
        await this.handleSuccessfulTest(testId, browser, result);
      } else {
        // ✅ FIX: Don't throw exception - executePlaywrightTestWithRetry already exhausted all retries
        // Just handle the final failure result
        logger.error(`[TEST-RUN] Test execution failed after all retries: ${testId}`, {
          testId,
          browser,
          url,
          status: result.status,
          error: result.error,
          errors: result.errors?.length || 0,
        });

        // Mark test as failed (final failure)
        await this.updateTestStatus(testId, 'failed', undefined, new Date().toISOString());

        // Emit WebSocket events for failure
        this.emitTestFailed(testId, browser, new Error(result.error || 'Test execution failed'));
        this.emitResultError(testId, browser, new Error(result.error || 'Test execution failed'));

        // Send failure notification
        await this.sendFailureNotification(testId, new Error(result.error || 'Test execution failed'));

        // Don't throw - this is the final result after all retries
        // BullMQ retry should NOT happen here - executePlaywrightTestWithRetry already did all retries
      }

    } catch (error) {
      // Handle test cancellation separately
      if (error instanceof TestCancelledError) {
        logger.info(`[TEST-RUN] Test cancelled: ${testId} (${browser})`, {
          testId,
          browser,
        });

        // Emit WebSocket event for cancellation
        const payload: TestCancelledPayload = {
          testId,
          timestamp: new Date().toISOString(),
        };
        webSocketService.emitTestCancelled(testId, payload);

        // Don't mark as failed, don't retry, just exit gracefully
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

      // ✅ FIX: Detailed error logging with full context
      logger.error(`[TEST-RUN] Job failed for test ${testId} (${browser}):`, {
        testId,
        browser,
        url,
        intelligentMode,
        testGoal: testGoal ? `"${testGoal.substring(0, 50)}..."` : undefined,
        retryAttempt: retryCount,
        maxRetries: MAX_RETRIES,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
      });

      // Emit WebSocket events for failure
      this.emitTestFailed(testId, browser, error as Error);
      this.emitResultError(testId, browser, error as Error);

      // Check if we should retry
      if (shouldRetry(error, retryCount, MAX_RETRIES)) {
        const delay = calculateRetryDelay(retryCount);
        logger.info(`[TEST-RUN] Retrying test in ${delay}ms: ${testId} (${browser}) - Attempt ${retryCount + 1}/${MAX_RETRIES}`);

        // Update retry count and delay
        await job.updateData({ ...job.data, retryCount: retryCount + 1 });
        throw new Error(`Retry ${retryCount + 1}/${MAX_RETRIES}: ${(error as Error).message}`);
      }

      // Mark test as failed (final failure)
      await this.updateTestStatus(testId, 'failed', undefined, new Date().toISOString());

      // Send failure notification
      await this.sendFailureNotification(testId, error);

      throw handleAgentError(error as Error);
    }
  }

  /**
   * Update test status in database
   */
  private static async updateTestStatus(
    testId: string,
    status: 'running' | 'completed' | 'failed',
    startedAt?: string,
    completedAt?: string
  ) {
    const updateData: any = { status };
    if (startedAt) updateData.started_at = startedAt;
    if (completedAt) updateData.completed_at = completedAt;

    await dbAdminService.updateTest(testId, updateData);
  }

  /**
   * Emit test started WebSocket event
   */
  private static emitTestStarted(testId: string, browser: string) {
    const payload: TestStartedPayload = {
      testId,
      browser,
      timestamp: new Date().toISOString(),
    };
    webSocketService.emitTestStarted(testId, payload);
  }

  /**
   * Emit test failed WebSocket event
   */
  private static emitTestFailed(testId: string, browser: string, error: Error) {
    const payload: TestFailedPayload = {
      testId,
      browser,
      error: error.message,
      timestamp: new Date().toISOString(),
    };
    webSocketService.emitTestFailed(testId, payload);
  }

  /**
   * Emit result error WebSocket event
   */
  private static emitResultError(testId: string, browser: string, error: Error) {
    const payload: ResultErrorPayload = {
      testId,
      browser,
      error: {
        type: 'execution_error',
        message: error.message,
        stack: error.stack,
      },
      timestamp: new Date().toISOString(),
    };
    webSocketService.emitResultError(testId, payload);
  }

  /**
   * Handle successful test completion
   * ///improvement: Added synchronous test status update to prevent race condition
   */
  private static async handleSuccessfulTest(testId: string, browser: string, result: any) {
    logger.info(`[TEST-RUN] Creating test result in database: ${testId}`);

    // Create test result in database
    const testResultRecord = await dbAdminService.createTestResult({
      test_id: testId,
      browser,
      status: result.status as any,
      screenshot: result.screenshot,
      dom: result.dom,
      logs: result.logs || [],
      network_logs: result.networkLogs || [],
      errors: result.errors || [],
      performance: result.performance,
      completed_at: new Date().toISOString(),
    });

    // Emit WebSocket: browser completed
    const browserCompletedPayload: TestBrowserCompletedPayload = {
      testId,
      browser,
      status: 'completed',
      errorsCount: result.errors?.length || 0,
      timestamp: new Date().toISOString(),
    };
    webSocketService.emitTestBrowserCompleted(testId, browserCompletedPayload);

    // Emit WebSocket: result ready
    const resultReadyPayload: ResultReadyPayload = {
      testId,
      browser,
      resultId: (testResultRecord as any).id,
      timestamp: new Date().toISOString(),
    };
    webSocketService.emitResultReady(testId, resultReadyPayload);

    // Add AI analysis job
    const testResult = await dbAdminService.getTestResultByTestAndBrowser(testId, browser);
    if (testResult) {
      await QueueManager.addAIAnalysisJob(testResult.id, testId);
      logger.info(`[TEST-RUN] AI analysis job queued for test result: ${testResult.id}`);
    }

    // ///improvement: Update overall test status synchronously to prevent race condition
    // This ensures test status is updated immediately after result is created
    await ManualTestResultJobHandler.updateOverallTestStatus(testId);

    logger.info(`[TEST-RUN] Test completed successfully: ${testId}`, {
      browser,
      logsCount: result.logs?.length || 0,
      errorsCount: result.errors?.length || 0,
    });
  }

  /**
   * Send failure notification
   */
  private static async sendFailureNotification(testId: string, error: any) {
    try {
      // Get test details
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) {
        logger.warn(`[TEST-RUN] Test not found for failure notification: ${testId}`);
        return;
      }

      const errorMessage = (error as Error).message || 'Unknown error occurred';
      logger.info(`[TEST-RUN] Sending failure notification for test: ${testId}`);

      // Send notification
      await QueueManager.addNotificationJob({
        type: 'email',
        recipient: test.user_id || DEFAULT_ADMIN_EMAIL,
        subject: `Test Failed: ${testId}`,
        message: `Test ${testId} failed with error: ${errorMessage}`,
        data: { testId, error: errorMessage },
      });
    } catch (notificationError) {
      logger.error(`[TEST-RUN] Failed to send failure notification for test ${testId}:`, notificationError);
    }
  }
}

/**
 * Test result processing job handler
 */
export class ManualTestResultJobHandler {
  /**
   * Process test result job
   */
  static async process(job: Job<AgentResponse>) {
    const { testId, browser, result, error } = job.data;

    logger.info(`Processing test result: ${testId} (${browser})`);
    logQueueEvent('processing', job.id!, { testId, browser });

    try {
      if (error) {
        throw new Error(error);
      }

      if (!result) {
        throw new Error('No result data received from agent');
      }

      // Save test result to database
      const savedResult = await dbAdminService.createTestResult({
        test_id: testId,
        browser,
        status: result.status || 'completed',
        screenshot: result.screenshot,
        dom: result.dom,
        logs: result.logs || [],
        network_logs: result.networkLogs || [],
        errors: result.errors || [],
        performance: result.performance,
        completed_at: new Date().toISOString(),
      });

      // Add AI analysis job
      await QueueManager.addAIAnalysisJob((savedResult as any).id, testId);

      // Update overall test status
      await this.updateOverallTestStatus(testId);

      logger.info(`Test result processed successfully: ${testId} (${browser})`);

    } catch (error) {
      logger.error(`Test result processing failed: ${testId} (${browser})`, error);

      // Mark test result as failed
      await dbAdminService.createTestResult({
        test_id: testId,
        browser,
        status: 'failed',
        errors: [{
          type: 'other',
          message: (error as Error).message,
          timestamp: new Date()
        }],
        completed_at: new Date().toISOString(),
      });

      // Update overall test status
      await this.updateOverallTestStatus(testId);

      throw error;
    }
  }

  /**
   * Update overall test status based on all results
   * ///improvement: Made public to allow synchronous status updates from handleSuccessfulTest
   */
  static async updateOverallTestStatus(testId: string) {
    try {
      // Get all results for this test
      const results = await dbAdminService.getTestResults(testId) as any[];

      if (results.length === 0) {
        logger.debug(`[TEST-RESULT] No results found for test: ${testId}`);
        return;
      }

      // Determine overall test status
      const hasFailed = results.some((r: any) => r.status === 'failed');
      const allCompleted = results.every((r: any) => r.status === 'completed' || r.status === 'failed');

      let status: 'running' | 'completed' | 'failed' = 'running';

      if (allCompleted) {
        status = hasFailed ? 'failed' : 'completed';
      }

      logger.info(`[TEST-RESULT] Updating overall test status: ${testId} -> ${status}`);

      // Update test status
      await dbAdminService.updateTest(testId, {
        status,
        completed_at: allCompleted ? new Date().toISOString() : undefined,
      });

      // Email notifications disabled - all data is available in DB via API
      // if (allCompleted) {
      //   await this.sendCompletionNotification(testId, status, results);
      // }

    } catch (error) {
      logger.error(`[TEST-RESULT] Failed to update test status for ${testId}:`, error);
    }
  }

  /**
   * Send completion notification
   */
  private static async sendCompletionNotification(
    testId: string,
    status: string,
    results: any[]
  ) {
    try {
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) {
        logger.warn(`[TEST-RESULT] Test not found for completion notification: ${testId}`);
        return;
      }

      const successCount = results.filter((r: any) => r.status === 'completed').length;
      const totalCount = results.length;

      logger.info(`[TEST-RESULT] Sending completion notification: ${testId} (${successCount}/${totalCount} successful)`);

      await QueueManager.addNotificationJob({
        type: 'email',
        recipient: test.user_id || DEFAULT_ADMIN_EMAIL,
        subject: `Test ${status}: ${testId}`,
        message: `Test ${testId} ${status}. ${successCount}/${totalCount} browsers completed successfully.`,
        data: { testId, status, results: results.length },
      });
    } catch (error) {
      logger.error(`[TEST-RESULT] Failed to send completion notification for test ${testId}:`, error);
    }
  }
}
