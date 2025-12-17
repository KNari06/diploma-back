import { logger } from '@/utils/logger';
import { Request, Response } from 'express';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';

// Shared modules
import { CONSTANTS, MESSAGES } from './shared/constants';
import { parseIntent } from './shared/intent-parsing';
import { routeToHandler } from './shared/routing';
import { checkPendingApproval } from './shared/test-plan-approval';
import { checkWorkspace, manageChatSession, validateInput } from './shared/validation';
import {
  registerActiveRequest,
  unregisterActiveRequest,
  checkRequestAborted,
  hasActiveRequest,
} from './shared/request-cancellation';

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

  let chatSessionId: string | undefined;
  let userId: string | undefined;
  let abortController: AbortController | undefined;

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

    userId = inputResult.userId;
    const { message, context, sessionId, conversationId, answers } = inputResult;
    checkRequestTimeout(); // Check timeout after validation

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
    // ═══════════════════════════════════════════════════════════════════════
    const workspace_id = await checkWorkspace(userId);
    checkRequestTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: CHAT SESSION MANAGEMENT (FIX #4)
    // ═══════════════════════════════════════════════════════════════════════
    chatSessionId = await manageChatSession(userId, sessionId, workspace_id, checkRequestTimeout);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2.2: PREVENT UNEXPECTED CONCURRENT REQUESTS
    // ═══════════════════════════════════════════════════════════════════════
    // Frontend should not send a new message while previous request is processing.
    // If it happens anyway (retries/double submit), return 409 and do NOT cancel anything automatically.
    // ✅ FIX #2: hasActiveRequest is now async (checks Redis)
    if (await hasActiveRequest(chatSessionId, userId)) {
      if (!res.headersSent) {
        res.status(409).json({
          success: false,
          error: 'Request already in progress',
          message: 'A request is already being processed. Please cancel it or wait until it finishes.',
          timestamp: new Date().toISOString(),
          sessionId: chatSessionId,
        });
      }
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2.3: REGISTER REQUEST FOR CANCELLATION
    // ═══════════════════════════════════════════════════════════════════════
    // Register this request so it can be cancelled via /cancel endpoint
    // ✅ FIX #2: registerActiveRequest is now async (stores in Redis)
    abortController = await registerActiveRequest(chatSessionId, userId, message);
    const abortSignal = abortController.signal;

    // Check if already aborted (shouldn't happen, but safety check)
    checkRequestAborted(abortSignal);

    // Check if request was cancelled
    checkRequestAborted(abortSignal);

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
      abortSignal, // Pass abort signal for cancellation checks
    });

    if (approvalHandled) {
      // ✅ FIX #2: unregisterActiveRequest is now async
      await unregisterActiveRequest(chatSessionId, userId);
      return; // Approval was handled, response already sent
    }

    // Check if request was cancelled
    checkRequestAborted(abortSignal);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: PARSE INTENT (Only if not responding to test plan) (FIX #5)
    // ═══════════════════════════════════════════════════════════════════════
    const parsedIntent = await parseIntent(
      message,
      context,
      chatSessionId,
      userId,
      workspace_id,
      checkRequestTimeout,
      abortSignal // Pass abort signal for cancellation checks
    );

    // Check if request was cancelled
    checkRequestAborted(abortSignal);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
    // ═══════════════════════════════════════════════════════════════════════
    await routeToHandler(req, res, {
      message,
      parsedIntent,
      userId,
      workspace_id,
      chatSessionId,
      conversationId,
      answers,
      context,
      abortSignal, // Pass abort signal for cancellation checks
    });

    // Unregister request on successful completion
    // ✅ FIX #2: unregisterActiveRequest is now async
    await unregisterActiveRequest(chatSessionId, userId);

  } catch (error) {
    // Unregister request on error
    if (chatSessionId && userId) {
      // ✅ FIX #2: unregisterActiveRequest is now async
      await unregisterActiveRequest(chatSessionId, userId);
    }

    // Check if request was cancelled
    if (error instanceof Error && (
      error.message.includes('Request was cancelled') ||
      error.message.includes('cancelled by user') ||
      abortController?.signal.aborted
    )) {
      logger.info('[CHAT] Request was cancelled by user', {
        chatSessionId,
        userId: userId?.substring(0, 8) + '...',
        duration: Date.now() - requestStartTime,
      });
      // Don't send response if cancelled
      if (!res.headersSent) {
        res.status(499).json({
          success: false,
          error: 'Request cancelled',
          message: 'The request was cancelled by user',
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

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
