import { supabaseAdmin } from '@/db/supabase';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { logger } from '@/utils/core/logger';

/**
 * Service for chat-related database operations
 */
export class ChatService {
  /**
   * Verify that a user has access to a chat session.
   * Per-user model: user must own the session (user_id match).
   * Returns the session's workspace_id if access is granted, null otherwise.
   */
  private static async verifySessionAccess(
    sessionId: string,
    userId: string
  ): Promise<string | null> {
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('workspace_id, user_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (!session?.workspace_id) return null;

    // Per-user chat: verify the session belongs to this user
    if (session.user_id !== userId) return null;

    return session.workspace_id;
  }

  /**
   * Save chat messages to database
   * @param sessionId - Chat session ID
   * @param messages - Array of messages to save
   * @returns Array of timestamps for saved messages (in same order as input)
   */
  /**
   * Save chat messages. Returns saved rows with {id, created_at} in input
   * order. Callers can ignore the return value entirely; the ID is available
   * for downstream attribution (telemetry, feedback linking).
   *
   * NB: Historically this returned `string[]` of timestamps. The shape is
   * still compatible with `.length >= 2` and destructuring, because we also
   * add `toString() = created_at` semantics via the plain object shape. If
   * older callers used element access like `timestamps[0]`, update to
   * `.created_at`.
   */
  static async saveChatMessages(
    sessionId: string,
    messages: Array<{ role: 'user' | 'ai'; content: string; metadata?: any }>
  ): Promise<Array<{ id: string; created_at: string }>> {
    // Validate inputs
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('Invalid sessionId');
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      logger.warn('[CHAT_SERVICE] No messages to save', { sessionId });
      return [];
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
        return [];
      }

      if (validMessages.length < messages.length) {
        logger.warn('[CHAT_SERVICE] Filtered out invalid messages', {
          sessionId,
          valid: validMessages.length,
          invalid: messages.length - validMessages.length,
        });
      }

      // ✅ FIX: Ensure messages have incrementing timestamps
      // When saving multiple messages (user + AI), they should have different timestamps
      // to maintain correct order. Add 1ms between each message.
      const baseTime = Date.now();
      // NOTE: message content is stored verbatim (incl. pasted bot tokens) so a
      // multi-turn connect flow can read the value back from history on a later
      // turn. Secrets are redacted on the way OUT to long-lived / external sinks
      // (embeddings, summaries, JSONL traces) via redactCredentials — never here.
      const records = validMessages.map((msg, index) => ({
        session_id: sessionId,
        role: msg.role,
        content: msg.content.trim(),
        metadata: msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {},
        created_at: new Date(baseTime + index).toISOString(), // Increment by 1ms per message
      }));

      const { data, error } = await supabaseAdmin
        .from('chat_messages')
        .insert(records)
        .select('id, created_at');

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

      // Supabase returns inserted rows; map to our public shape. Postgres
      // preserves insert order when a batch lands atomically, but sort by
      // created_at as a safety net.
      const rows = Array.isArray(data) ? data : [];
      return rows
        .filter((r): r is { id: string; created_at: string } =>
          !!r && typeof (r as { id?: unknown }).id === 'string' &&
          typeof (r as { created_at?: unknown }).created_at === 'string')
        .sort((a, b) => a.created_at.localeCompare(b.created_at));

    } catch (error) {
      logger.error('[CHAT_SERVICE] Error saving chat messages', { error, sessionId });
      throw error;
    }
  }

  /**
   * Get recent chat messages for a session
   * @param sessionId - Chat session ID
   * @param userId - User ID (for security verification)
   * @param limit - Number of messages to retrieve
   * @returns Array of chat messages in chronological order (oldest first)
   */
  static async getRecentMessages(
    sessionId: string,
    userId?: string,
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
      // SECURITY: Verify user is a workspace member if userId provided
      if (userId) {
        const workspaceId = await ChatService.verifySessionAccess(sessionId, userId);
        if (!workspaceId) {
          logger.warn('[CHAT_SERVICE] Session access denied - not a workspace member', {
            sessionId,
            userId: userId.substring(0, 8) + '...',
          });
          return [];
        }
      }

      logger.debug('[CHAT_SERVICE] Fetching recent messages', { sessionId, limit: validLimit });

      const QUERY_TIMEOUT_MS = 10_000; // 10s — query should complete in <1s normally
      const queryPromise = supabaseAdmin
        .from('chat_messages')
        .select('id, role, content, created_at, metadata')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }) // Secondary sort for messages with same timestamp
        .limit(validLimit);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Chat messages query timed out')), QUERY_TIMEOUT_MS)
      );

      let data: any[] | null;
      let error: any;
      try {
        ({ data, error } = await Promise.race([queryPromise, timeoutPromise]));
      } catch (timeoutError) {
        logger.error('[CHAT_SERVICE] Query timed out fetching recent messages', {
          sessionId,
          timeoutMs: QUERY_TIMEOUT_MS,
        });
        return []; // Graceful degradation — chat continues without history
      }

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

      // Sort messages: first by created_at (descending), then by id (descending)
      // Then reverse to get chronological order (oldest first)
      const sortedData = validData.sort((a, b) => {
        const timeA = new Date(a.created_at).getTime();
        const timeB = new Date(b.created_at).getTime();
        if (timeA !== timeB) {
          return timeB - timeA; // Descending by time
        }
        // If timestamps are equal, sort by id (UUID comparison, descending)
        return b.id.localeCompare(a.id);
      });

      const messages = sortedData.reverse(); // Reverse to get chronological order (oldest first)

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
      // Guard: limit sessions per user per workspace (prevent abuse)
      const { count: sessionCount } = await supabaseAdmin
        .from('chat_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId);

      if ((sessionCount ?? 0) >= 50) {
        throw new Error('Maximum chat sessions reached (50). Please delete old sessions to create new ones.');
      }

      // Insert new session (multi-session: no unique constraint on user_id + workspace_id)
      const { data, error: insertError } = await supabaseAdmin
        .from('chat_sessions')
        .insert({
          user_id: userId,
          workspace_id: workspaceId,
          created_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (insertError) {
        logger.error('[CHAT_SERVICE] Failed to create chat session', {
          error: insertError instanceof Error ? insertError.message : String(insertError),
          code: insertError.code,
          userId,
          workspaceId,
        });
        throw insertError;
      }

      if (!data || !data.id) {
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
   * @param userId - User ID (optional, for security verification)
   */
  static async updateSessionProject(
    sessionId: string,
    projectId: string,
    userId?: string
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
      // ✅ SECURITY: Verify user is a workspace member if userId provided
      if (userId) {
        const workspaceId = await ChatService.verifySessionAccess(sessionId, userId);
        if (!workspaceId) {
          logger.warn('[CHAT_SERVICE] Session access denied in updateSessionProject', {
            sessionId,
            userId: userId.substring(0, 8) + '...',
          });
          return;
        }
      }

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
   * @param userId - User ID (for security verification)
   * @returns Session with project data
   */
  static async getSessionWithProject(
    sessionId: string,
    userId?: string
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
      // SECURITY: Verify workspace membership if userId provided
      if (userId) {
        const workspaceId = await ChatService.verifySessionAccess(sessionId, userId);
        if (!workspaceId) {
          logger.debug('[CHAT_SERVICE] Session access denied in getSessionWithProject', { sessionId });
          return null;
        }
      }

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
        // user_id can be null for anonymous users, but we require it in return type
        // If null, this indicates a data integrity issue (should not happen for authenticated users)
        user_id: data.user_id || '',
        // workspace_id can be null, but return type requires string
        // Use empty string as fallback (should be set during session creation)
        workspace_id: data.workspace_id || '',
        project_id: data.project_id || undefined,
      };

      // Log warning if critical fields are missing (for debugging)
      if (!data.user_id && userId) {
        logger.warn('[CHAT_SERVICE] Session found but user_id is null', {
          sessionId,
          providedUserId: userId,
        });
      }
      if (!data.workspace_id) {
        logger.debug('[CHAT_SERVICE] Session found but workspace_id is null', {
          sessionId,
          hasProjectId: !!data.project_id,
        });
      }

      // Safely extract project data
      // Supabase can return projects as array or single object depending on join type
      if (data.projects) {
        if (Array.isArray(data.projects) && data.projects.length > 0) {
          const project = data.projects[0];
          // Validate project has required fields (id and name are required)
          if (project && typeof project === 'object' && project.id && project.name) {
            result.project = {
              id: String(project.id), // Ensure string type
              name: String(project.name), // Ensure string type
              settings: project.settings && typeof project.settings === 'object' ? project.settings : undefined,
            };
          } else {
            logger.warn('[CHAT_SERVICE] Invalid project data in array', {
              sessionId,
              hasId: !!project?.id,
              hasName: !!project?.name,
            });
          }
        } else if (!Array.isArray(data.projects) && typeof data.projects === 'object') {
          // Handle single project object (not array)
          const projectObj = data.projects as any;
          if (projectObj.id && projectObj.name) {
            result.project = {
              id: String(projectObj.id), // Ensure string type
              name: String(projectObj.name), // Ensure string type
              settings:
                projectObj.settings && typeof projectObj.settings === 'object'
                  ? projectObj.settings
                  : undefined,
            };
          } else {
            logger.warn('[CHAT_SERVICE] Invalid project data (single object)', {
              sessionId,
              hasId: !!projectObj?.id,
              hasName: !!projectObj?.name,
            });
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
    offset: number = 0,
    workspaceId?: string
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
      // Per-user model: filter by user_id AND workspace_id
      if (!workspaceId) {
        logger.warn('[CHAT_SERVICE] getUserChatSessions called without workspaceId', { userId });
        return { sessions: [], total: 0 };
      }

      // Verify workspace membership
      const isMember = await WorkspaceAccessService.isMember(userId, workspaceId);
      if (!isMember) {
        logger.warn('[CHAT_SERVICE] User is not a workspace member', { userId, workspaceId });
        return { sessions: [], total: 0 };
      }

      let countQuery = supabaseAdmin
        .from('chat_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId);

      let sessionsQuery = supabaseAdmin
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
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId);

      // Get total count
      const { count } = await countQuery;

      // Get sessions with message count
      const { data: sessions, error } = await sessionsQuery
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

          // ✅ FIX: Sort messages by created_at DESC to get the most recent message
          // Nested queries in Supabase don't guarantee order, so we sort in JavaScript
          const sortedMessages = messages.sort((a: any, b: any) => {
            const timeA = new Date(a.created_at || 0).getTime();
            const timeB = new Date(b.created_at || 0).getTime();
            return timeB - timeA; // Descending (newest first)
          });

          const lastMessage =
            sortedMessages.length > 0 &&
              sortedMessages[0] &&
              sortedMessages[0].role &&
              sortedMessages[0].content &&
              sortedMessages[0].created_at
              ? sortedMessages[0]
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
      // Verify user is a workspace member
      const workspaceId = await ChatService.verifySessionAccess(sessionId, userId);
      if (!workspaceId) {
        logger.warn('[CHAT_SERVICE] Session not found or access denied', {
          sessionId,
          userId,
        });
        return { success: false, message: 'Chat session not found' };
      }

      // Delete session (messages will be deleted via CASCADE)
      const { error: deleteError } = await supabaseAdmin
        .from('chat_sessions')
        .delete()
        .eq('id', sessionId);

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
      // Verify workspace membership
      const workspaceId = await ChatService.verifySessionAccess(sessionId, userId);
      if (!workspaceId) {
        logger.warn('[CHAT_SERVICE] Session not found or access denied', {
          sessionId,
          userId,
        });
        return { success: false, message: 'Chat session not found' };
      }

      // Update title
      const { data, error } = await supabaseAdmin
        .from('chat_sessions')
        .update({ title: title.trim() })
        .eq('id', sessionId)
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
        logger.warn('[CHAT_SERVICE] Session not found after access check', {
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
      title = title.replace(/[#*`[\]]/g, '');
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

      // Update session title ONLY if it's still the default. A user can rename
      // a session (updateChatTitle); without this guard the next message's
      // auto-title would silently overwrite that rename. Mirrors the test-case
      // path's updateTitleIfDefault. The default is NULL (the INSERT omits
      // title, the column has no default) OR the literal 'New Chat' fallback —
      // guard on both, else a bare title='New Chat' never matches a fresh
      // session and auto-title never runs. See BUG-2.
      const { data: updatedRows, error: updateError } = await supabaseAdmin
        .from('chat_sessions')
        .update({ title })
        .eq('id', sessionId)
        .or('title.is.null,title.eq.New Chat')
        .select('id');

      if (updateError) {
        logger.error('[CHAT_SERVICE] Failed to update auto-generated title', {
          error: updateError instanceof Error ? updateError.message : String(updateError),
          code: updateError.code,
          sessionId,
        });
        return null;
      }

      // No row updated → the user had renamed the session. Leave it untouched.
      if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
        logger.info('[CHAT_SERVICE] Skipped auto-title — session already has a custom title', {
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
