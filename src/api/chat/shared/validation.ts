import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { ChatRequest } from '../chat.types';
import { CONSTANTS, MESSAGES } from './constants';
import { WorkspaceService } from '@/services/core/workspace.service';
import { getOrCreateChatSession } from './utils';
import { emitProcessingStep, PROGRESS } from './utils';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';

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
  mode?: 'lite' | 'pro'; // Test execution mode (default: 'lite')
}

export function validateInput(
  req: Request,
  res: Response,
  checkConnection: () => void,
  functionLogger?: FunctionLogger
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
    mode: mode || 'lite', // Default to 'lite' mode
  };
}

/**
 * STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
 */
export async function checkWorkspace(userId: string, functionLogger?: FunctionLogger): Promise<string> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
  // ═══════════════════════════════════════════════════════════════════════

  try {
    const checkOrCreateWorkspaceWithLogging = functionLogger
      ? withFunctionLogging(WorkspaceService.checkOrCreateWorkspace.bind(WorkspaceService), 'WorkspaceService.checkOrCreateWorkspace', functionLogger)
      : WorkspaceService.checkOrCreateWorkspace.bind(WorkspaceService);
    const workspaceResult = await checkOrCreateWorkspaceWithLogging(userId);
    const workspace_id = workspaceResult.workspace_id;

    if (workspaceResult.is_new) {
      logger.info('[CHAT] Created new workspace', { userId, workspace_id });
    }

    return workspace_id;
  } catch (workspaceError) {
    logger.error('[CHAT] WorkspaceService failed', {
      error: workspaceError instanceof Error ? workspaceError.message : String(workspaceError),
      userId,
    });
    throw new Error(`Failed to initialize workspace: ${workspaceError instanceof Error ? workspaceError.message : 'Unknown error'}`);
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
    const getOrCreateChatSessionWithLogging = functionLogger
      ? withFunctionLogging(getOrCreateChatSession, 'getOrCreateChatSession', functionLogger)
      : getOrCreateChatSession;
    chatSessionId = await getOrCreateChatSessionWithLogging(userId, sessionId, workspace_id);
    logger.debug('[CHAT] Chat session ready', {
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
  emitProcessingStepWithLogging(chatSessionId, 'enriching_context', '🔍 Analyzing your request...', PROGRESS.ENRICHING);

  checkRequestTimeout();

  return chatSessionId;
}
