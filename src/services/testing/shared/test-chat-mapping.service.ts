import { supabaseAdmin } from '@/db/supabase';
import { TestChatMappingMeta } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

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
    metadata?: TestChatMappingMeta;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const { testId, chatSessionId, userId } = params;

      // Use UPSERT to handle duplicate mappings gracefully
      // This prevents errors when the same test-chat combination is saved multiple times
      const { error } = await supabaseAdmin
        .from('test_chat_mappings')
        .upsert({
          test_id: testId,
          chat_session_id: chatSessionId,
          user_id: userId,
          metadata: params.metadata || {},
          updated_at: new Date().toISOString(), // Update timestamp on conflict
        }, {
          onConflict: 'test_id,chat_session_id', // Specify conflict columns
          ignoreDuplicates: false, // Update on conflict instead of ignoring
        });

      if (error) {
        logger.error('[TEST_CHAT_MAPPING] Failed to save mapping', {
          error: {
            message: error.message,
            code: error.code,
            details: error.details,
            hint: error.hint,
          },
          params
        });
        return { success: false, error: error.message };
      }

      logger.info('[TEST_CHAT_MAPPING] Mapping saved/updated', { testId, chatSessionId });
      return { success: true };
    } catch (error: any) {
      logger.error('[TEST_CHAT_MAPPING] Unexpected error', {
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        params
      });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
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
   * Get test IDs associated with a chat session
   */
  static async getTestIdsForChatSession(chatSessionId: string): Promise<string[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('test_chat_mappings')
        .select('test_id')
        .eq('chat_session_id', chatSessionId);

      if (error) {
        logger.error('[TEST_CHAT_MAPPING] Failed to get test IDs', { error, chatSessionId });
        return [];
      }

      return data?.map((row) => row.test_id) || [];
    } catch (error) {
      logger.error('[TEST_CHAT_MAPPING] Unexpected error getting test IDs', { error, chatSessionId });
      return [];
    }
  }

  /**
   * Get mapping with metadata for a test
   * Used by completion handler to check trigger context
   */
  static async getMappingWithMetadata(testId: string): Promise<{
    chatSessionId: string;
    userId: string;
    metadata: TestChatMappingMeta;
  } | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('test_chat_mappings')
        .select('chat_session_id, user_id, metadata')
        .eq('test_id', testId)
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.error('[TEST_CHAT_MAPPING] Failed to get mapping with metadata', { error, testId });
        return null;
      }

      if (!data) return null;

      return {
        chatSessionId: data.chat_session_id,
        userId: data.user_id,
        metadata: data.metadata || {},
      };
    } catch (error) {
      logger.error('[TEST_CHAT_MAPPING] Unexpected error getting mapping with metadata', { error, testId });
      return null;
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
