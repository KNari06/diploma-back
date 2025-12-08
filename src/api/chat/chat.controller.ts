import { logger } from '@/utils/logger';
import { Request, Response } from 'express';

// Shared modules
import { CONSTANTS, MESSAGES } from './shared/constants';
import { parseIntent } from './shared/intent-parsing';
import { routeToHandler } from './shared/routing';
import { checkPendingApproval } from './shared/test-plan-approval';
import { checkWorkspace, manageChatSession, validateInput } from './shared/validation';

// History handlers
import { debugChatData, getChatHistory, getChatSessions, getCurrentChatHistory } from './history';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAIN CHAT HANDLER
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const handleChat = async (req: Request, res: Response): Promise<void> => {
  // FIX #8: Setup global timeout for entire request
  const requestStartTime = Date.now();
  const checkRequestTimeout = () => {
    if (Date.now() - requestStartTime > CONSTANTS.CHAT_REQUEST_TIMEOUT) {
      throw new Error(`Request timeout after ${CONSTANTS.CHAT_REQUEST_TIMEOUT / 1000}s`);
    }
  };

  // Check if client connection is still alive
  const checkConnection = () => {
    if (req.aborted || req.socket?.destroyed) {
      throw new Error('Client connection closed');
    }
  };

  try {
    // Check connection before processing
    checkConnection();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 0: INPUT VALIDATION (FIX #1 & #2)
    // ═══════════════════════════════════════════════════════════════════════
    const inputResult = validateInput(req, res, checkConnection);
    if (!inputResult) {
      return; // Response already sent in validateInput
    }

    const { userId, message, context, sessionId, conversationId, answers } = inputResult;
    checkRequestTimeout(); // Check timeout after validation

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
    // ═══════════════════════════════════════════════════════════════════════
    const workspace_id = await checkWorkspace(userId);
    checkRequestTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: CHAT SESSION MANAGEMENT (FIX #4)
    // ═══════════════════════════════════════════════════════════════════════
    const chatSessionId = await manageChatSession(userId, sessionId, workspace_id, checkRequestTimeout);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: CHECK FOR PENDING TEST PLAN APPROVAL (MUST BE FIRST!)
    // ═══════════════════════════════════════════════════════════════════════
    const approvalHandled = await checkPendingApproval({
      req,
      res,
      message,
      conversationId,
      userId,
      chatSessionId,
      workspace_id,
      checkRequestTimeout,
    });

    if (approvalHandled) {
      return; // Approval was handled, response already sent
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: PARSE INTENT (Only if not responding to test plan) (FIX #5)
    // ═══════════════════════════════════════════════════════════════════════
    const parsedIntent = await parseIntent(
      message,
      context,
      chatSessionId,
      userId,
      workspace_id,
      checkRequestTimeout
    );

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
    // ═══════════════════════════════════════════════════════════════════════
    return await routeToHandler(req, res, {
      message,
      parsedIntent,
      userId,
      workspace_id,
      chatSessionId,
      conversationId,
      answers,
      context,
    });

  } catch (error) {
    // Check if client connection was closed
    if (error instanceof Error && (
      error.message.includes('Client connection closed') ||
      error.message.includes('aborted') ||
      error.message.includes('ECONNRESET')
    )) {
      logger.warn('[CHAT] Client connection closed during request', {
        error: error.message,
        duration: Date.now() - requestStartTime,
      });
      // Don't send response if connection is closed
      return;
    }

    // FIX #6: Check if response already sent
    if (res.headersSent) {
      logger.warn('[CHAT] Response already sent, cannot send error response', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Check if connection is still alive before sending error
    if (req.aborted || req.socket?.destroyed) {
      logger.warn('[CHAT] Cannot send error response - connection closed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    logger.error('[CHAT] Error handling chat request', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      duration: Date.now() - requestStartTime,
    });

    // Extract error message safely
    const errorMessage = error instanceof Error && error.message
      ? error.message
      : (error ? String(error) : 'An unexpected error occurred');

    // Check for timeout error
    const isTimeout = errorMessage.includes('timeout');

    res.status(isTimeout ? 408 : 500).json({
      success: false,
      error: isTimeout ? MESSAGES.REQUEST_TIMEOUT : 'Failed to process chat request',
      message: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }
};

// Re-export history handlers for backward compatibility with routes
export { debugChatData, getChatHistory, getChatSessions, getCurrentChatHistory };
