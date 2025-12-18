import { supabaseAdmin } from '@/db/supabase';
import { TestResultsFormatterService } from '@/services/testing/results/test-results-formatter.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';

/**
 * Service to handle test completion and notify chat sessions
 */
export class TestCompletionHandlerService {
  /**
   * Handle test completion and send results to chat
   */
  static async handleTestCompletion(testId: string): Promise<void> {
    try {
      logger.info('[TEST_COMPLETION] Handling test completion', { testId });

      // Get chat sessions linked to this test
      const chatSessions = await TestChatMappingService.getChatSessionsForTest(testId);

      if (chatSessions.length === 0) {
        logger.warn('[TEST_COMPLETION] No chat sessions found for test', { testId });
        return;
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
          testId
        });
        return;
      }

      // ✅ FIX #9: Get test results with proper field selection
      const { data: results, error: resultsError } = await supabaseAdmin
        .from('test_results')
        .select('id, test_id, browser, status, errors, created_at, completed_at') // ✅ Select only needed fields
        .eq('test_id', testId); // ✅ Correct field name: test_id (not testId)

      if (resultsError) {
        logger.error('[TEST_COMPLETION] Failed to get results', { error: resultsError, testId });
        return;
      }

      // Format results as chat message
      const formattedMessage = TestResultsFormatterService.formatTestResults(test, results || []);

      // ✅ FIX: Include test results in metadata so AI can see them
      const testResultMetadata = {
        testId: testId,
        testType: 'ui',
        testResult: {
          status: test.status,
          url: test.url,
          browsers: test.browsers,
          completedAt: test.completed_at,
          results: results.map(r => ({
            browser: r.browser,
            status: r.status,
            errors: r.errors,
            completedAt: r.completed_at,
          })),
        },
      };

      // Send to all linked chat sessions
      for (const chatSessionId of chatSessions) {
        await ChatService.saveChatMessages(chatSessionId, [
          {
            role: 'ai',
            content: formattedMessage,
            metadata: testResultMetadata,
          },
        ]);

        logger.info('[TEST_COMPLETION] Results sent to chat', { testId, chatSessionId });
      }
    } catch (error) {
      logger.error('[TEST_COMPLETION] Unexpected error', { error, testId });
    }
  }
}
