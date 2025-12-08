import { Request, Response } from 'express';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';

/**
 * Get current chat history (latest session)
 */
export const getCurrentChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    // Get user's session
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, title, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session) {
      res.json({
        success: true,
        data: {
          session: null,
          messages: [],
          pagination: { limit, offset, total: 0, has_more: false },
        },
      });
      return;
    }

    // Get total count
    const { count } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', session.id);

    // Get messages in chronological order (oldest first)
    // Use ascending order and sort by created_at, then by id for messages with same timestamp
    const { data: messages } = await supabaseAdmin
      .from('chat_messages')
      .select('id, role, content, metadata, created_at')
      .eq('session_id', session.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }) // Secondary sort for messages with same timestamp
      .range(offset, offset + limit - 1);

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

    res.json({
      success: true,
      data: {
        session,
        messages: sortedMessages,
        pagination: {
          limit,
          offset,
          total: count || 0,
          has_more: (offset + limit) < (count || 0),
        },
      },
    });
  } catch (error) {
    logger.error('[CHAT_HISTORY] Error getting current history', { error });
    res.status(500).json({ error: 'Failed to get chat history' });
  }
};

/**
 * Get all chat sessions for user
 */
export const getChatSessions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const { data: sessions } = await supabaseAdmin
      .from('chat_sessions')
      .select(`
        id,
        title,
        created_at,
        chat_messages (
          id,
          role,
          content,
          created_at
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const processedSessions = (sessions || []).map((session: any) => ({
      id: session.id,
      title: session.title,
      created_at: session.created_at,
      message_count: session.chat_messages?.length || 0,
      last_message: session.chat_messages?.[0] || null,
    }));

    res.json({
      success: true,
      data: {
        sessions: processedSessions,
        pagination: {
          limit,
          offset,
          total: processedSessions.length,
        },
      },
    });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error getting sessions', { error });
    res.status(500).json({ error: 'Failed to get chat sessions' });
  }
};

/**
 * Get chat history by session ID
 */
export const getChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;

    // ✅ NEW: Pagination support (backward compatible - if not specified, returns all)
    const limitParam = req.query.limit;
    const offsetParam = req.query.offset;
    const usePagination = limitParam !== undefined || offsetParam !== undefined;

    const limit = usePagination ? Math.min(Number(limitParam) || 50, 100) : undefined;
    const offset = usePagination ? Math.max(Number(offsetParam) || 0, 0) : undefined;

    // Verify session belongs to user
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, title, created_at')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Get total count if pagination is used
    let totalCount: number | undefined;
    if (usePagination) {
      const { count } = await supabaseAdmin
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', sessionId);
      totalCount = count || 0;
    }

    // Get messages for this session in chronological order
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

    const { data: messages } = await query;

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
    logger.error('[CHAT_HISTORY] Error getting history', { error, sessionId: req.params.sessionId });
    res.status(500).json({ error: 'Failed to get chat history' });
  }
};

/**
 * Debug: Get all chat data for user
 */
export const debugChatData = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from('chat_sessions')
      .select('*')
      .eq('user_id', userId);

    const sessionIds = sessions?.map(s => s.id) || [];
    const { data: messages, error: messagesError } = sessionIds.length > 0
      ? await supabaseAdmin
          .from('chat_messages')
          .select('*')
          .in('session_id', sessionIds)
      : { data: [], error: null };

    res.json({
      success: true,
      debug: {
        userId,
        sessions: sessions || [],
        messages: messages || [],
        errors: {
          sessions: sessionsError?.message,
          messages: messagesError?.message,
        },
      },
    });
  } catch (error) {
    logger.error('[DEBUG] Error getting chat data', { error });
    res.status(500).json({ error: 'Debug failed' });
  }
};
