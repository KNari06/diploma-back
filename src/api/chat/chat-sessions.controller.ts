import { supabaseAdmin } from '@/db/supabase';
import { WorkspaceService } from '@/services/core/workspace.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHAT SESSIONS CONTROLLER - Multi-chat support endpoints
 * ═══════════════════════════════════════════════════════════════════════════
 * Handles CRUD operations for chat sessions:
 * - Create new chat session
 * - List all user's chat sessions
 * - Get specific chat session with messages
 * - Update chat session title
 * - Delete chat session
 * ═══════════════════════════════════════════════════════════════════════════
 */

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/chat/sessions/new
 * Create a new chat session for multi-chat support
 */
export const createNewChatSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    logger.info('[CHAT_SESSIONS] Creating new chat session', { userId });

    // Get or create workspace
    const { workspace_id } = await WorkspaceService.checkOrCreateWorkspace(userId);

    // Create new chat session
    const sessionId = await ChatService.createChatSession(userId, workspace_id);

    logger.info('[CHAT_SESSIONS] New chat session created', {
      userId,
      sessionId,
      workspace_id,
    });

    res.status(201).json({
      success: true,
      data: {
        sessionId,
        title: 'New Chat',
        created_at: new Date().toISOString(),
      },
      message: 'New chat session created',
    });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error creating new chat session', { error });

    if (res.headersSent) {
      logger.warn('[CHAT_SESSIONS] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create new chat session',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * GET /api/v1/chat/sessions/list
 * Get all chat sessions for current user (with pagination)
 */
export const listUserChatSessions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    logger.info('[CHAT_SESSIONS] Listing user chat sessions', {
      userId,
      limit,
      offset,
    });

    const result = await ChatService.getUserChatSessions(userId, limit, offset);

    logger.info('[CHAT_SESSIONS] User chat sessions retrieved', {
      userId,
      sessionCount: result.sessions.length,
      total: result.total,
    });

    res.json({
      success: true,
      data: {
        sessions: result.sessions,
        pagination: {
          limit,
          offset,
          total: result.total,
          has_more: offset + limit < result.total,
        },
      },
    });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error listing chat sessions', { error });

    if (res.headersSent) {
      logger.warn('[CHAT_SESSIONS] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to list chat sessions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * GET /api/v1/chat/sessions/:sessionId
 * Get specific chat session with all messages
 */
export const getChatSessionById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;

    logger.info('[CHAT_SESSIONS] Getting chat session', { userId, sessionId });

    // Validate sessionId format (UUID)
    if (!UUID_REGEX.test(sessionId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid session ID format',
      });
      return;
    }

    // Get session with messages (using existing getChatHistory logic)
    // This endpoint already exists in chat.controller.ts
    // We'll reuse that logic here for consistency
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, title, created_at, updated_at')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (sessionError || !session) {
      logger.warn('[CHAT_SESSIONS] Session not found', { sessionId, userId });
      res.status(404).json({
        success: false,
        error: 'Chat session not found',
      });
      return;
    }

    // ✅ NEW: Pagination support (backward compatible - if not specified, returns all)
    const limitParam = req.query.limit;
    const offsetParam = req.query.offset;
    const usePagination = limitParam !== undefined || offsetParam !== undefined;

    const limit = usePagination ? Math.min(Number(limitParam) || 50, 100) : undefined;
    const offset = usePagination ? Math.max(Number(offsetParam) || 0, 0) : undefined;

    // Get total count if pagination is used
    let totalCount: number | undefined;
    if (usePagination) {
      const { count } = await supabaseAdmin
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', sessionId);
      totalCount = count || 0;
    }

    // Get messages in chronological order
    // Sort by created_at, then by id for messages with same timestamp
    let query = supabaseAdmin
      .from('chat_messages')
      .select('id, role, content, metadata, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }); // Secondary sort for messages with same timestamp

    // Apply pagination if specified
    if (usePagination && limit !== undefined && offset !== undefined) {
      query = query.range(offset, offset + limit - 1);
    }

    const { data: messages, error: messagesError } = await query;

    if (messagesError) {
      throw messagesError;
    }

    // Ensure messages are sorted correctly (in case of same timestamps)
    const sortedMessages = (messages || []).sort((a, b) => {
      const timeA = new Date(a.created_at).getTime();
      const timeB = new Date(b.created_at).getTime();
      if (timeA !== timeB) {
        return timeA - timeB;
      }
      // If timestamps are equal, sort by id (UUID comparison)
      return a.id.localeCompare(b.id);
    });

    logger.info('[CHAT_SESSIONS] Chat session retrieved', {
      sessionId,
      userId,
      messageCount: sortedMessages.length,
      pagination: usePagination ? { limit, offset, total: totalCount } : 'all',
    });

    const response: any = {
      success: true,
      data: {
        session,
        messages: sortedMessages,
      },
    };

    // Add pagination info if pagination was used
    if (usePagination && totalCount !== undefined && limit !== undefined && offset !== undefined) {
      response.data.pagination = {
        limit,
        offset,
        total: totalCount,
        has_more: (offset + limit) < totalCount,
      };
    }

    res.json(response);
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error getting chat session', { error });

    if (res.headersSent) {
      logger.warn('[CHAT_SESSIONS] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get chat session',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * PATCH /api/v1/chat/sessions/:sessionId
 * Update chat session title
 */
export const updateChatSessionTitle = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;
    const { title } = req.body;

    // Validate sessionId format (UUID)
    if (!UUID_REGEX.test(sessionId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid session ID format',
      });
      return;
    }

    if (!title || typeof title !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Title is required and must be a string',
      });
      return;
    }

    logger.info('[CHAT_SESSIONS] Updating chat session title', {
      userId,
      sessionId,
      title,
    });

    const result = await ChatService.updateChatTitle(sessionId, userId, title);

    if (!result.success) {
      res.status(404).json({
        success: false,
        error: result.message,
      });
      return;
    }

    logger.info('[CHAT_SESSIONS] Chat session title updated', {
      userId,
      sessionId,
      title,
    });

    res.json({
      success: true,
      data: {
        sessionId,
        title,
      },
      message: result.message,
    });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error updating chat session title', { error });

    if (res.headersSent) {
      logger.warn('[CHAT_SESSIONS] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to update chat session title',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * DELETE /api/v1/chat/sessions/:sessionId
 * Delete chat session and all messages
 */
export const deleteChatSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;

    // Validate sessionId format (UUID)
    if (!UUID_REGEX.test(sessionId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid session ID format',
      });
      return;
    }

    logger.info('[CHAT_SESSIONS] Deleting chat session', { userId, sessionId });

    const result = await ChatService.deleteChatSession(sessionId, userId);

    if (!result.success) {
      res.status(404).json({
        success: false,
        error: result.message,
      });
      return;
    }

    logger.info('[CHAT_SESSIONS] Chat session deleted', {
      userId,
      sessionId,
    });

    res.json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error deleting chat session', { error });

    if (res.headersSent) {
      logger.warn('[CHAT_SESSIONS] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to delete chat session',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
