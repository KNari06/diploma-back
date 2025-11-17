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
    // Validate inputs
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('Invalid sessionId');
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      logger.warn('[CHAT_SERVICE] No messages to save', { sessionId });
      return;
    }

    try {
      // Validate each message
      const validMessages = messages.filter(
        (msg) =>
          msg &&
          typeof msg === 'object' &&
          (msg.role === 'user' || msg.role === 'ai') &&
          msg.content &&
          typeof msg.content === 'string' &&
          msg.content.trim().length > 0
      );

      if (validMessages.length === 0) {
        logger.warn('[CHAT_SERVICE] No valid messages to save', { sessionId, totalMessages: messages.length });
        return;
      }

      if (validMessages.length < messages.length) {
        logger.warn('[CHAT_SERVICE] Filtered out invalid messages', {
          sessionId,
          valid: validMessages.length,
          invalid: messages.length - validMessages.length,
        });
      }

      const records = validMessages.map((msg) => ({
        session_id: sessionId,
        role: msg.role,
        content: msg.content.trim(),
        metadata: msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {},
        created_at: new Date().toISOString(),
      }));

      const { error } = await supabaseAdmin
        .from('chat_messages')
        .insert(records);

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to save chat messages', {
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
          sessionId,
          recordCount: records.length,
        });
        throw error;
      }

      logger.info('[CHAT_SERVICE] Chat messages saved successfully', {
        sessionId,
        messageCount: records.length,
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
   * @returns Array of chat messages in chronological order (oldest first)
   */
  static async getRecentMessages(
    sessionId: string,
    limit: number = 20
  ): Promise<Array<{ role: 'user' | 'ai'; content: string; created_at: string; metadata?: any }>> {
    // Validate inputs
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      logger.warn('[CHAT_SERVICE] Invalid sessionId in getRecentMessages', { sessionId: typeof sessionId });
      return [];
    }

    // Validate and clamp limit
    const validLimit = Math.max(1, Math.min(100, Math.floor(limit || 20)));

    try {
      logger.debug('[CHAT_SERVICE] Fetching recent messages', { sessionId, limit: validLimit });

      const { data, error } = await supabaseAdmin
        .from('chat_messages')
        .select('role, content, created_at, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(validLimit);

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to get recent messages', {
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
          sessionId,
        });
        return []; // Don't throw, return empty array for graceful degradation
      }

      // Validate data is array
      const validData = Array.isArray(data) ? data : [];
      const messages = validData.reverse(); // Reverse to get chronological order

      // Filter out invalid messages
      const validMessages = messages.filter(
        (msg) =>
          msg &&
          typeof msg === 'object' &&
          (msg.role === 'user' || msg.role === 'ai') &&
          msg.content &&
          typeof msg.content === 'string' &&
          msg.created_at
      );

      if (validMessages.length < messages.length) {
        logger.warn('[CHAT_SERVICE] Filtered out invalid messages', {
          sessionId,
          valid: validMessages.length,
          invalid: messages.length - validMessages.length,
        });
      }

      logger.debug('[CHAT_SERVICE] Retrieved messages', {
        sessionId,
        count: validMessages.length,
        firstMessage: validMessages[0]?.created_at,
        lastMessage: validMessages[validMessages.length - 1]?.created_at,
      });

      return validMessages;

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
    // Validate inputs
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('Invalid userId');
    }

    if (!workspaceId || typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      throw new Error('Invalid workspaceId');
    }

    try {
      const { data, error } = await supabaseAdmin
        .from('chat_sessions')
        .insert({
          user_id: userId,
          workspace_id: workspaceId,
          created_at: new Date().toISOString(),
        })
        .select('id')
        .maybeSingle();

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to create chat session', {
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
          userId,
          workspaceId,
        });
        throw error;
      }

      if (!data || !data.id) {
        logger.error('[CHAT_SERVICE] No data returned from session creation', { userId, workspaceId });
        throw new Error('Failed to create chat session: no data returned');
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
    // Validate inputs
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      logger.warn('[CHAT_SERVICE] Invalid sessionId in updateSessionProject', { sessionId: typeof sessionId });
      return;
    }

    if (!projectId || typeof projectId !== 'string' || projectId.trim().length === 0) {
      logger.warn('[CHAT_SERVICE] Invalid projectId in updateSessionProject', { projectId: typeof projectId });
      return;
    }

    try {
      const { error } = await supabaseAdmin
        .from('chat_sessions')
        .update({ project_id: projectId })
        .eq('id', sessionId);

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to update session project', {
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
          sessionId,
          projectId,
        });
        // Don't throw - this is not critical
        return;
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
    // Validate input
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      logger.warn('[CHAT_SERVICE] Invalid sessionId in getSessionWithProject', { sessionId: typeof sessionId });
      return null;
    }

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
        .maybeSingle();

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to get session with project', {
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
          sessionId,
        });
        return null;
      }

      if (!data || !data.id) {
        logger.debug('[CHAT_SERVICE] Session not found', { sessionId });
        return null;
      }

      // Transform nested project data
      const result: {
        id: string;
        user_id: string;
        workspace_id: string;
        project_id?: string;
        project?: {
          id: string;
          name: string;
          settings?: { main_url?: string };
        };
      } = {
        id: data.id,
        user_id: data.user_id || '',
        workspace_id: data.workspace_id || '',
        project_id: data.project_id || undefined,
      };

      // Safely extract project data
      if (data.projects) {
        if (Array.isArray(data.projects) && data.projects.length > 0) {
          const project = data.projects[0];
          if (project && typeof project === 'object' && project.id && project.name) {
            result.project = {
              id: project.id,
              name: project.name,
              settings: project.settings && typeof project.settings === 'object' ? project.settings : undefined,
            };
          }
        } else if (!Array.isArray(data.projects) && typeof data.projects === 'object') {
          // Handle single project object (not array)
          const projectObj = data.projects as any;
          if (projectObj.id && projectObj.name) {
            result.project = {
              id: projectObj.id,
              name: projectObj.name,
              settings:
                projectObj.settings && typeof projectObj.settings === 'object'
                  ? projectObj.settings
                  : undefined,
            };
          }
        }
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
    // Validate inputs
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('Invalid userId');
    }

    // Validate and clamp limit and offset
    const validLimit = Math.max(1, Math.min(100, Math.floor(limit || 50)));
    const validOffset = Math.max(0, Math.floor(offset || 0));

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
        .range(validOffset, validOffset + validLimit - 1);

      if (error) {
        logger.error('[CHAT_SERVICE] Failed to get user chat sessions', {
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
          userId,
        });
        throw error;
      }

      // Validate and transform data
      const validSessions = Array.isArray(sessions) ? sessions : [];
      const processedSessions = validSessions
        .filter((session: any) => session && session.id)
        .map((session: any) => {
          const messages = Array.isArray(session.chat_messages) ? session.chat_messages : [];
          const lastMessage =
            messages.length > 0 &&
            messages[0] &&
            messages[0].role &&
            messages[0].content &&
            messages[0].created_at
              ? messages[0]
              : null;

          return {
            id: session.id,
            title: typeof session.title === 'string' && session.title.trim().length > 0
              ? session.title.trim()
              : 'New Chat',
            created_at: session.created_at || new Date().toISOString(),
            updated_at: session.updated_at || session.created_at || new Date().toISOString(),
            message_count: messages.length,
            last_message:
              lastMessage && typeof lastMessage.content === 'string'
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
    // Validate inputs
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return { success: false, message: 'Invalid sessionId' };
    }

    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      return { success: false, message: 'Invalid userId' };
    }

    try {
      // Verify session belongs to user
      const { data: session, error: verifyError } = await supabaseAdmin
        .from('chat_sessions')
        .select('id')
        .eq('id', sessionId)
        .eq('user_id', userId)
        .maybeSingle();

      if (verifyError) {
        logger.warn('[CHAT_SERVICE] Error verifying session ownership', {
          sessionId,
          userId,
          error: verifyError instanceof Error ? verifyError.message : String(verifyError),
          code: verifyError.code,
        });
        return { success: false, message: 'Chat session not found' };
      }

      if (!session || !session.id) {
        logger.warn('[CHAT_SERVICE] Session not found or unauthorized', {
          sessionId,
          userId,
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
          error: deleteError instanceof Error ? deleteError.message : String(deleteError),
          code: deleteError.code,
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
    // Validate inputs
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return { success: false, message: 'Invalid sessionId' };
    }

    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      return { success: false, message: 'Invalid userId' };
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return { success: false, message: 'Title cannot be empty' };
    }

    if (title.length > 200) {
      return { success: false, message: 'Title too long (max 200 characters)' };
    }

    try {

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
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
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
    // Validate input
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      logger.warn('[CHAT_SERVICE] Invalid sessionId in autoGenerateTitle', { sessionId: typeof sessionId });
      return null;
    }

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

      if (error) {
        logger.warn('[CHAT_SERVICE] Error fetching first message for title generation', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
          code: error.code,
        });
        return null;
      }

      if (!firstMessage || !firstMessage.content || typeof firstMessage.content !== 'string') {
        logger.warn('[CHAT_SERVICE] No valid first message found for title generation', {
          sessionId,
          hasMessage: !!firstMessage,
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
          error: updateError instanceof Error ? updateError.message : String(updateError),
          code: updateError.code,
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
