import { executePlaywrightTestWithRetry } from '@/agent';
import { env } from '@/config/environment/env';
import { QueueManager } from '@/config/infrastructure/queues';
import { dbAdminService } from '@/db/supabase';
import { AgentResponse, TestJobData } from '@/types';
import { calculateRetryDelay, handleAgentError, shouldRetry } from '@/utils/core/error-handler';
import { logQueueEvent, logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import {
  ResultErrorPayload,
  ResultReadyPayload,
  TestBrowserCompletedPayload,
  TestCancelledPayload,
  TestCompletedPayload,
  TestFailedPayload,
  TestStartedPayload,
} from '@/websocket/types/types';
import { Job } from 'bullmq';

// Constants
// Retry budget for executePlaywrightTestWithRetry. Default: 1 (one retry).
// April 2026: lowered from 2 → 1 because an LLM classifier now gates retries
// on real infra-transient failures only. One retry is plenty for a genuine
// infra hiccup; more retries mask real product bugs and waste engineer time.
// Override with AGENT_MAX_RETRIES for debugging on a specific environment.
const MAX_RETRIES = env.AGENT_MAX_RETRIES ?? 1;
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
    const {
      testId,
      url,
      browser,
      options,
      projectId,
      userId,
      retryCount = 0,
      commands,
      intent,
      intelligentMode,
      testGoal,
      mode,
      chatSessionId,
      resourceBindings,
    } = job.data;

    // Validate required parameters
    if (!testId || !url || !browser) {
      throw new Error('Missing required parameters: testId, url, or browser');
    }

    // Check if test was cancelled before starting
    if (await this.checkTestCancelled(testId)) {
      logger.info(`[TEST-RUN] Test was cancelled before execution: ${testId} (${browser})`);
      throw new TestCancelledError(testId, browser);
    }

    // ✅ GUARD: Skip if test already finalized (prevents restart on BullMQ retry)
    // This protects against: stalled job retries, post-processing errors causing retries
    const existingTest = await dbAdminService.getTest(testId) as any;
    if (existingTest) {
      const finalStatuses = ['completed', 'failed', 'cancelled', 'timeout'];
      if (finalStatuses.includes(existingTest.status)) {
        logger.info(`[TEST-RUN] Test already finalized, skipping job execution`, {
          testId,
          browser,
          currentStatus: existingTest.status,
          jobId: job.id,
          jobAttempts: job.attemptsMade,
        });
        // Return without throwing - job completes as no-op
        return;
      }
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
      // Emit "queued → picked up" progress so frontend knows the job was dequeued
      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: 5,
          phase: 'initializing',
          currentStep: 'Preparing browser environment...',
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Update test status to running
      logger.info(`[TEST-RUN] Updating test status to running: ${testId}`);
      await this.updateTestStatus(testId, 'running', browser, new Date().toISOString());

      // Check again after status update (in case it was cancelled between checks)
      if (await this.checkTestCancelled(testId)) {
        logger.info(`[TEST-RUN] Test was cancelled after status update: ${testId} (${browser})`);
        throw new TestCancelledError(testId, browser);
      }

      // Emit WebSocket: test started
      this.emitTestStarted(testId, browser, chatSessionId);

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
          mode,
          // Resource bindings — applier injects cookies/env before step 1,
          // supervisor auto-heals if session drops mid-run.
          resourceBindings,
        },
        MAX_RETRIES
      );

      // Process result
      logger.info(`[TEST-RUN] Test execution completed: ${testId}`, {
        success: result.success,
        status: result.status,
      });

      if (result.success) {
        // ✅ FIX: Finalize test status FIRST (atomic) before any post-processing
        // This prevents re-execution if post-processing fails - guard at line 78-93 will see 'completed'
        try {
          await this.updateTestStatus(testId, 'completed', browser, undefined, new Date().toISOString());
          logger.info(`[TEST-RUN] Test status finalized to completed BEFORE post-processing: ${testId}`);
        } catch (statusError) {
          // Status update failed - log but continue with post-processing
          // Guard will still protect against re-execution via DB check
          logger.error(`[TEST-RUN] Failed to finalize test status, continuing with post-processing: ${testId}`, {
            error: statusError instanceof Error ? statusError.message : String(statusError),
          });
        }

        // ✅ FIX: Wrap post-processing in try-catch - errors here should NOT trigger job retry
        // Test execution was successful - errors in result saving are non-critical
        try {
          await this.handleSuccessfulTest(testId, browser, result);
        } catch (postProcessError) {
          logger.error(`[TEST-RUN] Post-processing failed but test was successful: ${testId}`, {
            testId,
            browser,
            error: postProcessError instanceof Error ? {
              message: postProcessError.message,
              name: postProcessError.name,
            } : String(postProcessError),
          });
          // Emit error event for frontend awareness
          this.emitResultError(testId, browser,
            postProcessError instanceof Error ? postProcessError : new Error(String(postProcessError))
          );
          // ✅ CRITICAL: Don't throw - job completes successfully, test was successful
          // Post-processing can be retried manually if needed
        }
      } else {
        // ✅ FIX: Don't throw exception - executePlaywrightTestWithRetry already exhausted all retries
        // Just handle the final failure result
        // ✅ IMPROVED: Log first error details for better debugging
        const firstError = result.errors?.[0];
        const errorDetails = firstError ? {
          type: firstError.type,
          message: firstError.message,
          stack: firstError.stack?.substring(0, 500), // Truncate stack for readability
        } : null;

        logger.error(`[TEST-RUN] Test execution failed after all retries: ${testId}`, {
          testId,
          browser,
          url,
          status: result.status,
          error: result.error,
          errorsCount: result.errors?.length || 0,
          firstError: errorDetails,
        });

        // Mark test as failed (final failure)
        await this.updateTestStatus(testId, 'failed', browser, undefined, new Date().toISOString());

        // ✅ FIX: Persist failed run data to DB (test_results) so frontend can still load artifacts/logs
        // This is best-effort and should not block failure handling.
        try {
          await this.handleFailedTest(testId, browser, result);
        } catch (persistError) {
          logger.error('[TEST-RUN] Failed to persist failed test result', {
            testId,
            browser,
            error: persistError instanceof Error ? persistError.message : String(persistError),
          });
        }

        // Emit WebSocket events for failure
        this.emitTestFailed(testId, browser, new Error(result.error || 'Test execution failed'));
        this.emitResultError(testId, browser, new Error(result.error || 'Test execution failed'));

        // Send failure notification
        await this.sendFailureNotification(testId, new Error(result.error || 'Test execution failed'));

        // Don't throw - this is the final result after all retries
        // BullMQ retry should NOT happen here - executePlaywrightTestWithRetry already did all retries
      }

      // Post-completion: update regression run status, chat notifications, test_executions.
      // Non-fatal: errors here must not break the job.
      try {
        const { TestCompletionHandlerService } = await import(
          '@/services/testing/results/test-completion-handler.service'
        );
        await TestCompletionHandlerService.handleTestCompletion(testId);
      } catch (completionError) {
        logger.warn('[TEST-RUN] Post-completion handler failed (non-fatal)', {
          testId,
          error: completionError instanceof Error ? completionError.message : String(completionError),
        });
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
      await this.updateTestStatus(testId, 'failed', browser, undefined, new Date().toISOString());

      // Send failure notification
      await this.sendFailureNotification(testId, error);

      throw handleAgentError(error as Error);
    }
  }

  /**
   * Update test status in database
   * ✅ FIX #5: Always check if test is cancelled before updating status
   */
  private static async updateTestStatus(
    testId: string,
    status: 'running' | 'completed' | 'failed',
    browser: string,
    startedAt?: string,
    completedAt?: string
  ) {
    const updateData: any = { status };
    if (startedAt) updateData.started_at = startedAt;
    if (completedAt) updateData.completed_at = completedAt;

    // ✅ FIX #5: Use updateTestIfNotCancelled for ALL status updates (not just 'running')
    // This prevents overwriting cancelled status with failed/completed
    const updated = await dbAdminService.updateTestIfNotCancelled(testId, updateData);
    if (!updated) {
      // Most likely cancelled (or deleted). Re-check and stop gracefully.
      if (await this.checkTestCancelled(testId)) {
        logger.info(`[TEST-RUN] Test is cancelled, skipping status update to ${status}: ${testId} (${browser})`);
        throw new TestCancelledError(testId, browser);
      }
      throw new Error(`Failed to update test status to ${status}: ${testId}`);
    }
  }

  /**
   * Emit test started WebSocket event
   */
  private static emitTestStarted(testId: string, browser: string, chatSessionId?: string) {
    const payload: TestStartedPayload = {
      testId,
      browser,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
      source: chatSessionId ? 'chat' : 'regression',
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

    try {
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
        quality_checks: result.qualityChecks, // Non-UI quality checks (Web Vitals, a11y, broken resources, slow APIs)
        video_url: result.videoUrl, // Supabase Storage URL
        trace_url: result.traceUrl, // Supabase Storage URL
        replay_trace_url: result.replayTraceUrl, // V14: Replay trace JSONL URL
        completed_at: new Date().toISOString(),
      });

      // ✅ FIX: Validate testResultRecord before using
      if (!testResultRecord || !(testResultRecord as any).id) {
        logger.error(`[TEST-RUN] Failed to create test result - invalid response: ${testId} (${browser})`, {
          testId,
          browser,
          testResultRecord: testResultRecord ? 'exists but no id' : 'null/undefined',
        });
        throw new Error(`Failed to create test result for ${testId} (${browser}) - invalid response from database`);
      }

      const resultId = (testResultRecord as any).id;

      // Emit WebSocket: browser completed
      const browserCompletedPayload: TestBrowserCompletedPayload = {
        testId,
        browser,
        status: 'completed',
        errorsCount: result.errors?.length || 0,
        // V16: Surface credits exhaustion so frontend can show refill banner
        ...(result.creditsExhausted ? { creditsExhausted: true } : {}),
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitTestBrowserCompleted(testId, browserCompletedPayload);

      // Emit WebSocket: result ready (success case)
      const resultReadyPayload: ResultReadyPayload = {
        testId,
        browser,
        resultId,
        status: 'completed', // ✅ NEW: Indicate success
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitResultReady(testId, resultReadyPayload);

      // ✅ FIX: Use testResultRecord.id directly instead of querying DB again
      // This eliminates duplicate DB query and potential race condition
      try {
        await QueueManager.addAIAnalysisJob(resultId, testId);
        logger.info(`[TEST-RUN] AI analysis job queued for test result: ${resultId}`);
      } catch (aiJobError) {
        // ✅ FIX: Don't fail the whole method if AI analysis job fails
        // Test is successful, AI analysis is not critical for basic functionality
        logger.error(`[TEST-RUN] Failed to queue AI analysis job: ${testId}`, {
          error: aiJobError instanceof Error ? aiJobError.message : String(aiJobError),
          resultId,
          testId,
          browser,
        });
        // Continue execution - test result is saved, WebSocket events sent
      }

      // ///improvement: Update overall test status synchronously to prevent race condition
      // This ensures test status is updated immediately after result is created
      try {
        await ManualTestResultJobHandler.updateOverallTestStatus(testId);
      } catch (statusError) {
        // ✅ FIX: Don't fail the whole method if status update fails
        // Test result is already saved, status update can be retried
        logger.error(`[TEST-RUN] Failed to update overall test status: ${testId}`, {
          error: statusError instanceof Error ? statusError.message : String(statusError),
          testId,
          browser,
        });
        // Continue execution - test result is saved
      }

      // Persist test_resources snapshot (Login, Environment, ...) onto
      // the matching test_executions row(s). Fire-and-forget internally —
      // we don't retry because the row may not exist (standalone test,
      // not part of a regression run), which is legitimate.
      if (result.executedResources && result.executedResources.length > 0) {
        try {
          const { ExecutionService } = await import('@/services/testing/executions/execution.service');
          await ExecutionService.persistExecutedResourcesByTestId(
            testId,
            result.executedResources,
          );
        } catch {
          // non-fatal — persist helper already swallows, this try just
          // protects against import failure
        }
      }

      logger.info(`[TEST-RUN] Test completed successfully: ${testId}`, {
        browser,
        logsCount: result.logs?.length || 0,
        errorsCount: result.errors?.length || 0,
      });

    } catch (error) {
      // ✅ FIX: Handle errors during test result creation
      logger.error(`[TEST-RUN] Failed to handle successful test: ${testId} (${browser})`, {
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
        testId,
        browser,
      });

      // Emit WebSocket error event
      this.emitResultError(testId, browser, error instanceof Error ? error : new Error(String(error)));

      // Re-throw to let caller handle it (will be caught in process() method)
      throw error;
    }
  }

  /**
   * Handle failed test completion
   * Persists test_results row and emits browser/result events so frontend can fetch data even on failures.
   *
   * @param testId - UUID of test
   * @param browser - Browser name
   * @param result - Agent result payload
   */
  private static async handleFailedTest(testId: string, browser: string, result: any): Promise<void> {
    logger.info('[TEST-RUN] Persisting failed test result to database', {
      testId,
      browser,
      status: result?.status,
    });

    // Create test result in database (failed run)
    const testResultRecord = await dbAdminService.createTestResult({
      test_id: testId,
      browser,
      status: (result?.status || 'failed') as any,
      screenshot: result?.screenshot,
      dom: result?.dom,
      logs: result?.logs || [],
      network_logs: result?.networkLogs || [],
      errors: result?.errors || [],
      performance: result?.performance,
      quality_checks: result?.qualityChecks, // Non-UI quality checks
      video_url: result?.videoUrl, // Supabase Storage URL (even for failed tests)
      trace_url: result?.traceUrl, // Supabase Storage URL (even for failed tests)
      replay_trace_url: result?.replayTraceUrl, // V14: Replay trace JSONL URL (especially important for failed tests)
      completed_at: new Date().toISOString(),
    });

    if (!testResultRecord || !(testResultRecord as any).id) {
      throw new Error(`Failed to create failed test result for ${testId} (${browser}) - invalid response from database`);
    }

    const resultId = (testResultRecord as any).id;

    // Emit WebSocket: browser completed (failed)
    const browserCompletedPayload: TestBrowserCompletedPayload = {
      testId,
      browser,
      status: 'failed',
      errorsCount: result?.errors?.length || 0,
      timestamp: new Date().toISOString(),
    };
    webSocketService.emitTestBrowserCompleted(testId, browserCompletedPayload);

    // Emit WebSocket: result ready (so frontend can fetch DB record even on failure)
    const resultReadyPayload: ResultReadyPayload = {
      testId,
      browser,
      resultId,
      status: 'failed', // ✅ NEW: Indicate failure
      timestamp: new Date().toISOString(),
    };
    webSocketService.emitResultReady(testId, resultReadyPayload);

    // Queue AI analysis (best-effort) - can be helpful even for failures
    try {
      await QueueManager.addAIAnalysisJob(resultId, testId);
    } catch (aiJobError) {
      logger.error('[TEST-RUN] Failed to queue AI analysis job for failed result', {
        testId,
        browser,
        resultId,
        error: aiJobError instanceof Error ? aiJobError.message : String(aiJobError),
      });
    }

    // Update overall test status (best-effort)
    try {
      await ManualTestResultJobHandler.updateOverallTestStatus(testId);
    } catch (statusError) {
      logger.error('[TEST-RUN] Failed to update overall test status after failed result', {
        testId,
        browser,
        error: statusError instanceof Error ? statusError.message : String(statusError),
      });
    }

    // Persist test_resources snapshot on failure too — diagnosing a
    // failed run needs to know which Login / Env was live when it broke.
    if (result?.executedResources && result.executedResources.length > 0) {
      try {
        const { ExecutionService } = await import('@/services/testing/executions/execution.service');
        await ExecutionService.persistExecutedResourcesByTestId(
          testId,
          result.executedResources,
        );
      } catch {
        // non-fatal
      }
    }
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

      // ✅ FIX: Don't send notification for cancelled tests
      if (test.status === 'cancelled') {
        logger.debug(`[TEST-RUN] Skipping failure notification for cancelled test: ${testId}`);
        return;
      }

      const errorMessage = (error as Error).message || 'Unknown error occurred';
      logger.info(`[TEST-RUN] Sending failure notification for test: ${testId}`);

      // Resolve recipient email (test.user_id is a UUID, not an email)
      let recipient = DEFAULT_ADMIN_EMAIL;
      if (test.user_id) {
        try {
          const user: any = await dbAdminService.getUser(test.user_id);
          if (user?.email && typeof user.email === 'string') {
            recipient = user.email;
          } else {
            logger.warn(`[TEST-RUN] User has no email, sending notification to default email: ${testId}`, {
              userId: test.user_id,
            });
          }
        } catch (userError) {
          logger.warn(`[TEST-RUN] Failed to resolve user email, sending notification to default email: ${testId}`, {
            userId: test.user_id,
            error: userError instanceof Error ? userError.message : String(userError),
          });
        }
      } else {
        logger.warn(`[TEST-RUN] Test has no user_id, sending notification to default email: ${testId}`);
      }

      // Build rich email
      const { EmailService } = await import('@/services/core/email.service');
      const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
      const email = EmailService.buildTestFailedEmail({
        testId,
        testUrl: test.url || 'Unknown URL',
        errorMessage,
        browsers: test.browsers || [],
        startedAt: test.started_at,
        failedAt: test.completed_at || new Date().toISOString(),
        dashboardUrl: `${frontendUrl}/tests/${testId}`,
      });

      // Send email notification
      await QueueManager.addNotificationJob({
        type: 'email',
        recipient,
        subject: email.subject,
        message: email.text,
        htmlContent: email.html,
        data: { testId, error: errorMessage },
      });

      // Send Telegram notification (if user has it connected)
      if (test.user_id) {
        try {
          const { getTelegramToken, sendTelegramNotification } = await import('@/utils/notifications/telegram-notify');
          const tokenData = await getTelegramToken(test.user_id);
          if (tokenData?.external_id) {
            const testUrl = test.url || 'Unknown URL';
            const dashboardUrl = `${frontendUrl}/tests/${testId}`;

            // Duration
            let duration = '';
            if (test.started_at) {
              const endTime = test.completed_at || new Date().toISOString();
              const secs = Math.floor((new Date(endTime).getTime() - new Date(test.started_at).getTime()) / 1000);
              duration = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
            }

            await sendTelegramNotification(tokenData, {
              icon: '\u274C',
              title: 'Test Failed',
              fields: [
                { label: 'URL', value: testUrl },
                { label: 'Browsers', value: (test.browsers || []).join(', ') || '—' },
                ...(duration ? [{ label: 'Duration', value: duration }] : []),
              ],
              error: errorMessage,
              ctaLabel: 'View test results \u2192',
              ctaUrl: dashboardUrl,
            });
            logger.info(`[TEST-RUN] Sent Telegram failure notification for test: ${testId}`);
          }
        } catch (tgError) {
          logger.warn(`[TEST-RUN] Failed to send Telegram notification for test ${testId}:`, {
            error: tgError instanceof Error ? tgError.message : String(tgError),
          });
        }
      }
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
      // Get test details to check expected browsers
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) {
        logger.warn(`[TEST-RESULT] Test not found for status update: ${testId}`);
        return;
      }

      // Don't re-run finalization once it's already fully completed.
      // This prevents duplicate test:completed emits and redundant DB writes.
      if (test.status === 'completed') {
        logger.debug(`[TEST-RESULT] Skipping status update for already completed test: ${testId}`);
        return;
      }

      // Never override cancelled tests
      if (test.status === 'cancelled') {
        logger.info(`[TEST-RESULT] Skipping status update for cancelled test: ${testId}`);
        return;
      }

      // Get all results for this test
      const results = await dbAdminService.getTestResults(testId) as any[];

      // Filter out null/undefined results
      const validResults = (results || []).filter((r: any) => r && r.status && r.browser);

      if (validResults.length === 0) {
        logger.debug(`[TEST-RESULT] No valid results found for test: ${testId}`);
        return;
      }

      // Expected browsers from the test row
      const expectedBrowsers: string[] = Array.isArray(test.browsers) ? test.browsers : [];
      const expectedBrowsersCount = expectedBrowsers.length;

      // Use latest result per browser (results are ordered desc by created_at)
      const latestByBrowser = new Map<string, any>();
      for (const r of validResults) {
        if (!latestByBrowser.has(r.browser)) {
          latestByBrowser.set(r.browser, r);
        }
      }

      const hasAllResults =
        expectedBrowsersCount > 0 &&
        expectedBrowsers.every((b) => latestByBrowser.has(b));

      const latestResults = Array.from(latestByBrowser.values());
      // ✅ FIX #8: Include 'cancelled' and 'timeout' in final results
      const finalResults = latestResults.filter((r: any) =>
        r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled' || r.status === 'timeout'
      );

      // Determine overall test status
      // ✅ FIX #8: Priority: cancelled > timeout > failed > completed
      const hasCancelled = finalResults.some((r: any) => r.status === 'cancelled');
      const hasTimeout = finalResults.some((r: any) => r.status === 'timeout');
      const hasFailed = finalResults.some((r: any) => r.status === 'failed' || r.status === 'timeout');
      const allCompleted = hasAllResults && finalResults.length === expectedBrowsersCount;

      let status: 'running' | 'completed' | 'failed' | 'cancelled' = 'running';

      if (allCompleted) {
        // ✅ FIX #8: Determine final status based on priority
        if (hasCancelled) {
          status = 'cancelled';
        } else if (hasFailed) {
          status = 'failed';
        } else {
          status = 'completed';
        }
      } else if (hasAllResults && finalResults.length < expectedBrowsersCount) {
        // ✅ FIX: Some browsers are still running/pending
        status = 'running';
      }

      logger.info(`[TEST-RESULT] Updating overall test status: ${testId} -> ${status}`, {
        expectedBrowsers: expectedBrowsersCount,
        actualResults: latestResults.length,
        finalStatusResults: finalResults.length,
        hasFailed,
        allCompleted,
      });

      // Update test status
      await dbAdminService.updateTest(testId, {
        status,
        completed_at: allCompleted ? new Date().toISOString() : undefined,
      });

      // ✅ NEW: Emit test:completed ONLY when final status is truly 'completed'
      // (failed/cancelled have their own events and may already be emitted earlier).
      if (allCompleted && status === 'completed') {
        const completedBrowsers = finalResults.length;
        const failedBrowsers = latestResults.filter((r: any) => r.status === 'failed').length;

        const payload: TestCompletedPayload = {
          testId,
          status: 'completed',
          totalBrowsers: expectedBrowsersCount,
          completedBrowsers,
          failedBrowsers,
          timestamp: new Date().toISOString(),
        };

        webSocketService.emitTestCompleted(testId, payload);
      }

      // Note: Regression run status update + chat notifications are handled in process()
      // via TestCompletionHandlerService.handleTestCompletion() after both success/failure branches.

    } catch (error) {
      logger.error(`[TEST-RESULT] Failed to update test status for ${testId}:`, {
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
        testId,
      });
    }
  }
}
