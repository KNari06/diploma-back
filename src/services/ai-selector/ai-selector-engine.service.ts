import { supabaseAdmin } from '@/db/supabase';
import { TestResultsFormatterService } from '@/services/testing/results/test-results-formatter.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';

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
 * - Support for both single test and suite runs
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

      // ✅ FIX #8: Get test data with proper field selection
      const { data: test, error: testError } = await supabaseAdmin
        .from('tests')
        .select('id, url, status, browsers, created_at, completed_at') // ✅ Select only needed fields
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
      }

      // Update regression runs associated with this test
      await this.updateRegressionRuns(testId, test.status);
    } catch (error) {
      logger.error('[TEST_COMPLETION] Unexpected error', { error, testId });
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
    testId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _testStatus: string
  ): Promise<void> {
    try {
      // Find regression runs that reference this test
      // Either directly (test_id) or in a suite (test_ids array)
      const { data: runs, error: runsError } = await supabaseAdmin
        .from('regression_runs')
        .select('id, suite_id, saved_test_case_id, test_id, test_ids, status')
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
      let underlyingTestIds: string[] = [];

      // Determine which test IDs to check
      if (run.test_id) {
        // Single test case run
        underlyingTestIds = [run.test_id];
      } else if (run.test_ids && Array.isArray(run.test_ids)) {
        // Suite run
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
      }
    } catch (error) {
      logger.error('[TEST_COMPLETION] Error recomputing run status', {
        error: error instanceof Error ? error.message : String(error),
        runId: run?.id || 'unknown',
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AI SELECTOR ENGINE (TEMPORARY STUB)
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ CRITICAL: This is a temporary stub. The actual AISelectorEngine class
// was replaced with TestCompletionHandlerService. This needs to be restored.
// The resolve method will throw an error to prevent silent failures.

import type { SelectorResolveRequest, SelectorResolveResponse } from './types';

export class AISelectorEngine {
  /**
   * Resolve selector using AI
   * ⚠️ TEMPORARY STUB - This will throw an error until the class is restored
   */
  static async resolve(_request: SelectorResolveRequest): Promise<SelectorResolveResponse> {
    logger.error('[AI_SELECTOR_ENGINE] AISelectorEngine.resolve called but class is not implemented');
    throw new Error(
      'AISelectorEngine.resolve is not implemented. The class was replaced with TestCompletionHandlerService. ' +
      'Please restore the original AISelectorEngine implementation.'
    );
  }
}
