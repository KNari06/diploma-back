import { supabaseAdmin } from '@/db/supabase';
import { WorkspaceService } from '@/services/core/workspace.service';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { ChatRequest } from '../chat.types';
import { CONSTANTS, MESSAGES } from './constants';
import { PROGRESS, emitProcessingStep, getOrCreateWorkspaceChat } from './utils';

/**
 * STEP 0: INPUT VALIDATION (FIX #1 & #2)
 */
export interface Step0Result {
  userId: string;
  message: string;
  context: any;
  sessionId?: string;
  conversationId?: string;
  answers?: Record<string, any>;
  mode?: 'lite' | 'pro' | 'editor'; // Test execution mode (default: 'lite')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validateInput(
  req: Request,
  res: Response,
  checkConnection: () => void,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // _functionLogger?: FunctionLogger
): Step0Result | null {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 0: INPUT VALIDATION (FIX #1 & #2)
  // ═══════════════════════════════════════════════════════════════════════

  // Validate req.user (FIX #2)
  if (!req.user || !req.user.id) {
    logger.error('[CHAT] Authentication required - req.user missing', {
      hasReqUser: !!req.user,
      hasUserId: !!req.user?.id,
    });
    res.status(401).json({
      success: false,
      error: MESSAGES.AUTH_REQUIRED,
      timestamp: new Date().toISOString(),
    });
    return null;
  }

  const userId = req.user.id;

  // Validate req.body (FIX #1)
  if (!req.body || typeof req.body !== 'object') {
    logger.error('[CHAT] Invalid request body', { userId });
    res.status(400).json({
      success: false,
      error: MESSAGES.INVALID_REQUEST,
      timestamp: new Date().toISOString(),
    });
    return null;
  }

  // Check connection after validation
  checkConnection();

  const { message, context, sessionId, conversationId, answers, mode } = req.body as ChatRequest;

  // Validate message (FIX #1)
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    logger.error('[CHAT] Message is required', { userId, messageType: typeof message });
    res.status(400).json({
      success: false,
      error: MESSAGES.INVALID_REQUEST,
      timestamp: new Date().toISOString(),
    });
    return null;
  }

  logger.info('[CHAT] Request received', {
    userId,
    messageLength: message.length,
    hasSession: !!sessionId,
    hasConversation: !!conversationId,
    hasAnswers: !!answers,
    mode: mode || 'lite',
    timeout: CONSTANTS.CHAT_REQUEST_TIMEOUT,
  });

  return {
    userId,
    message,
    context,
    sessionId,
    conversationId,
    answers,
    mode: (mode as 'lite' | 'pro' | 'editor') || 'lite', // Default to 'lite' mode
  };
}

/**
 * STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
 */
export async function checkWorkspace(
  userId: string,
  sessionId?: string,
  // functionLogger?: FunctionLogger
): Promise<string> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
  // ═══════════════════════════════════════════════════════════════════════

  try {
    // 1) If sessionId is provided, treat chat_sessions.workspace_id as the source of truth
    // NOTE: No user_id filter — session is shared across workspace members
    if (sessionId) {
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('chat_sessions')
        .select('id, workspace_id')
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionError) {
        logger.warn('[CHAT] Failed to read chat session workspace_id', {
          userId,
          sessionId,
          code: (sessionError as any)?.code,
          message: (sessionError as any)?.message,
          details: (sessionError as any)?.details,
        });
      } else if (session?.workspace_id) {
        return String(session.workspace_id);
      }

      // If the session exists but has no workspace_id (legacy/bad data), attach it once and keep it fixed
      if (session?.id && !session.workspace_id) {
        const activeWorkspaceId = await WorkspaceService.getActiveWorkspaceForUser(userId);
        const fallbackWorkspaceId = activeWorkspaceId
          ? activeWorkspaceId
          : (await WorkspaceService.createWorkspaceForUser(userId)).workspace_id;

        const { error: updateError } = await supabaseAdmin
          .from('chat_sessions')
          .update({ workspace_id: fallbackWorkspaceId })
          .eq('id', sessionId);

        if (updateError) {
          logger.warn('[CHAT] Failed to backfill chat_sessions.workspace_id (non-fatal)', {
            userId,
            sessionId,
            workspaceId: fallbackWorkspaceId,
            code: (updateError as any)?.code,
            message: (updateError as any)?.message,
            details: (updateError as any)?.details,
          });
        }

        return fallbackWorkspaceId;
      }
    }

    // 2) No sessionId (or session not found): resolve active workspace (multi-workspace aware)
    const activeWorkspaceId = await WorkspaceService.getActiveWorkspaceForUser(userId);
    if (activeWorkspaceId) {
      return activeWorkspaceId;
    }

    // 3) No workspaces at all -> create one
    const { workspace_id } = await WorkspaceService.createWorkspaceForUser(userId);
    logger.info('[CHAT] Created new workspace for chat', { userId, workspace_id });
    return workspace_id;
  } catch (workspaceError) {
    // Better error logging for PostgREST/Supabase errors
    const errorDetails = workspaceError instanceof Error
      ? {
        message: workspaceError.message,
        stack: workspaceError.stack,
      }
      : (workspaceError as any)?.code || (workspaceError as any)?.message
        ? {
          code: (workspaceError as any)?.code,
          message: (workspaceError as any)?.message,
          details: (workspaceError as any)?.details,
          hint: (workspaceError as any)?.hint,
        }
        : { raw: String(workspaceError) };

    logger.error('[CHAT] WorkspaceService failed', {
      error: errorDetails,
      userId,
    });

    // Extract readable error message for user
    const errorMessage = workspaceError instanceof Error
      ? workspaceError.message
      : (workspaceError as any)?.message || (workspaceError as any)?.code || 'Unknown error';

    throw new Error(`Failed to initialize workspace: ${errorMessage}`);
  }
}

/**
 * STEP 2: CHAT SESSION MANAGEMENT (FIX #4)
 */
export async function manageChatSession(
  userId: string,
  sessionId: string | undefined,
  workspace_id: string,
  checkRequestTimeout: () => void,
  functionLogger?: FunctionLogger
): Promise<string | undefined> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: CHAT SESSION MANAGEMENT (FIX #4)
  // ═══════════════════════════════════════════════════════════════════════

  let chatSessionId: string | undefined;
  try {
    const getOrCreateWorkspaceChatWithLogging = functionLogger
      ? withFunctionLogging(getOrCreateWorkspaceChat, 'getOrCreateWorkspaceChat', functionLogger)
      : getOrCreateWorkspaceChat;
    chatSessionId = await getOrCreateWorkspaceChatWithLogging(userId, workspace_id, sessionId);
    logger.debug('[CHAT] Workspace chat session ready', {
      chatSessionId: chatSessionId || 'none',
      providedSessionId: sessionId || 'none',
    });
  } catch (sessionError) {
    logger.warn('[CHAT] getOrCreateChatSession failed, continuing without session', {
      error: sessionError instanceof Error ? sessionError.message : String(sessionError),
      userId,
    });
    // Continue without session (graceful degradation)
    chatSessionId = undefined;
  }

  // Emit: Enriching context (FIX #11: Using PROGRESS constants)
  const emitProcessingStepWithLogging = functionLogger
    ? withFunctionLogging(emitProcessingStep, 'emitProcessingStep', functionLogger)
    : emitProcessingStep;
  emitProcessingStepWithLogging(chatSessionId, 'enriching_context', 'Analyzing your request...', PROGRESS.ENRICHING);

  checkRequestTimeout();

  return chatSessionId;
}
