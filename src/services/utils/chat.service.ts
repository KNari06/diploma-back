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

  /**
   * Update project_id in chat session
   * @param sessionId - Chat session ID
   * @param projectId - Project ID
   */
  static async updateSessionProject(
    sessionId: string,
    projectId: string
  ): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('chat_sessions')
        .update({ project_id: projectId })
        .eq('id', sessionId);

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to update session project', { error, sessionId, projectId });
        throw error;
      }

      logger.info('[CHAT_SERVICE] Session project updated', {
        sessionId,
        projectId,
      });

    } catch (error) {
      logger.error('[CHAT_SERVICE] Error updating session project', { error, sessionId, projectId });
      // Don't throw - this is not critical
    }
  }

  /**
   * Get chat session with project info
   * @param sessionId - Chat session ID
   * @returns Session with project data
   */
  static async getSessionWithProject(
    sessionId: string
  ): Promise<{
    id: string;
    user_id: string;
    workspace_id: string;
    project_id?: string;
    project?: {
      id: string;
      name: string;
      settings?: { main_url?: string };
    };
  } | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('chat_sessions')
        .select(`
          id,
          user_id,
          workspace_id,
          project_id,
          projects:project_id (
            id,
            name,
            settings
          )
        `)
        .eq('id', sessionId)
        .single();

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to get session with project', { error, sessionId });
        return null;
      }

      // Transform nested project data
      const result: any = {
        id: data.id,
        user_id: data.user_id,
        workspace_id: data.workspace_id,
        project_id: data.project_id,
      };

      if (data.projects) {
        result.project = Array.isArray(data.projects) ? data.projects[0] : data.projects;
      }

      logger.info('[CHAT_SERVICE] Session with project retrieved', {
        sessionId,
        hasProject: !!result.project,
        projectUrl: result.project?.settings?.main_url,
      });

      return result;

    } catch (error) {
      logger.error('[CHAT_SERVICE] Error getting session with project', { error, sessionId });
      return null;
    }
  }
}
