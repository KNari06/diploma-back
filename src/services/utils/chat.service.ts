import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';

/**
 * Service for chat-related database operations
 */
export class ChatService {
  /**
   * Save chat messages to database
   * @param sessionId - Chat session ID
   * @param messages - Array of messages to save
   */
  static async saveChatMessages(
    sessionId: string,
    messages: Array<{ role: 'user' | 'ai'; content: string; metadata?: any }>
  ): Promise<void> {
    try {
      const records = messages.map(msg => ({
        session_id: sessionId,
        role: msg.role,
        content: msg.content,
        metadata: msg.metadata || {},
        created_at: new Date().toISOString(),
      }));

      const { error } = await supabaseAdmin
        .from('chat_messages')
        .insert(records);

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to save chat messages', { error, sessionId });
        throw error;
      }

      logger.info('[CHAT_SERVICE] Chat messages saved successfully', {
        sessionId,
        messageCount: messages.length,
      });

    } catch (error) {
      logger.error('[CHAT_SERVICE] Error saving chat messages', { error, sessionId });
      throw error;
    }
  }

  /**
   * Get recent chat messages for a session
   * @param sessionId - Chat session ID
   * @param limit - Number of messages to retrieve
   * @returns Array of chat messages
   */
  static async getRecentMessages(
    sessionId: string,
    limit: number = 20
  ): Promise<Array<{ role: string; content: string; created_at: string; metadata?: any }>> {
    try {
      const { data, error } = await supabaseAdmin
        .from('chat_messages')
        .select('role, content, created_at, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to get recent messages', { error, sessionId });
        throw error;
      }

      return (data || []).reverse(); // Reverse to get chronological order

    } catch (error) {
      logger.error('[CHAT_SERVICE] Error getting recent messages', { error, sessionId });
      return [];
    }
  }

  /**
   * Create a new chat session
   * @param userId - User ID
   * @param workspaceId - Workspace ID
   * @returns Chat session ID
   */
  static async createChatSession(
    userId: string,
    workspaceId: string
  ): Promise<string> {
    try {
      const { data, error } = await supabaseAdmin
        .from('chat_sessions')
        .insert({
          user_id: userId,
          workspace_id: workspaceId,
          created_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to create chat session', { error, userId, workspaceId });
        throw error;
      }

      logger.info('[CHAT_SERVICE] Chat session created', {
        sessionId: data.id,
        userId,
        workspaceId,
      });

      return data.id;

    } catch (error) {
      logger.error('[CHAT_SERVICE] Error creating chat session', { error, userId, workspaceId });
      throw error;
    }
  }
}
