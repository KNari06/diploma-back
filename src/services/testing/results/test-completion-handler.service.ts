import { supabaseAdmin } from '@/db/supabase';
import { TestResultsFormatterService } from '@/services/testing/results/test-results-formatter.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';
import { NotificationService } from '@/services/notifications/notification.service';
import { getTelegramToken, sendMessage as sendTelegramMessage } from '@/services/api/telegram.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST COMPLETION HANDLER SERVICE - Post-test completion pipeline
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles test completion workflow:
 * 1. Notifies linked chat sessions with formatted results
 * 2. Updates regression run statuses (if test was part of regression)
 * 3. Includes test metadata for AI context enrichment
 *
 * Called by:
 * - BullMQ job handlers when tests complete
 * - Manual test completion hooks
 *
 * Key Features:
 * - Chat notification with rich metadata
 * - Automatic regression run status updates
 * - Support for both single test and batch runs
 */

/**
 * Service to handle test completion and notify chat sessions
 */
export class TestCompletionHandlerService {
  /**
   * Handle test completion and send results to chat
   * Main entry point called when a test finishes execution
   *
   * @param testId - UUID of completed test
   * @returns void (errors are logged but not thrown)
   */
  static async handleTestCompletion(testId: string): Promise<void> {
    try {
      logger.info('[TEST_COMPLETION] Handling test completion', { testId });

      // Get chat sessions linked to this test
      const chatSessions = await TestChatMappingService.getChatSessionsForTest(
        testId
      );

      if (!chatSessions || chatSessions.length === 0) {
        logger.debug('[TEST_COMPLETION] No chat sessions found for test', {
          testId,
        });
        // Continue to update regression runs even if no chat sessions
      }

      // ✅ FIX #8: Get test data with proper field selection (including user_id for notifications)
      const { data: test, error: testError } = await supabaseAdmin
        .from('tests')
        .select('id, url, status, browsers, user_id, project_id, created_at, completed_at')
        .eq('id', testId)
        .single();

      if (testError || !test) {
        logger.error('[TEST_COMPLETION] Failed to get test', {
          error: testError?.message,
          testId,
        });
        return;
      }

      // ✅ FIX #9: Get test results with proper field selection
      const { data: results, error: resultsError } = await supabaseAdmin
        .from('test_results')
        .select(
          'id, test_id, browser, status, errors, created_at, completed_at'
        ) // ✅ Select only needed fields
        .eq('test_id', testId); // ✅ Correct field name: test_id (not testId)

      if (resultsError) {
        logger.error('[TEST_COMPLETION] Failed to get results', {
          error: resultsError,
          testId,
        });
        // Continue without results (will use test status)
      }

      // Send to linked chat sessions (if any)
      if (chatSessions && chatSessions.length > 0) {
        // Format results as chat message
        const formattedMessage = TestResultsFormatterService.formatTestResults(
          test,
          results || []
        );

        // ✅ FIX: Include test results in metadata so AI can see them
        const testResultMetadata = {
          testId: testId,
          testType: 'ui',
          testResult: {
            status: test.status,
            url: test.url,
            browsers: test.browsers,
            completedAt: test.completed_at,
            results: (results || []).map(r => ({
              browser: r.browser,
              status: r.status,
              errors: r.errors,
              completedAt: r.completed_at,
            })),
          },
        };

        // Send to all linked chat sessions
        for (const chatSessionId of chatSessions) {
          try {
            await ChatService.saveChatMessages(chatSessionId, [
              {
                role: 'ai',
                content: formattedMessage,
                metadata: testResultMetadata,
              },
            ]);

            logger.info('[TEST_COMPLETION] Results sent to chat', {
              testId,
              chatSessionId,
            });
          } catch (chatError) {
            logger.error('[TEST_COMPLETION] Failed to send results to chat', {
              error: chatError,
              testId,
              chatSessionId,
            });
            // Continue with other sessions
          }
        }
      } else {
        // No chat sessions = background/CI run → create in-app notification
        await this.createBackgroundTestNotification(test, results || []);
      }

      // Update regression runs associated with this test
      // Also update unified test_executions records linked to this UI test
      await this.updateTestExecutionsForCompletedUiTest(test);
      await this.updateRegressionRuns(testId);
    } catch (error) {
      logger.error('[TEST_COMPLETION] Unexpected error', { error, testId });
    }
  }

  /**
   * Create in-app notification for background test completion
   * Only called when test has no linked chat sessions (background/CI run)
   */
  private static async createBackgroundTestNotification(
    test: any,
    results: any[]
  ): Promise<void> {
    try {
      if (!test.user_id) {
        logger.debug('[TEST_COMPLETION] No user_id, skipping notification', {
          testId: test.id,
        });
        return;
      }

      // Count errors across all results
      const errorsCount = results.reduce((sum, r) => {
        return sum + (Array.isArray(r.errors) ? r.errors.length : 0);
      }, 0);

      // Count failed browsers
      const failedBrowsers = results.filter(
        (r) => r.status === 'failed' || r.status === 'timeout'
      ).length;

      // Determine notification title and message based on status
      let title = '';
      let message = '';
      const status = test.status;

      if (status === 'completed') {
        if (errorsCount > 0 || failedBrowsers > 0) {
          title = 'Background test completed with issues';
          message = `Test completed with ${errorsCount} error(s) across ${failedBrowsers} browser(s)`;
        } else {
          title = 'Background test completed successfully';
          message = `Test completed successfully across ${results.length} browser(s)`;
        }
      } else if (status === 'failed') {
        title = 'Background test failed';
        message = `Test failed with ${errorsCount} error(s)`;
      } else if (status === 'cancelled') {
        title = 'Background test cancelled';
        message = 'Test was cancelled before completion';
      } else {
        // Unknown status, skip notification
        return;
      }

      // Create notification
      await NotificationService.createNotification({
        userId: test.user_id,
        type: 'personal',
        category: 'test',
        title,
        message,
        metadata: {
          testId: test.id,
          status: test.status,
          url: test.url,
          browsers: test.browsers,
          errorsCount,
          failedBrowsers,
          totalBrowsers: results.length,
          completedAt: test.completed_at,
          dedupeKey: `test:${test.id}:${status}`,
        },
      });

      logger.info('[TEST_COMPLETION] Created background test notification', {
        testId: test.id,
        userId: test.user_id,
        status: test.status,
      });
    } catch (error) {
      logger.error('[TEST_COMPLETION] Failed to create background test notification', {
        error: error instanceof Error ? error.message : String(error),
        testId: test.id,
      });
      // Don't throw - notification failure shouldn't break test completion
    }
  }

  /**
   * Update unified test_executions rows that reference a completed UI test via result->>testId.
   * This enables unified reporting for runs that mix UI and API tests.
   */
  private static async updateTestExecutionsForCompletedUiTest(test: {
    id: string;
    status: string;
    created_at?: string;
    completed_at?: string;
  }): Promise<void> {
    try {
      const testId = test.id;

      const mappedStatus =
        test.status === 'completed'
          ? 'passed'
          : test.status === 'failed' || test.status === 'timeout'
            ? 'failed'
            : test.status === 'cancelled'
              ? 'cancelled'
              : test.status === 'running' || test.status === 'pending'
                ? 'running'
                : 'failed';

      const durationMs =
        test.created_at && test.completed_at
          ? Math.max(0, new Date(test.completed_at).getTime() - new Date(test.created_at).getTime())
          : undefined;

      const { data, error } = await supabaseAdmin
        .from('test_executions')
        .update({
          status: mappedStatus,
          completed_at: test.completed_at || new Date().toISOString(),
          duration_ms: durationMs,
        })
        .eq('result->>testId', testId)
        .select('id');

      if (error) {
        logger.warn('[TEST_COMPLETION] Failed to update test_executions for UI test', {
          error,
          testId,
        });
        return;
      }

      if (data && data.length > 0) {
        logger.info('[TEST_COMPLETION] Updated test_executions for UI test', {
          testId,
          updatedCount: data.length,
          mappedStatus,
        });
      }
    } catch (error) {
      logger.warn('[TEST_COMPLETION] Error updating test_executions for UI test', {
        error: error instanceof Error ? error.message : String(error),
        testId: test?.id,
      });
    }
  }

  /**
   * Update regression runs that reference this test
   * Recomputes run status based on underlying test results
   *
   * Called automatically after test completion to keep regression_runs.status in sync
   *
   * @param testId - UUID of completed test
   * @param testStatus - Status of completed test ('completed', 'failed', etc.)
   */
  private static async updateRegressionRuns(
    testId: string
  ): Promise<void> {
    try {
      // Find regression runs that reference this test
      // Either directly (test_id) or in a batch (test_ids array)
      const { data: runs, error: runsError } = await supabaseAdmin
        .from('regression_runs')
        .select('id, saved_test_case_id, test_id, test_ids, status, user_id, trigger, plan_id')
        .or(`test_id.eq.${testId},test_ids.cs.["${testId}"]`)
        .in('status', ['running']); // Only update runs that are still in progress

      if (runsError) {
        logger.error('[TEST_COMPLETION] Failed to find regression runs', {
          error: runsError,
          testId,
        });
        return;
      }

      if (!runs || runs.length === 0) {
        logger.debug('[TEST_COMPLETION] No regression runs found for test', {
          testId,
        });
        return;
      }

      logger.info('[TEST_COMPLETION] Found regression runs to update', {
        testId,
        runsCount: runs.length,
      });

      // Update each run
      for (const run of runs) {
        await this.recomputeRunStatus(run);
      }
    } catch (error) {
      logger.error('[TEST_COMPLETION] Error updating regression runs', {
        error: error instanceof Error ? error.message : String(error),
        testId,
      });
    }
  }

  /**
   * Create in-app notification + Telegram for regression run completion
   * Called for ALL trigger types (manual, chat, scheduled, webhook)
   */
  private static async createRegressionRunNotification(
    run: any,
    finalStatus: 'completed' | 'failed' | 'cancelled',
    summary: any
  ): Promise<void> {
    try {
      if (!run.user_id) {
        logger.debug('[TEST_COMPLETION] No user_id for regression run, skipping notification', {
          runId: run.id,
        });
        return;
      }

      // Check if plan has notifications disabled
      if (run.plan_id) {
        const { data: plan } = await supabaseAdmin
          .from('regression_plans')
          .select('notifications_enabled')
          .eq('id', run.plan_id)
          .maybeSingle();

        if (plan && plan.notifications_enabled === false) {
          logger.debug('[TEST_COMPLETION] Notifications disabled for plan, skipping', {
            runId: run.id,
            planId: run.plan_id,
          });
          return;
        }
      }

      // Determine trigger label
      const triggerLabels: Record<string, string> = {
        scheduled: 'Scheduled',
        webhook: 'Git-triggered',
        manual: 'Manual',
        chat: 'Chat-triggered',
      };
      const triggerLabel = triggerLabels[run.trigger] || 'Automated';

      // Determine notification title and message
      let title = '';
      let message = '';

      if (finalStatus === 'completed') {
        const failedCount = summary.failed || 0;
        if (failedCount > 0) {
          title = `${triggerLabel} regression completed with failures`;
          message = `Regression run completed: ${summary.passed || 0} passed, ${failedCount} failed`;
        } else {
          title = `${triggerLabel} regression completed successfully`;
          message = `All ${summary.total || 0} test(s) passed successfully`;
        }
      } else if (finalStatus === 'failed') {
        title = `${triggerLabel} regression failed`;
        message = `Regression run failed: ${summary.failed || 0} test(s) failed`;
      } else if (finalStatus === 'cancelled') {
        title = `${triggerLabel} regression cancelled`;
        message = 'Regression run was cancelled before completion';
      }

      // Create in-app notification
      await NotificationService.createNotification({
        userId: run.user_id,
        type: 'personal',
        category: 'test',
        title,
        message,
        metadata: {
          runId: run.id,
          status: finalStatus,
          summary,
          trigger: run.trigger,
          dedupeKey: `regression:${run.id}:${finalStatus}`,
        },
      });

      logger.info('[TEST_COMPLETION] Created regression run notification', {
        runId: run.id,
        userId: run.user_id,
        status: finalStatus,
        trigger: run.trigger,
      });

      // Send Telegram notification
      await this.sendTelegramNotification(run.user_id, title, message, run.id);
    } catch (error) {
      logger.error('[TEST_COMPLETION] Failed to create regression run notification', {
        error: error instanceof Error ? error.message : String(error),
        runId: run.id,
      });
      // Don't throw - notification failure shouldn't break run completion
    }
  }

  /**
   * Send Telegram notification for regression run completion
   * Failures are logged but never thrown (don't break completion pipeline)
   */
  private static async sendTelegramNotification(
    userId: string,
    title: string,
    message: string,
    runId: string
  ): Promise<void> {
    try {
      const tokenData = await getTelegramToken(userId);
      if (!tokenData || !tokenData.external_id) {
        // User has no Telegram integration or no chat_id configured
        return;
      }

      const htmlMessage = `<b>${title}</b>\n\n${message}\n\n<i>Run ID: ${runId}</i>`;

      await sendTelegramMessage(tokenData.access_token, tokenData.external_id, htmlMessage, 'HTML');

      logger.info('[TEST_COMPLETION] Sent Telegram notification', {
        userId,
        runId,
        chatId: tokenData.external_id,
      });
    } catch (error) {
      logger.warn('[TEST_COMPLETION] Failed to send Telegram notification', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        runId,
      });
      // Don't throw - Telegram failure shouldn't break completion pipeline
    }
  }

  /**
   * Recompute status for a regression run based on underlying tests
   * Determines if all tests are complete and calculates final status
   *
   * Logic:
   * - If any test is cancelled → run is 'cancelled'
   * - Else if any test failed/timeout → run is 'failed'
   * - Else if all completed → run is 'completed'
   * - If some tests still running → no update (wait for completion)
   *
   * @param run - Regression run record with test_id or test_ids
   */
  private static async recomputeRunStatus(run: any): Promise<void> {
    try {
      // Prefer unified executions if present (covers UI + API and avoids relying only on tests table)
      const { data: unifiedExecutions, error: execError } = await supabaseAdmin
        .from('test_executions')
        .select('status')
        .eq('run_id', run.id);

      if (execError) {
        logger.warn('[TEST_COMPLETION] Failed to load test_executions for run, falling back', {
          error: execError,
          runId: run.id,
        });
      } else if (unifiedExecutions && unifiedExecutions.length > 0) {
        const statuses = unifiedExecutions.map((e: any) => e.status);

        const hasRunning = statuses.some((s: string) => s === 'running' || s === 'pending');
        if (hasRunning) {
          logger.debug('[TEST_COMPLETION] Run still has running executions', {
            runId: run.id,
            runningCount: statuses.filter((s: string) => s === 'running' || s === 'pending').length,
          });
          return;
        }

        let finalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
        if (statuses.some((s: string) => s === 'cancelled')) {
          finalStatus = 'cancelled';
        } else if (statuses.some((s: string) => s === 'failed')) {
          finalStatus = 'failed';
        }

        const summary = {
          total: statuses.length,
          passed: statuses.filter((s: string) => s === 'passed').length,
          failed: statuses.filter((s: string) => s === 'failed').length,
          skipped: statuses.filter((s: string) => s === 'skipped').length,
          cancelled: statuses.filter((s: string) => s === 'cancelled').length,
          completed_at: new Date().toISOString(),
        };

        const { error: updateError } = await supabaseAdmin
          .from('regression_runs')
          .update({
            status: finalStatus,
            summary,
            completed_at: new Date().toISOString(),
          })
          .eq('id', run.id);

        if (updateError) {
          logger.error('[TEST_COMPLETION] Failed to update regression run (unified)', {
            error: updateError,
            runId: run.id,
            finalStatus,
          });
        } else {
          logger.info('[TEST_COMPLETION] Regression run updated (unified)', {
            runId: run.id,
            status: finalStatus,
            summary,
          });
          
          // Create notification for regression run
          await this.createRegressionRunNotification(run, finalStatus, summary);
        }

        return;
      }

      let underlyingTestIds: string[] = [];

      // Determine which test IDs to check
      if (run.test_id) {
        // Single test case run
        underlyingTestIds = [run.test_id];
      } else if (run.test_ids && Array.isArray(run.test_ids)) {
        // Batch run
        underlyingTestIds = run.test_ids;
      } else {
        logger.warn('[TEST_COMPLETION] Run has no test_id or test_ids', { runId: run.id });
        return;
      }

      // Get all underlying test statuses
      const { data: tests, error: testsError } = await supabaseAdmin
        .from('tests')
        .select('id, status')
        .in('id', underlyingTestIds);

      if (testsError || !tests) {
        logger.error('[TEST_COMPLETION] Failed to get underlying tests', {
          error: testsError,
          runId: run.id,
          testIds: underlyingTestIds,
        });
        return;
      }

      // ✅ Validation: Check if we got all expected tests
      if (tests.length !== underlyingTestIds.length) {
        logger.warn('[TEST_COMPLETION] Missing some underlying tests', {
          runId: run.id,
          expected: underlyingTestIds.length,
          found: tests.length,
        });
      }

      // Check if all tests are complete
      const statuses = tests.map(t => t.status);
      const hasRunning = statuses.some(s => s === 'running' || s === 'pending');

      if (hasRunning) {
        logger.debug('[TEST_COMPLETION] Run still has running tests', {
          runId: run.id,
          runningCount: statuses.filter(s => s === 'running' || s === 'pending')
            .length,
        });
        return; // Don't update yet
      }

      // All tests are complete - compute final status
      let finalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';

      if (statuses.some(s => s === 'cancelled')) {
        finalStatus = 'cancelled';
      } else if (statuses.some(s => s === 'failed' || s === 'timeout')) {
        finalStatus = 'failed';
      }

      // Count results
      const passed = statuses.filter(s => s === 'completed').length;
      const failed = statuses.filter(s => s === 'failed' || s === 'timeout').length;
      const cancelled = statuses.filter(s => s === 'cancelled').length;

      // Build summary
      const summary = {
        total: tests.length,
        passed,
        failed,
        cancelled,
        test_ids: tests.map(t => t.id),
        completed_at: new Date().toISOString(),
      };

      // Update regression run
      const { error: updateError } = await supabaseAdmin
        .from('regression_runs')
        .update({
          status: finalStatus,
          summary,
          completed_at: new Date().toISOString(),
        })
        .eq('id', run.id);

      if (updateError) {
        logger.error('[TEST_COMPLETION] Failed to update regression run', {
          error: updateError,
          runId: run.id,
          finalStatus,
        });
      } else {
        logger.info('[TEST_COMPLETION] Regression run updated', {
          runId: run.id,
          status: finalStatus,
          summary,
        });
        
        // Create notification for regression run
        await this.createRegressionRunNotification(run, finalStatus, summary);
      }
    } catch (error) {
      logger.error('[TEST_COMPLETION] Error recomputing run status', {
        error: error instanceof Error ? error.message : String(error),
        runId: run?.id || 'unknown',
      });
    }
  }
}
