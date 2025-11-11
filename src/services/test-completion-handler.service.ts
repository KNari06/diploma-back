import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { TestChatMappingService } from './test-chat-mapping.service';
import { TestResultsFormatterService } from './test-results-formatter.service';
import { ChatService } from './chat.service';

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

      // Get test data
      const { data: test, error: testError } = await supabaseAdmin
        .from('tests')
        .select('*')
        .eq('id', testId)
        .single();

      if (testError || !test) {
        logger.error('[TEST_COMPLETION] Failed to get test', { error: testError, testId });
        return;
      }

      // Get test results
      const { data: results, error: resultsError } = await supabaseAdmin
        .from('test_results')
        .select('*')
        .eq('test_id', testId);

      if (resultsError) {
        logger.error('[TEST_COMPLETION] Failed to get results', { error: resultsError, testId });
        return;
      }

      // Format results as chat message
      const formattedMessage = TestResultsFormatterService.formatTestResults(test, results || []);

      // Send to all linked chat sessions
      for (const chatSessionId of chatSessions) {
        await ChatService.saveChatMessages(chatSessionId, [
          {
            role: 'ai',
            content: formattedMessage,
          },
        ]);

        logger.info('[TEST_COMPLETION] Results sent to chat', { testId, chatSessionId });
      }
    } catch (error) {
      logger.error('[TEST_COMPLETION] Unexpected error', { error, testId });
    }
  }
}
