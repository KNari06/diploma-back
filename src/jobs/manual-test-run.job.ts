import { Job } from 'bullmq';
import { logger, logQueueEvent } from '@/utils/logger';
import { handleAgentError, shouldRetry, calculateRetryDelay } from '@/utils/error-handler';
import { TestJobData, AgentResponse } from '@/types';
import { dbAdminService } from '@/db/supabase';
import { QueueManager } from '@/config/queues';
import { env } from '@/config/env';
import { executePlaywrightTestWithRetry } from '@/agent';
import { webSocketService } from '@/websocket/websocket.service';
import {
  TestStartedPayload,
  TestBrowserCompletedPayload,
  TestFailedPayload,
  ResultReadyPayload,
  ResultErrorPayload,
} from '@/websocket/types';

// Constants
const MAX_RETRIES = env.AGENT_MAX_RETRIES || 2;
const DEFAULT_ADMIN_EMAIL = 'admin@qai.so';

export class ManualTestRunJobHandler {
  /**
   * Process test run job
   */
  static async process(job: Job<TestJobData>) {
    const { testId, url, browser, options, projectId, userId, retryCount = 0, commands, intent, intelligentMode, testGoal } = job.data;

    // Validate required parameters
    if (!testId || !url || !browser) {
      throw new Error('Missing required parameters: testId, url, or browser');
    }

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
        throw new Error(result.error || 'Test execution failed');
      }

    } catch (error) {
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
   */
  private static async updateOverallTestStatus(testId: string) {
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

      // Send completion notification if all tests are done
      if (allCompleted) {
        await this.sendCompletionNotification(testId, status, results);
      }

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
