import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';

/**
 * Service to manage test-chat session mappings
 * Links test executions with chat sessions for result notifications
 */
export class TestChatMappingService {
  /**
   * Save a mapping between test and chat session
   */
  static async saveTestChatMapping(params: {
    testId: string;
    chatSessionId: string;
    userId: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const { testId, chatSessionId, userId } = params;

      const { error } = await supabaseAdmin.from('test_chat_mappings').insert({
        test_id: testId,
        chat_session_id: chatSessionId,
        user_id: userId,
      });

      if (error) {
        logger.error('[TEST_CHAT_MAPPING] Failed to save mapping', { error, params });
        return { success: false, error: error.message };
      }

      logger.info('[TEST_CHAT_MAPPING] Mapping saved', { testId, chatSessionId });
      return { success: true };
    } catch (error: any) {
      logger.error('[TEST_CHAT_MAPPING] Unexpected error', { error, params });
      return { success: false, error: error.message };
    }
  }

  /**
   * Get chat sessions associated with a test
   */
  static async getChatSessionsForTest(testId: string): Promise<string[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('test_chat_mappings')
        .select('chat_session_id')
        .eq('test_id', testId);

      if (error) {
        logger.error('[TEST_CHAT_MAPPING] Failed to get chat sessions', { error, testId });
        return [];
      }

      return data?.map((row) => row.chat_session_id) || [];
    } catch (error) {
      logger.error('[TEST_CHAT_MAPPING] Unexpected error getting sessions', { error, testId });
      return [];
    }
  }

  /**
   * Get mapping statistics for analytics
   */
  static async getMappingStats(userId: string): Promise<{
    totalMappings: number;
    recentMappings: number;
  }> {
    try {
      const { data: total } = await supabaseAdmin
        .from('test_chat_mappings')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      const { data: recent } = await supabaseAdmin
        .from('test_chat_mappings')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

      return {
        totalMappings: (total as any)?.count || 0,
        recentMappings: (recent as any)?.count || 0,
      };
    } catch (error) {
      logger.error('[TEST_CHAT_MAPPING] Failed to get stats', { error, userId });
      return { totalMappings: 0, recentMappings: 0 };
    }
  }
}
