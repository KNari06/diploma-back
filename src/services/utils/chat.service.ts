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

  /**
   * Get all chat sessions for a user (sorted by recent activity)
   * @param userId - User ID
   * @param limit - Maximum number of sessions to return
   * @param offset - Pagination offset
   * @returns Array of chat sessions with metadata
   */
  static async getUserChatSessions(
    userId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<{
    sessions: Array<{
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
      message_count: number;
      last_message?: {
        role: string;
        content: string;
        created_at: string;
      };
    }>;
    total: number;
  }> {
    try {
      // Get total count
      const { count } = await supabaseAdmin
        .from('chat_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      // Get sessions with message count
      const { data: sessions, error } = await supabaseAdmin
        .from('chat_sessions')
        .select(`
          id,
          title,
          created_at,
          updated_at,
          chat_messages (
            id,
            role,
            content,
            created_at
          )
        `)
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to get user chat sessions', { error, userId });
        throw error;
      }

      // Transform data
      const processedSessions = (sessions || []).map((session: any) => {
        const messages = session.chat_messages || [];
        const lastMessage = messages.length > 0 ? messages[0] : null;

        return {
          id: session.id,
          title: session.title || 'New Chat',
          created_at: session.created_at,
          updated_at: session.updated_at || session.created_at,
          message_count: messages.length,
          last_message: lastMessage
            ? {
                role: lastMessage.role,
                content: lastMessage.content.substring(0, 200), // Truncate for preview
                created_at: lastMessage.created_at,
              }
            : undefined,
        };
      });

      logger.info('[CHAT_SERVICE] Retrieved user chat sessions', {
        userId,
        sessionCount: processedSessions.length,
        total: count || 0,
      });

      return {
        sessions: processedSessions,
        total: count || 0,
      };
    } catch (error) {
      logger.error('[CHAT_SERVICE] Error getting user chat sessions', { error, userId });
      throw error;
    }
  }

  /**
   * Delete a chat session and all its messages (CASCADE)
   * @param sessionId - Chat session ID
   * @param userId - User ID (for security check)
   * @returns Success status
   */
  static async deleteChatSession(
    sessionId: string,
    userId: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Verify session belongs to user
      const { data: session, error: verifyError } = await supabaseAdmin
        .from('chat_sessions')
        .select('id')
        .eq('id', sessionId)
        .eq('user_id', userId)
        .maybeSingle();

      if (verifyError || !session) {
        logger.warn('[CHAT_SERVICE] Session not found or unauthorized', {
          sessionId,
          userId,
          error: verifyError,
        });
        return { success: false, message: 'Chat session not found' };
      }

      // Delete session (messages will be deleted via CASCADE)
      const { error: deleteError } = await supabaseAdmin
        .from('chat_sessions')
        .delete()
        .eq('id', sessionId)
        .eq('user_id', userId);

      if (deleteError) {
        logger.error('[CHAT_SERVICE] Failed to delete chat session', {
          error: deleteError,
          sessionId,
          userId,
        });
        throw deleteError;
      }

      logger.info('[CHAT_SERVICE] Chat session deleted successfully', {
        sessionId,
        userId,
      });

      return { success: true, message: 'Chat session deleted' };
    } catch (error) {
      logger.error('[CHAT_SERVICE] Error deleting chat session', { error, sessionId, userId });
      throw error;
    }
  }

  /**
   * Update chat session title
   * @param sessionId - Chat session ID
   * @param userId - User ID (for security check)
   * @param title - New title
   * @returns Success status
   */
  static async updateChatTitle(
    sessionId: string,
    userId: string,
    title: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Validate title
      if (!title || title.trim().length === 0) {
        return { success: false, message: 'Title cannot be empty' };
      }

      if (title.length > 200) {
        return { success: false, message: 'Title too long (max 200 characters)' };
      }

      // Update title (with user verification)
      const { data, error } = await supabaseAdmin
        .from('chat_sessions')
        .update({ title: title.trim() })
        .eq('id', sessionId)
        .eq('user_id', userId)
        .select('id')
        .maybeSingle();

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to update chat title', {
          error,
          sessionId,
          userId,
        });
        throw error;
      }

      if (!data) {
        logger.warn('[CHAT_SERVICE] Session not found or unauthorized', {
          sessionId,
          userId,
        });
        return { success: false, message: 'Chat session not found' };
      }

      logger.info('[CHAT_SERVICE] Chat title updated successfully', {
        sessionId,
        userId,
        title,
      });

      return { success: true, message: 'Chat title updated' };
    } catch (error) {
      logger.error('[CHAT_SERVICE] Error updating chat title', { error, sessionId, userId });
      throw error;
    }
  }

  /**
   * Auto-generate title for chat session based on first user message
   * @param sessionId - Chat session ID
   * @returns Generated title or null if failed
   */
  static async autoGenerateTitle(sessionId: string): Promise<string | null> {
    try {
      // Get first user message
      const { data: firstMessage, error } = await supabaseAdmin
        .from('chat_messages')
        .select('content')
        .eq('session_id', sessionId)
        .eq('role', 'user')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error || !firstMessage) {
        logger.warn('[CHAT_SERVICE] No first message found for title generation', {
          sessionId,
          error,
        });
        return null;
      }

      // Generate title from first message (simple approach - first 50 chars)
      let title = firstMessage.content.trim();

      // Remove markdown, URLs, and special chars
      title = title.replace(/[#*`\[\]]/g, '');
      title = title.replace(/https?:\/\/[^\s]+/g, '');
      title = title.trim();

      // Truncate to 50 chars
      if (title.length > 50) {
        title = title.substring(0, 50).trim() + '...';
      }

      // Fallback if title is too short
      if (title.length < 5) {
        title = 'New Chat';
      }

      // Update session title
      const { error: updateError } = await supabaseAdmin
        .from('chat_sessions')
        .update({ title })
        .eq('id', sessionId);

      if (updateError) {
        logger.error('[CHAT_SERVICE] Failed to update auto-generated title', {
          error: updateError,
          sessionId,
        });
        return null;
      }

      logger.info('[CHAT_SERVICE] Auto-generated title', {
        sessionId,
        title,
      });

      return title;
    } catch (error) {
      logger.error('[CHAT_SERVICE] Error auto-generating title', { error, sessionId });
      return null;
    }
  }
}
