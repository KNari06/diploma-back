import { supabaseAdmin } from '@/db/supabase';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { WorkspaceService } from '@/services/core/workspace.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHAT SESSIONS CONTROLLER - Single workspace chat model
 * ═══════════════════════════════════════════════════════════════════════════
 * Each workspace has exactly ONE shared chat session used by all members.
 * - Get workspace chat (auto-creates if not exists)
 * - Get session by ID with messages
 * - Update chat session title
 * - Clear chat (delete messages, keep session) — owner only
 * ═══════════════════════════════════════════════════════════════════════════
 */

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/chat/workspace-chat
 * Get the single workspace chat session (auto-creates if not exists)
 */
export const getWorkspaceChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;

    if (!workspaceId) {
      // Resolve active workspace
      const activeWorkspaceId = await WorkspaceService.getActiveWorkspaceForUser(userId);
      if (!activeWorkspaceId) {
        res.status(400).json({
          success: false,
          error: 'No workspace found. Please create a workspace first.',
        });
        return;
      }
      return getWorkspaceChatInternal(req, res, userId, activeWorkspaceId);
    }

    return getWorkspaceChatInternal(req, res, userId, workspaceId);
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error getting workspace chat', { error });
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to get workspace chat',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
};

async function getWorkspaceChatInternal(
  req: Request,
  res: Response,
  userId: string,
  workspaceId: string
): Promise<void> {
  // Validate workspace membership
  const isMember = await WorkspaceAccessService.isMember(userId, workspaceId);
  if (!isMember) {
    res.status(403).json({
      success: false,
      error: 'Not a member of this workspace',
    });
    return;
  }

  // Find or create the single workspace session
  let { data: session } = await supabaseAdmin
    .from('chat_sessions')
    .select('id, title, created_at, updated_at, workspace_id')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!session) {
    // Auto-create workspace chat session
    const sessionId = await ChatService.createChatSession(userId, workspaceId);
    const { data: newSession } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, title, created_at, updated_at, workspace_id')
      .eq('id', sessionId)
      .single();
    session = newSession;
  }

  if (!session) {
    res.status(500).json({
      success: false,
      error: 'Failed to create workspace chat session',
    });
    return;
  }

  // Get message count
  const { count: messageCount } = await supabaseAdmin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', session.id);

  logger.info('[CHAT_SESSIONS] Workspace chat retrieved', {
    userId,
    workspaceId,
    sessionId: session.id,
    messageCount: messageCount || 0,
  });

  res.json({
    success: true,
    data: {
      session: {
        ...session,
        message_count: messageCount || 0,
      },
    },
  });
}

/**
 * GET /api/v1/chat/sessions/list
 * @deprecated Returns the single workspace chat session for backward compatibility
 */
export const listUserChatSessions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;

    logger.info('[CHAT_SESSIONS] Listing workspace chat (single session model)', {
      userId,
      workspaceId: workspaceId || 'active',
    });

    const resolvedWorkspaceId = workspaceId || await WorkspaceService.getActiveWorkspaceForUser(userId);
    if (!resolvedWorkspaceId) {
      res.json({
        success: true,
        data: {
          sessions: [],
          pagination: { limit: 50, offset: 0, total: 0, has_more: false },
        },
      });
      return;
    }

    // Get the single workspace session
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, title, created_at, updated_at, workspace_id')
      .eq('workspace_id', resolvedWorkspaceId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    const sessions = session ? [session] : [];

    res.json({
      success: true,
      data: {
        sessions,
        pagination: {
          limit: 50,
          offset: 0,
          total: sessions.length,
          has_more: false,
        },
      },
    });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error listing chat sessions', { error });
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to list chat sessions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
};

/**
 * GET /api/v1/chat/sessions/:sessionId
 * Get specific chat session with all messages (validates workspace membership)
 */
export const getChatSessionById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;

    logger.info('[CHAT_SESSIONS] Getting chat session', { userId, sessionId });

    if (!UUID_REGEX.test(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session ID format' });
      return;
    }

    // Get session (no user_id filter — shared session)
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, title, created_at, updated_at, workspace_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (sessionError || !session) {
      res.status(404).json({ success: false, error: 'Chat session not found' });
      return;
    }

    // Validate workspace membership instead of user_id ownership
    if (session.workspace_id) {
      const isMember = await WorkspaceAccessService.isMember(userId, session.workspace_id);
      if (!isMember) {
        res.status(403).json({ success: false, error: 'Not a member of this workspace' });
        return;
      }
    }

    // Pagination support (backward compatible)
    const limitParam = req.query.limit;
    const offsetParam = req.query.offset;
    const usePagination = limitParam !== undefined || offsetParam !== undefined;

    const limit = usePagination ? Math.min(Number(limitParam) || 50, 100) : undefined;
    const offset = usePagination ? Math.max(Number(offsetParam) || 0, 0) : undefined;

    let totalCount: number | undefined;
    if (usePagination) {
      const { count } = await supabaseAdmin
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', sessionId);
      totalCount = count || 0;
    }

    let query = supabaseAdmin
      .from('chat_messages')
      .select('id, role, content, metadata, created_at, author_id')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    if (usePagination && limit !== undefined && offset !== undefined) {
      query = query.range(offset, offset + limit - 1);
    }

    const { data: messages, error: messagesError } = await query;
    if (messagesError) throw messagesError;

    const sortedMessages = (messages || []).sort((a, b) => {
      const timeA = new Date(a.created_at).getTime();
      const timeB = new Date(b.created_at).getTime();
      return timeA !== timeB ? timeA - timeB : a.id.localeCompare(b.id);
    });

    logger.info('[CHAT_SESSIONS] Chat session retrieved', {
      sessionId, userId, messageCount: sortedMessages.length,
    });

    const response: any = {
      success: true,
      data: { session, messages: sortedMessages },
    };

    if (usePagination && totalCount !== undefined && limit !== undefined && offset !== undefined) {
      response.data.pagination = {
        limit, offset, total: totalCount,
        has_more: (offset + limit) < totalCount,
      };
    }

    res.json(response);
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error getting chat session', { error });
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to get chat session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
};

/**
 * PATCH /api/v1/chat/sessions/:sessionId
 * Update chat session title (workspace member only)
 */
export const updateChatSessionTitle = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;
    const { title } = req.body;

    if (!UUID_REGEX.test(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session ID format' });
      return;
    }

    if (!title || typeof title !== 'string') {
      res.status(400).json({ success: false, error: 'Title is required and must be a string' });
      return;
    }

    // Validate workspace membership
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('workspace_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (!session) {
      res.status(404).json({ success: false, error: 'Chat session not found' });
      return;
    }

    if (session.workspace_id) {
      const isMember = await WorkspaceAccessService.isMember(userId, session.workspace_id);
      if (!isMember) {
        res.status(403).json({ success: false, error: 'Not a member of this workspace' });
        return;
      }
    }

    const result = await ChatService.updateChatTitle(sessionId, userId, title);
    if (!result.success) {
      res.status(404).json({ success: false, error: result.message });
      return;
    }

    res.json({ success: true, data: { sessionId, title }, message: result.message });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error updating chat session title', { error });
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to update chat session title',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
};

/**
 * POST /api/v1/chat/sessions/:sessionId/clear
 * Clear all messages from workspace chat (owner only). Session is preserved.
 */
export const clearWorkspaceChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;

    if (!UUID_REGEX.test(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session ID format' });
      return;
    }

    // Get session to find workspace
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, workspace_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (!session) {
      res.status(404).json({ success: false, error: 'Chat session not found' });
      return;
    }

    // Require owner role to clear chat
    if (session.workspace_id) {
      try {
        await WorkspaceAccessService.requireOwner(userId, session.workspace_id);
      } catch {
        res.status(403).json({
          success: false,
          error: 'Only workspace owner can clear the chat',
        });
        return;
      }
    }

    // Delete all messages (session remains)
    const { error: deleteError } = await supabaseAdmin
      .from('chat_messages')
      .delete()
      .eq('session_id', sessionId);

    if (deleteError) {
      throw deleteError;
    }

    // Also delete embeddings
    const { error: embeddingsError } = await supabaseAdmin
      .from('chat_message_embeddings')
      .delete()
      .eq('session_id', sessionId);

    if (embeddingsError) {
      logger.warn('[CHAT_SESSIONS] Failed to delete embeddings during clear', { error: embeddingsError });
    }

    // Also delete summaries if they exist
    await supabaseAdmin
      .from('chat_summaries')
      .delete()
      .eq('session_id', sessionId)
      .then(({ error }) => {
        if (error) {
          logger.warn('[CHAT_SESSIONS] Failed to delete summaries during clear (table may not exist yet)', { error: error.message });
        }
      });

    logger.info('[CHAT_SESSIONS] Workspace chat cleared', { userId, sessionId });

    res.json({
      success: true,
      message: 'Chat history cleared',
    });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error clearing workspace chat', { error });
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to clear chat',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
};

/**
 * DELETE /api/v1/chat/sessions/:sessionId
 * @deprecated Use POST /sessions/:sessionId/clear instead.
 * Delete chat session and all messages (kept for backward compatibility)
 */
export const deleteChatSession = async (req: Request, res: Response): Promise<void> => {
  // Redirect to clear behavior instead of delete
  return clearWorkspaceChat(req, res);
};
