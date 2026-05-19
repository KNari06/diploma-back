import { supabaseAdmin } from '@/db/supabase';
import { executionCompletionEmitter } from '@/services/testing/executions/execution-completion-emitter';
import { TestResultsFormatterService } from '@/services/testing/results/test-results-formatter.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { SaveSuggestionMeta } from '@/types/testing.types';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { NotificationService } from '@/services/notifications/notification.service';
import { getTelegramToken, sendMessage as sendTelegramMessage } from '@/services/api/telegram.service';
import { webSocketService } from '@/websocket/core/websocket.service';
import type { RegressionRunProgressPayload } from '@/websocket/types/types';
import { env } from '@/config/environment/env';
import { AutomationActionService } from '@/services/automation/automation-action.service';
import { getProjectWorkspaceMemberIds } from '@/services/testing/regression/regression-run.service';
import * as crypto from 'crypto';

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
  /** Per-run cache for workspace member IDs — avoids re-querying on every test_completed event within the same run. */
  private static _runRecipientCache = new Map<string, { recipients: string[]; ts: number }>();

  /** Resolve WS recipients for a run (cached for 60s to avoid N+1 queries). */
  private static async getRunRecipients(
    runId: string,
    userId: string
  ): Promise<{ recipients: string[]; planId: string | null; projectId: string | null; trigger?: RegressionRunProgressPayload['trigger'] }> {
    const cached = this._runRecipientCache.get(runId);
    if (cached && Date.now() - cached.ts < 60_000) {
      // Still need run metadata — pull from first resolution
      // Cache stores only recipients; metadata comes from the DB query below (lightweight)
    }

    const { data: runRow } = await supabaseAdmin
      .from('regression_runs')
      .select('plan_id, project_id, trigger')
      .eq('id', runId)
      .maybeSingle();

    const planId = (runRow?.plan_id as string | null) ?? null;
    const projectId = (runRow?.project_id as string | null) ?? null;
    const trigger = (runRow as any)?.trigger as RegressionRunProgressPayload['trigger'] | undefined;

    let recipients: string[];
    if (cached && Date.now() - cached.ts < 60_000) {
      recipients = cached.recipients;
    } else if (projectId) {
      recipients = await getProjectWorkspaceMemberIds(projectId, userId);
      this._runRecipientCache.set(runId, { recipients, ts: Date.now() });
      // Prevent unbounded growth
      if (this._runRecipientCache.size > 200) {
        const oldest = [...this._runRecipientCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) this._runRecipientCache.delete(oldest[0]);
      }
    } else {
      recipients = [userId];
    }

    return { recipients, planId, projectId, trigger };
  }

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
      // V11: Include executed_steps so formatter can show step-level failure reasons
      const { data: test, error: testError } = await supabaseAdmin
        .from('tests')
        .select('id, url, status, browsers, user_id, project_id, created_at, completed_at, executed_steps')
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
        let formattedMessage = TestResultsFormatterService.formatTestResults(
          test,
          results || []
        );

        // ✅ FIX: Include test results in metadata so AI can see them
        const testResultMetadata: Record<string, any> = {
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

        // Check if should suggest saving as test case
        try {
          if (await this.shouldSuggestSave(testId, test.status)) {
            formattedMessage +=
              '\n\n---\n💾 **Want to save this test as a reusable test case?**\n' +
              'It can be rerun later without re-analysis.';
            const saveSuggestion: SaveSuggestionMeta = {
              available: true,
              testId,
              buttonLabel: 'Save as Test Case',
              buttonAction: { intent: 'save_test', sourceTestId: testId },
            };
            testResultMetadata.saveSuggestion = saveSuggestion;
          }
        } catch (err) {
          logger.warn('[TEST_COMPLETION] Save suggestion check failed', {
            error: err instanceof Error ? err.message : String(err), testId,
          });
        }

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

            // Emit real-time WebSocket event so chat UI updates instantly
            try {
              webSocketService.emitChatMessage(chatSessionId, {
                sessionId: chatSessionId,
                messageId: `test-result-${testId}`,
                role: 'assistant',
                content: formattedMessage,
                timestamp: new Date().toISOString(),
              });
            } catch (wsError) {
              logger.warn('[TEST_COMPLETION] Failed to emit chat:message WebSocket event', {
                testId, chatSessionId,
                error: wsError instanceof Error ? wsError.message : String(wsError),
              });
            }

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

      // Invalidate visualization overall cache (test completion changes the planet view)
      if (test.project_id) {
        await cache.delByPattern(`qait:cache:vizoverall:${test.project_id}:*`);
      }

      // Fire automation actions for test-level events (non-blocking)
      AutomationActionService.fireEvent({
        triggerEvent: test.status === 'failed' ? 'test_failed' : 'test_completed',
        sourceEntityType: 'test',
        sourceEntityId: testId,
        userId: test.user_id,
        projectId: test.project_id,
        eventData: {
          status: test.status,
          testId,
          title: `Test ${test.status}`,
          message: `Test on ${test.url} ${test.status}`,
        },
      }).catch(() => {});
    } catch (error) {
      logger.error('[TEST_COMPLETION] Unexpected error', { error, testId });
    }
  }

  /**
   * Check if we should suggest saving this test as a reusable test case.
   * Only suggests for successful, chat-triggered tests that haven't been saved yet.
   */
  private static async shouldSuggestSave(testId: string, testStatus: string): Promise<boolean> {
    if (testStatus !== 'completed') return false;

    const mapping = await TestChatMappingService.getMappingWithMetadata(testId);
    if (!mapping?.metadata?.trigger || mapping.metadata.trigger !== 'chat') return false;

    const { data: existing } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id')
      .eq('source_test_id', testId)
      .limit(1)
      .maybeSingle();

    return !existing;
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
        // Check if failure was due to credit exhaustion
        const isCreditExhaustion = results.some((r) =>
          r.errors?.some((e: any) =>
            (typeof e === 'string' ? e : e?.message || '')
              .toLowerCase()
              .includes('insufficient credits')
          )
        );

        if (isCreditExhaustion) {
          title = 'Test stopped: insufficient credits';
          message = 'Test execution was interrupted because your credit balance ran out. Top up credits to continue testing.';
        } else {
          title = 'Background test failed';
          message = `Test failed with ${errorsCount} error(s)`;
        }
      } else if (status === 'cancelled') {
        title = 'Background test cancelled';
        message = 'Test was cancelled before completion';
      } else {
        // Unknown status, skip notification
        return;
      }

      // Create notification.
      // `actionUrl` MUST point at /tests/:testId (the AI-test detail view),
      // NOT /runs/:runId — `tests.id` is not a `regression_runs.id` and
      // the regression-run-report page returns 404 for it. The FE's
      // `resolveActionUrl` historically synthesized `/runs/${testId}`
      // from metadata; passing actionUrl explicitly shortcircuits that.
      await NotificationService.createNotification({
        userId: test.user_id,
        type: 'personal',
        category: 'test',
        title,
        message,
        actionUrl: `/tests/${test.id}`,
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
   *
   * Race-condition guard: regression-run.service writes result.testId AFTER dispatching the
   * BullMQ job (runTest → updateStatus). If the job finishes before updateStatus completes,
   * this handler won't find the execution on the first attempt. We retry up to 3 times with
   * exponential backoff (500ms → 1s → 2s) to let the write land.
   */
  private static async updateTestExecutionsForCompletedUiTest(test: {
    id: string;
    status: string;
    user_id?: string;
    created_at?: string;
    completed_at?: string;
  }): Promise<void> {
    try {
      const testId = test.id;

      const mappedStatus =
        test.status === 'completed'
          ? 'passed'
          : test.status === 'timeout'
            ? 'timeout'
            : test.status === 'failed'
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

      // Retry loop: result->>testId may not be written yet due to race condition
      // between BullMQ job completion and ExecutionService.updateStatus in regression-run.service.
      const MAX_ATTEMPTS = 4;
      let data: any[] | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { data: rows, error } = await supabaseAdmin
          .from('test_executions')
          .update({
            status: mappedStatus,
            completed_at: test.completed_at || new Date().toISOString(),
            duration_ms: durationMs,
          })
          .eq('result->>testId', testId)
          .select('id, run_id');

        if (error) {
          logger.warn('[TEST_COMPLETION] Failed to update test_executions for UI test', {
            error,
            testId,
            attempt,
          });
          return;
        }

        if (rows && rows.length > 0) {
          data = rows;
          if (attempt > 1) {
            logger.info('[TEST_COMPLETION] Found test_execution after retry (race condition resolved)', {
              testId, attempt,
            });
          }
          break;
        }

        // No rows matched — result.testId may not be persisted yet
        if (attempt < MAX_ATTEMPTS) {
          const delay = 500 * Math.pow(2, attempt - 1); // 500ms → 1s → 2s
          logger.debug('[TEST_COMPLETION] No test_execution found for testId, retrying', {
            testId, attempt, nextRetryMs: delay,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      if (data && data.length > 0) {
        logger.info('[TEST_COMPLETION] Updated test_executions for UI test', {
          testId,
          updatedCount: data.length,
          mappedStatus,
        });

        // Signal dependency-aware execution orchestrator so dependents can proceed
        for (const row of data) {
          executionCompletionEmitter.signalCompletion(row.id, mappedStatus);
        }

        // Emit per-execution progress so frontend updates individual test status in run view.
        // executeTestCasesAsync runs in main process but handleTestCompletion runs in worker —
        // EventEmitter signals don't cross process boundaries, so we emit WebSocket directly.
        const runId = data[0].run_id;
        if (runId && test.user_id) {
          try {
            const { recipients, planId, projectId, trigger } = await this.getRunRecipients(runId, test.user_id);

            const payload: RegressionRunProgressPayload = {
              runId,
              userId: test.user_id,
              planId,
              projectId,
              trigger,
              status: 'test_completed',
              progress: -1, // Frontend should compute from execution statuses
              message: `Test ${mappedStatus}: ${test.id}`,
              details: {
                totalTests: 0, // Unknown from this context
                completedTests: 0,
                currentTestName: test.id,
              },
              timestamp: new Date().toISOString(),
            };

            for (const uid of recipients) {
              webSocketService.emitRegressionRunProgress(uid, payload);
            }
          } catch { /* non-fatal */ }
        }
      } else {
        // After all retries, still no execution found — this test may not be part of a regression run
        logger.debug('[TEST_COMPLETION] No test_execution linked to testId (may not be a regression test)', {
          testId,
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
      // Validate testId is a valid UUID to prevent injection in .or() filter
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_REGEX.test(testId)) {
        logger.error('[TEST_COMPLETION] Invalid testId format, skipping regression run update', { testId });
        return;
      }

      // Find regression runs that reference this test
      // Query 1: direct test_id match (single test case runs)
      // Query 2: test_ids JSONB array contains testId (plan/module/flow runs)
      // Query 3: test_executions join — fallback for runs linked via test_executions table
      const [directResult, batchResult, execResult] = await Promise.all([
        supabaseAdmin
          .from('regression_runs')
          .select('id, test_id, test_ids, status, user_id, trigger, plan_id, project_id, started_at')
          .eq('test_id', testId)
          .in('status', ['running', 'pending']),
        supabaseAdmin
          .from('regression_runs')
          .select('id, test_id, test_ids, status, user_id, trigger, plan_id, project_id, started_at')
          .filter('test_ids', 'cs', `["${testId}"]`)
          .in('status', ['running', 'pending']),
        // Fallback: find via test_executions table (most reliable for plan runs)
        supabaseAdmin
          .from('test_executions')
          .select('run_id')
          .eq('result->>testId', testId)
          .limit(1),
      ]);

      // Deduplicate by run ID
      const runMap = new Map<string, any>();
      for (const r of directResult.data || []) runMap.set(r.id, r);
      for (const r of batchResult.data || []) runMap.set(r.id, r);

      // If test_executions found a run_id not yet in map, fetch it
      const execRunId = execResult.data?.[0]?.run_id;
      if (execRunId && !runMap.has(execRunId)) {
        const { data: execRun } = await supabaseAdmin
          .from('regression_runs')
          .select('id, test_id, test_ids, status, user_id, trigger, plan_id, project_id, started_at')
          .eq('id', execRunId)
          .in('status', ['running', 'pending'])
          .maybeSingle();
        if (execRun) runMap.set(execRun.id, execRun);
      }

      const runs = [...runMap.values()];
      const runsError = directResult.error || batchResult.error;

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
      const invalidatedProjects = new Set<string>();
      for (const run of runs) {
        await this.recomputeRunStatus(run);
        if (run.project_id) invalidatedProjects.add(run.project_id);
      }

      // Invalidate plans list cache for affected projects
      for (const projectId of invalidatedProjects) {
        await cache.delByPattern(`qait:cache:plans:proj:${projectId}:*`);
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
    finalStatus: 'passed' | 'completed' | 'failed' | 'cancelled',
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

      if (finalStatus === 'passed' || finalStatus === 'completed') {
        const failedCount = summary.failed || 0;
        if (failedCount > 0) {
          title = `${triggerLabel} regression completed with failures`;
          message = `Regression run completed: ${summary.passed || 0} passed, ${failedCount} failed`;
        } else {
          title = `${triggerLabel} regression completed successfully`;
          message = `All ${summary.total || 0} test(s) passed successfully`;
        }
      } else if (finalStatus === 'failed') {
        if (summary.creditExhausted) {
          title = `${triggerLabel} regression stopped: insufficient credits`;
          message = 'Regression run was interrupted because your credit balance ran out. Top up credits to continue testing.';
        } else {
          title = `${triggerLabel} regression failed`;
          message = `Regression run failed: ${summary.failed || 0} test(s) failed`;
        }
      } else if (finalStatus === 'cancelled') {
        title = `${triggerLabel} regression cancelled`;
        message = 'Regression run was cancelled before completion';
      }

      // Create in-app notification.
      // `runId` here is `regression_runs.id`, which matches the FE
      // `/runs/:runId` route → regression-run-report view. Pass actionUrl
      // explicitly so the FE doesn't fall back to its (historically
      // wrong) metadata.testId synthesis.
      await NotificationService.createNotification({
        userId: run.user_id,
        type: 'personal',
        category: 'test',
        title,
        message,
        actionUrl: `/runs/${run.id}`,
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
   * Send Telegram notification for regression run completion.
   * Auto-generates a share link so the recipient can view the report.
   * Failures are logged but never thrown (don't break completion pipeline).
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

      // Auto-generate share link for the run (idempotent — reuses existing token)
      let shareUrl: string | null = null;
      try {
        shareUrl = await this.ensureShareLink(runId);
      } catch (err) {
        logger.warn('[TEST_COMPLETION] Failed to generate share link for Telegram', {
          error: err instanceof Error ? err.message : String(err),
          runId,
        });
        // Continue without share link — still send the notification
      }

      let htmlMessage = `<b>${title}</b>\n\n${message}`;
      if (shareUrl) {
        htmlMessage += `\n\n<a href="${shareUrl}">View full report</a>`;
      }

      await sendTelegramMessage(tokenData.access_token, tokenData.external_id, htmlMessage, 'HTML');

      logger.info('[TEST_COMPLETION] Sent Telegram notification', {
        userId,
        runId,
        chatId: tokenData.external_id,
        hasShareLink: !!shareUrl,
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
   * Ensure a regression run has a share_token and return the public share URL.
   * Reuses existing token if present (idempotent).
   */
  private static async ensureShareLink(runId: string): Promise<string | null> {
    // 1. Check if token already exists
    const { data: run, error } = await supabaseAdmin
      .from('regression_runs')
      .select('share_token')
      .eq('id', runId)
      .single();

    if (error || !run) return null;

    if (run.share_token) {
      const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
      return `${frontendUrl}/shared/report/${run.share_token}`;
    }

    // 2. No token yet — try to set one atomically
    const newToken = crypto.randomBytes(16).toString('hex');
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('regression_runs')
      .update({ share_token: newToken })
      .eq('id', runId)
      .is('share_token', null)
      .select('share_token')
      .maybeSingle();

    if (updateError) {
      logger.warn('[TEST_COMPLETION] Failed to set share token', { error: updateError, runId });
      return null;
    }

    // 3. If update matched (we won the race), use our token.
    //    If not (another handler set it first), re-fetch theirs.
    let finalToken = updated?.share_token;
    if (!finalToken) {
      const { data: refreshed } = await supabaseAdmin
        .from('regression_runs')
        .select('share_token')
        .eq('id', runId)
        .single();
      finalToken = refreshed?.share_token;
    }

    if (!finalToken) return null;

    const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
    return `${frontendUrl}/shared/report/${finalToken}`;
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
        .select('id, status, error_message, created_at')
        .eq('run_id', run.id);

      if (execError) {
        logger.warn('[TEST_COMPLETION] Failed to load test_executions for run, falling back', {
          error: execError,
          runId: run.id,
        });
      } else if (unifiedExecutions && unifiedExecutions.length > 0) {
        let statuses = unifiedExecutions.map((e: any) => e.status);

        const stuckExecs = unifiedExecutions.filter(
          (e: any) => (e.status === 'running' || e.status === 'pending')
        );

        if (stuckExecs.length > 0) {
          // Before giving up, check if the underlying UI tests have already completed
          // (race condition: BullMQ job can finish before result.testId is persisted)
          const { data: freshExecs } = await supabaseAdmin
            .from('test_executions')
            .select('id, status')
            .eq('run_id', run.id);

          const stillStuck = (freshExecs || []).filter(
            (e: any) => e.status === 'running' || e.status === 'pending'
          );

          if (stillStuck.length === 0) {
            // All executions resolved between first query and re-check
            statuses = (freshExecs || []).map((e: any) => e.status);
          } else {
            // Check if stuck executions are older than 30 minutes — force-fail them
            const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
            const runStarted = run.started_at ? new Date(run.started_at).getTime() : 0;
            const isStale = runStarted > 0 && runStarted < thirtyMinutesAgo;

            if (isStale) {
              logger.warn('[TEST_COMPLETION] Force-failing stuck executions for stale run', {
                runId: run.id,
                stuckCount: stillStuck.length,
              });
              const stuckIds = stillStuck.map((e: any) => e.id);
              await supabaseAdmin
                .from('test_executions')
                .update({
                  status: 'failed',
                  error_message: 'Execution timed out (stuck for >30 minutes)',
                  completed_at: new Date().toISOString(),
                })
                .in('id', stuckIds);

              // Refresh statuses after force-fail
              statuses = (freshExecs || []).map((e: any) => {
                const s = e.status;
                return s === 'running' || s === 'pending' ? 'failed' : s;
              });
            } else {
              logger.debug('[TEST_COMPLETION] Run still has running executions', {
                runId: run.id,
                runningCount: stillStuck.length,
              });
              return;
            }
          }
        }

        // NOTE: `regression_runs.status` in DB uses 'completed' (not 'passed').
        // We keep 'passed' as an outcome for notifications/automation, and map it to 'completed' for persistence.
        let finalStatus: 'passed' | 'failed' | 'cancelled' = 'passed';
        if (statuses.some((s: string) => s === 'cancelled')) {
          finalStatus = 'cancelled';
        } else if (statuses.some((s: string) => s === 'failed')) {
          finalStatus = 'failed';
        }

        const creditExhausted = unifiedExecutions.some((e: any) =>
          e.error_message?.toLowerCase().includes('insufficient credits')
        );

        const summary = {
          total: statuses.length,
          passed: statuses.filter((s: string) => s === 'passed').length,
          failed: statuses.filter((s: string) => s === 'failed').length,
          skipped: statuses.filter((s: string) => s === 'skipped').length,
          cancelled: statuses.filter((s: string) => s === 'cancelled').length,
          creditExhausted,
          completed_at: new Date().toISOString(),
        };

        // ── Phase 2 (May 2026) telemetry aggregation ──────────────────
        // Roll up per-test wallclock breakdowns into per-run totals so
        // ad-hoc SQL can answer "p95 regression duration" without
        // joining test_executions every time.
        //
        // Separate SELECT because the earlier query at the top of this
        // method intentionally pulls only id/status/error_message/
        // created_at to keep the status-recompute hot path lean.
        //
        // sumOrNull semantics: if no rows contribute a non-null value
        // (e.g. pure-web run), we write NULL — distinct from 0 ms.
        // Best-effort: a query failure here MUST NOT block the
        // status finalisation, so we coalesce to nulls and continue.
        let telemetryAggregates: {
          test_count: number | null;
          total_duration_ms: number | null;
          total_app_setup_ms: number | null;
          total_scenario_ms: number | null;
          total_test_steps_ms: number | null;
          cold_start_count: number | null;
          // Fast-auth aggregates (May 2026). Same NULL-vs-0 semantics as the
          // Phase 2 set above — NULL = no rows contributed, 0 = rows existed
          // but none used fast-auth.
          fast_auth_used_count: number | null;
          fast_auth_fallback_count: number | null;
          total_fast_auth_restore_ms: number | null;
        } = {
          test_count: null,
          total_duration_ms: null,
          total_app_setup_ms: null,
          total_scenario_ms: null,
          total_test_steps_ms: null,
          cold_start_count: null,
          fast_auth_used_count: null,
          fast_auth_fallback_count: null,
          total_fast_auth_restore_ms: null,
        };
        try {
          const startedAtMs = run.started_at ? new Date(run.started_at).getTime() : null;
          const totalDurationMs = startedAtMs !== null
            ? Math.max(0, Date.now() - startedAtMs)
            : null;

          const { data: tlmRowsData } = await supabaseAdmin
            .from('test_executions')
            .select(
              'app_setup_ms, scenario_steps_ms, test_steps_ms, cold_start_used, ' +
              'fast_auth_used, fast_auth_restore_ms',
            )
            .eq('run_id', run.id);

          // Supabase narrows multi-column selects to a union that doesn't
          // overlap our row shape; cast via unknown is the documented
          // escape hatch.
          const tlmRows = (tlmRowsData ?? []) as unknown as Array<{
            app_setup_ms: number | null;
            scenario_steps_ms: number | null;
            test_steps_ms: number | null;
            cold_start_used: boolean | null;
            fast_auth_used: boolean | null;
            fast_auth_restore_ms: number | null;
          }>;

          const sumOrNull = (
            key: 'app_setup_ms' | 'scenario_steps_ms' | 'test_steps_ms' | 'fast_auth_restore_ms',
          ): number | null => {
            const present = tlmRows.filter((r) => r[key] != null);
            if (present.length === 0) return null;
            return present.reduce((acc, r) => acc + (r[key] as number), 0);
          };

          // Fast-auth row presence detection: any non-null `fast_auth_used`
          // means at least one mobile test in this run attempted the path.
          // Without that marker the run is either pure-web or pre-fast-auth
          // and we keep aggregates NULL (rather than 0) to stay honest.
          const hasFastAuthRows = tlmRows.some((r) => r.fast_auth_used !== null);

          telemetryAggregates = {
            test_count: tlmRows.length > 0 ? tlmRows.length : null,
            total_duration_ms: totalDurationMs,
            total_app_setup_ms: sumOrNull('app_setup_ms'),
            total_scenario_ms: sumOrNull('scenario_steps_ms'),
            total_test_steps_ms: sumOrNull('test_steps_ms'),
            cold_start_count: (() => {
              const count = tlmRows.filter((r) => r.cold_start_used === true).length;
              // Distinguish "no mobile tests at all" (NULL) from "no
              // cold starts happened" (0). The presence of any non-null
              // cold_start_used means mobile rows exist.
              const hasMobileRows = tlmRows.some((r) => r.cold_start_used !== null);
              return hasMobileRows ? count : null;
            })(),
            fast_auth_used_count: hasFastAuthRows
              ? tlmRows.filter((r) => r.fast_auth_used === true).length
              : null,
            fast_auth_fallback_count: hasFastAuthRows
              ? tlmRows.filter((r) => r.fast_auth_used === false).length
              : null,
            total_fast_auth_restore_ms: sumOrNull('fast_auth_restore_ms'),
          };
        } catch (err) {
          logger.warn('[TEST_COMPLETION] Failed to aggregate Phase 2 telemetry — proceeding without it', {
            runId: run.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Optimistic lock: only update if run is still in running/pending status
        // Prevents race condition when multiple tests complete simultaneously
        const persistedStatus = finalStatus === 'passed' ? 'completed' : finalStatus;

        const { data: updatedRun, error: updateError } = await supabaseAdmin
          .from('regression_runs')
          .update({
            status: persistedStatus,
            summary,
            completed_at: new Date().toISOString(),
            // Phase 2 telemetry aggregates — merged into the single
            // optimistic-locked UPDATE so a race-loser doesn't half-
            // write aggregates without flipping status.
            ...telemetryAggregates,
          })
          .eq('id', run.id)
          .in('status', ['running', 'pending'])
          .select('id')
          .maybeSingle();

        if (updateError) {
          logger.error('[TEST_COMPLETION] Failed to update regression run (unified)', {
            error: updateError,
            runId: run.id,
            finalStatus,
            persistedStatus,
          });
        } else if (!updatedRun) {
          // Another completion handler already finalized this run
          logger.debug('[TEST_COMPLETION] Run already finalized by another handler', {
            runId: run.id,
          });
        } else {
          logger.info('[TEST_COMPLETION] Regression run updated (unified)', {
            runId: run.id,
            status: finalStatus,
            summary,
          });

          // Emit WebSocket completion event so frontend updates immediately (no polling delay)
          try {
            const wsStatus = finalStatus === 'passed' ? 'completed'
              : finalStatus === 'cancelled' ? 'cancelled'
              : 'failed';
            // Also emit to all active workspace members of the run's project (so git-trigger completion is visible to collaborators)
            const completionRecipients = run.project_id && run.user_id
              ? await getProjectWorkspaceMemberIds(run.project_id, run.user_id)
              : (run.user_id ? [run.user_id] : []);

            const payload: RegressionRunProgressPayload = {
              runId: run.id,
              userId: run.user_id,
              planId: run.plan_id ?? null,
              projectId: run.project_id ?? null,
              trigger: run.trigger as RegressionRunProgressPayload['trigger'],
              status: wsStatus,
              progress: 100,
              message: finalStatus === 'passed'
                ? `Run completed: ${summary.passed} passed, ${summary.failed} failed`
                : `Run ${finalStatus}: ${summary.passed} passed, ${summary.failed} failed`,
              errorCode: summary.creditExhausted ? 'INSUFFICIENT_CREDITS' : undefined,
              details: {
                totalTests: summary.total,
                completedTests: summary.total,
                passed: summary.passed,
                failed: summary.failed,
                skipped: summary.skipped,
              },
              timestamp: new Date().toISOString(),
            };

            for (const uid of completionRecipients) {
              webSocketService.emitRegressionRunProgress(uid, payload);
            }
          } catch { /* non-fatal */ }

          // Create notification for regression run
          await this.createRegressionRunNotification(run, finalStatus, summary);

          // Fire automation actions for run-level events (non-blocking)
          AutomationActionService.fireEvent({
            triggerEvent: finalStatus === 'passed' ? 'run_passed' : finalStatus === 'failed' ? 'run_failed' : 'run_completed',
            sourceEntityType: 'regression_run',
            sourceEntityId: run.id,
            userId: run.user_id,
            projectId: run.project_id,
            planId: run.plan_id,
            eventData: {
              status: finalStatus,
              runId: run.id,
              summary,
              title: `Regression ${finalStatus}`,
              message: `${summary.passed}/${summary.total} passed`,
            },
          }).catch(() => {});
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
        // Check if run is stale (>30 min) — force-fail stuck tests
        const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
        const runStarted = run.started_at ? new Date(run.started_at).getTime() : 0;
        const isStale = runStarted > 0 && runStarted < thirtyMinutesAgo;

        if (!isStale) {
          logger.debug('[TEST_COMPLETION] Run still has running tests', {
            runId: run.id,
            runningCount: statuses.filter(s => s === 'running' || s === 'pending').length,
          });
          return; // Don't update yet
        }

        logger.warn('[TEST_COMPLETION] Force-failing stale run with stuck tests', {
          runId: run.id,
          stuckCount: statuses.filter(s => s === 'running' || s === 'pending').length,
        });
      }

      // All tests are complete - compute final status
      // NOTE: `regression_runs.status` in DB uses 'completed' (not 'passed').
      // We keep 'passed' as an outcome for notifications/automation, and map it to 'completed' for persistence.
      let finalStatus: 'passed' | 'failed' | 'cancelled' = 'passed';

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

      // Update regression run (optimistic lock: only if still running/pending)
      const persistedStatus = finalStatus === 'passed' ? 'completed' : finalStatus;

      const { data: updatedRun, error: updateError } = await supabaseAdmin
        .from('regression_runs')
        .update({
          status: persistedStatus,
          summary,
          completed_at: new Date().toISOString(),
        })
        .eq('id', run.id)
        .in('status', ['running', 'pending'])
        .select('id')
        .maybeSingle();

      if (updateError) {
        logger.error('[TEST_COMPLETION] Failed to update regression run', {
          error: updateError,
          runId: run.id,
          finalStatus,
          persistedStatus,
        });
      } else if (!updatedRun) {
        logger.debug('[TEST_COMPLETION] Run already finalized by another handler', {
          runId: run.id,
        });
      } else {
        logger.info('[TEST_COMPLETION] Regression run updated', {
          runId: run.id,
          status: finalStatus,
          summary,
        });

        // Emit WebSocket completion event (fallback path)
        try {
          const wsStatus = finalStatus === 'passed' ? 'completed'
            : finalStatus === 'cancelled' ? 'cancelled'
            : 'failed';
          webSocketService.emitRegressionRunProgress(run.user_id, {
            runId: run.id,
            userId: run.user_id,
            status: wsStatus,
            progress: 100,
            message: finalStatus === 'passed'
              ? `Run completed: ${passed} passed, ${failed} failed`
              : `Run ${finalStatus}: ${passed} passed, ${failed} failed`,
            details: {
              totalTests: tests.length,
              completedTests: tests.length,
              passed,
              failed,
              skipped: 0,
            },
            timestamp: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }

        // Create notification for regression run
        await this.createRegressionRunNotification(run, finalStatus, summary);

        // Fire automation actions for run-level events (non-blocking)
        AutomationActionService.fireEvent({
          triggerEvent: finalStatus === 'passed' ? 'run_passed' : finalStatus === 'failed' ? 'run_failed' : 'run_completed',
          sourceEntityType: 'regression_run',
          sourceEntityId: run.id,
          userId: run.user_id,
          projectId: run.project_id,
          planId: run.plan_id,
          eventData: {
            status: finalStatus,
            runId: run.id,
            summary,
            title: `Regression ${finalStatus}`,
            message: `${passed}/${tests.length} passed`,
          },
        }).catch(() => {});

        // V14: Auto-retry flaky tests (non-blocking, best-effort)
        if (finalStatus === 'failed' && run.plan_id) {
          this.maybeRetryFlakyTests(run, tests).catch(err => {
            logger.warn('[TEST_COMPLETION] Auto-retry flaky check failed (non-fatal)', {
              runId: run.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        // Phase-1: Enqueue Regression Doctor job for drift aggregation.
        //
        // Conditions (all must hold):
        //   • run status is 'failed' (no drift to aggregate on a passing run)
        //   • at least 2 failed tests — a single failure has nothing to
        //     cross-compare against. Doctor's value is in GROUPING.
        //
        // Non-blocking fire-and-forget. Idempotency is guaranteed by the
        // `doctor-${runId}` jobId inside addRegressionDoctorJob — if this
        // hook fires twice (e.g. retry), BullMQ silently rejects the
        // duplicate instead of running the LLM twice.
        if (finalStatus === 'failed' && failed >= 2) {
          this.maybeEnqueueRegressionDoctor(run, failed).catch(err => {
            logger.warn('[TEST_COMPLETION] Failed to enqueue Regression Doctor (non-fatal)', {
              runId: run.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    } catch (error) {
      logger.error('[TEST_COMPLETION] Error recomputing run status', {
        error: error instanceof Error ? error.message : String(error),
        runId: run?.id || 'unknown',
      });
    }
  }

  /**
   * V14: Auto-retry tests classified as flaky by AI analysis.
   * Only runs if the plan has autoRetryFlaky enabled and retry count is within limits.
   *
   * Guard against infinite loops: counts existing retry runs in DB for the same
   * plan+project instead of relying on run metadata (which doesn't persist across runs).
   */
  private static async maybeRetryFlakyTests(
    run: any,
    tests: any[],
  ): Promise<void> {
    // 1. Load plan and check config
    const { data: plan } = await supabaseAdmin
      .from('regression_plans')
      .select('id, automation_config')
      .eq('id', run.plan_id)
      .single();

    if (!plan?.automation_config?.autoRetryFlaky?.enabled) return;

    const maxRetries = Math.min(plan.automation_config.autoRetryFlaky.maxRetries || 1, 3);

    // 2. Guard: Count recent retry runs for this plan to prevent infinite loops.
    //    Look for runs created in the last 30 minutes with trigger='scheduled' for the same plan.
    //    This is a conservative heuristic — even if the counter is slightly off, we cap at maxRetries.
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { count: recentRetryCount } = await supabaseAdmin
      .from('regression_runs')
      .select('id', { count: 'exact', head: true })
      .eq('plan_id', run.plan_id)
      .eq('project_id', run.project_id)
      .eq('trigger', 'scheduled')
      .gte('started_at', thirtyMinAgo);

    // Subtract 1 for the original scheduled run (if any); clamp to 0
    const estimatedRetries = Math.max(0, (recentRetryCount || 0) - 1);
    if (estimatedRetries >= maxRetries) {
      logger.debug('[TEST_COMPLETION] Auto-retry limit reached (DB count)', {
        runId: run.id,
        estimatedRetries,
        maxRetries,
      });
      return;
    }

    // 3. Find failed tests with flaky classification
    const failedTestIds = tests
      .filter((t: any) => t.status === 'failed' || t.status === 'timeout')
      .map((t: any) => t.id);

    if (failedTestIds.length === 0) return;

    // Get AI summaries for failed tests
    const { data: failedResults } = await supabaseAdmin
      .from('test_results')
      .select('test_id, ai_summary')
      .in('test_id', failedTestIds);

    const flakyTestIds = (failedResults || [])
      .filter((r: any) => r.ai_summary?.failureClassification === 'flaky')
      .map((r: any) => r.test_id as string);

    if (flakyTestIds.length === 0) {
      logger.debug('[TEST_COMPLETION] No flaky-classified tests to retry', { runId: run.id });
      return;
    }

    // 4. Get test_case_ids for flaky tests (via test_executions)
    const { data: flakyExecs } = await supabaseAdmin
      .from('test_executions')
      .select('test_case_id')
      .eq('run_id', run.id)
      .in('test_id', flakyTestIds);

    const flakyTestCaseIds = [...new Set((flakyExecs || []).map((e: any) => e.test_case_id))];

    if (flakyTestCaseIds.length === 0) return;

    logger.info('[TEST_COMPLETION] Auto-retrying flaky tests', {
      runId: run.id,
      planId: run.plan_id,
      flakyCount: flakyTestCaseIds.length,
      estimatedRetries,
      maxRetries,
    });

    // 5. Queue retry runs via RegressionRunService (one per flaky test case)
    try {
      const { RegressionRunService } = await import('../regression/regression-run.service');

      // Notify user
      webSocketService.emitRegressionRunProgress(run.user_id, {
        runId: run.id,
        userId: run.user_id,
        status: 'completed',
        progress: 100,
        message: `Auto-retrying ${flakyTestCaseIds.length} flaky test(s)...`,
        details: {
          totalTests: flakyTestCaseIds.length,
          completedTests: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
        },
        timestamp: new Date().toISOString(),
      });

      // Queue each flaky test case for retry
      for (const testCaseId of flakyTestCaseIds) {
        try {
          await RegressionRunService.runSavedTestCase({
            savedTestCaseId: testCaseId,
            userId: run.user_id,
            trigger: 'scheduled',
          });
        } catch (singleRetryError) {
          logger.warn('[TEST_COMPLETION] Failed to retry single flaky test case', {
            testCaseId,
            error: singleRetryError instanceof Error ? singleRetryError.message : String(singleRetryError),
          });
        }
      }
    } catch (retryError) {
      logger.error('[TEST_COMPLETION] Failed to queue flaky retry run', {
        runId: run.id,
        error: retryError instanceof Error ? retryError.message : String(retryError),
      });
    }
  }

  /**
   * Phase-1: Enqueue the Regression Doctor job for drift aggregation.
   *
   * We do NOT pre-filter on "tests classified as drift" here because the
   * per-test Bug Inspector (ai-analysis) runs in parallel with this hook
   * and may not have written all its results yet. Instead Doctor's own
   * handler fetches `test_results.ai_summary` rows under the run, filters
   * by `failureClassification === 'test_drift'` inside the job, and
   * exits silently if fewer than 2 drift-classified results are ready.
   *
   * Consequence: a small races where Doctor runs before some per-test
   * analyses finish → it sees fewer drift rows than ideal → may miss a
   * pattern. Acceptable trade-off: simpler flow than building a
   * "wait for all ai-analysis done" signal. The `failed >= 2` guard in
   * the caller already prevents the "1 test failed, nothing to group"
   * case that would be the common false-trigger.
   */
  private static async maybeEnqueueRegressionDoctor(
    run: any,
    failedCount: number,
  ): Promise<void> {
    // Lazy import to avoid loading BullMQ queue module when tests don't need it.
    const { QueueManager } = await import('@/config/infrastructure/queues');
    await QueueManager.addRegressionDoctorJob({
      runId: run.id,
      projectId: run.project_id,
      userId: run.user_id,
    });
    logger.info('[TEST_COMPLETION] Regression Doctor enqueued', {
      runId: run.id,
      failedCount,
    });
  }
}
