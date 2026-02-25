import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// Shared modules
import { CONSTANTS, MESSAGES } from './shared/constants';
import { parseIntent } from './shared/intent-parsing';
import {
  checkRequestAborted,
  hasActiveRequest,
  registerActiveRequest,
  unregisterActiveRequest,
} from './shared/request-cancellation';
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
  // Initialize function logger
  const functionLogger = new FunctionLogger();
  functionLogger.logFunctionCall('handleChat', [req, res], undefined);

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
    const validateInputWithLogging = withFunctionLogging(validateInput, 'validateInput', functionLogger);
    const inputResult = await validateInputWithLogging(req, res, checkConnection);
    if (!inputResult) {
      return; // Response already sent in validateInput
    }

    userId = inputResult.userId;
    const { message, context, sessionId, conversationId, answers, attachments } = inputResult;
    checkRequestTimeout(); // Check timeout after validation

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
    // ═══════════════════════════════════════════════════════════════════════
    const checkWorkspaceWithLogging = withFunctionLogging(checkWorkspace, 'checkWorkspace', functionLogger);
    const workspace_id = await checkWorkspaceWithLogging(userId, sessionId);
    checkRequestTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1.5: EARLY CREDITS CHECK (BEFORE ANY PROCESSING)
    // ═══════════════════════════════════════════════════════════════════════
    // Check minimum credits required for chat (1 credit)
    // This prevents wasting resources on intent parsing, AI calls, etc. if user has no credits
    const checkCreditsForTestWithLogging = withFunctionLogging(
      CreditCostTrackerService.checkCreditsForTest.bind(CreditCostTrackerService),
      'CreditCostTrackerService.checkCreditsForTest',
      functionLogger
    );
    const chatCreditCheck = await checkCreditsForTestWithLogging(userId, 'chat');

    if (!chatCreditCheck.hasEnough) {
      logger.warn('[CHAT] Insufficient credits for chat', {
        userId: userId.substring(0, 8) + '...',
        required: chatCreditCheck.required,
        available: chatCreditCheck.available,
        shortage: chatCreditCheck.shortage,
      });

      if (!res.headersSent) {
        res.status(402).json({
          success: false,
          error: 'Insufficient credits',
          message: `You need at least ${chatCreditCheck.required} credit(s) to use the chat. You have ${chatCreditCheck.available} credit(s). Please purchase ${chatCreditCheck.shortage} more credit(s) to continue.`,
          required: chatCreditCheck.required,
          available: chatCreditCheck.available,
          shortage: chatCreditCheck.shortage,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    checkRequestTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: CHAT SESSION MANAGEMENT (FIX #4)
    // ═══════════════════════════════════════════════════════════════════════
    const manageChatSessionWithLogging = withFunctionLogging(manageChatSession, 'manageChatSession', functionLogger);
    chatSessionId = await manageChatSessionWithLogging(userId, sessionId, workspace_id, checkRequestTimeout, functionLogger);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2.2: PREVENT UNEXPECTED CONCURRENT REQUESTS
    // ═══════════════════════════════════════════════════════════════════════
    // Frontend should not send a new message while previous request is processing.
    // If it happens anyway (retries/double submit), return 409 and do NOT cancel anything automatically.
    // ✅ FIX #2: hasActiveRequest is now async (checks Redis)
    const hasActiveRequestWithLogging = withFunctionLogging(hasActiveRequest, 'hasActiveRequest', functionLogger);
    if (await hasActiveRequestWithLogging(chatSessionId, userId)) {
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
    const registerActiveRequestWithLogging = withFunctionLogging(registerActiveRequest, 'registerActiveRequest', functionLogger);
    abortController = await registerActiveRequestWithLogging(chatSessionId, userId, message);
    const abortSignal = abortController.signal;

    // Check if already aborted (shouldn't happen, but safety check)
    const checkRequestAbortedWithLogging = withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger);
    checkRequestAbortedWithLogging(abortSignal);

    // Check if request was cancelled
    checkRequestAbortedWithLogging(abortSignal);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: CHECK FOR PENDING TEST PLAN APPROVAL
    // ═══════════════════════════════════════════════════════════════════════
    const checkPendingApprovalWithLogging = withFunctionLogging(checkPendingApproval, 'checkPendingApproval', functionLogger);
    const approvalHandled = await checkPendingApprovalWithLogging({
      req,
      res,
      message,
      conversationId,
      userId,
      chatSessionId,
      workspace_id,
      checkRequestTimeout,
      abortSignal, // Pass abort signal for cancellation checks
      logger: functionLogger,
    });

    if (approvalHandled) {
      // ✅ FIX #2: unregisterActiveRequest is now async
      const unregisterActiveRequestWithLogging = withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger);
      await unregisterActiveRequestWithLogging(chatSessionId, userId);
      await functionLogger.flushSync();
      return; // Approval was handled, response already sent
    }

    // Check if request was cancelled
    checkRequestAbortedWithLogging(abortSignal);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: PARSE INTENT (Only if not responding to test plan) (FIX #5)
    // ═══════════════════════════════════════════════════════════════════════
    const parseIntentWithLogging = withFunctionLogging(parseIntent, 'parseIntent', functionLogger);
    const parsedIntent = await parseIntentWithLogging(
      message,
      context,
      chatSessionId,
      userId,
      workspace_id,
      checkRequestTimeout,
      abortSignal, // Pass abort signal for cancellation checks
      functionLogger,
      inputResult.mode || 'lite' // Pass mode for editor action detection
    );

    // Check if request was cancelled
    checkRequestAbortedWithLogging(abortSignal);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5.5: SMART TEST CASE RESOLVER
    // Only for platform_test intent — check if existing test cases match
    // ═══════════════════════════════════════════════════════════════════════
    // Smart Resolver: only when user did NOT provide an explicit URL.
    // If parsedIntent.page is set, the user gave a URL → they want a NEW test, not a replay.
    if (parsedIntent?.intent === 'platform_test' && !parsedIntent?.page) {
      try {
        const { TestCaseResolverService } = await import(
          '@/services/testing/resolver/test-case-resolver.service'
        );
        const resolverResult = await TestCaseResolverService.resolve({
          message,
          userId,
          workspaceId: workspace_id,
        });

        if (resolverResult.matchType === 'exact' && resolverResult.bestMatch) {
          // Redirect to regression (fast, background)
          parsedIntent.intent = 'run_regression';
          parsedIntent.savedTestCaseId = resolverResult.bestMatch.id;
          logger.info('[CHAT] Smart Resolver: exact match → run_regression', {
            testCaseId: resolverResult.bestMatch.id,
            testCaseName: resolverResult.bestMatch.name,
            score: resolverResult.bestMatch.score,
          });
        } else if (resolverResult.matchType === 'partial' && resolverResult.prefilledSteps?.length) {
          // Enrich with prefilled steps for LiteEngine
          parsedIntent.resolvedContext = {
            prefilledSteps: resolverResult.prefilledSteps,
            sourceTestCases: resolverResult.relatedCases?.map(c => ({
              id: c.id, name: c.name, matchScore: c.score,
            })),
            resolverStrategy: resolverResult.resolverMeta.strategy,
          };
          logger.info('[CHAT] Smart Resolver: partial match → prefilled steps', {
            prefilledStepsCount: resolverResult.prefilledSteps.length,
            sourceTestCases: resolverResult.relatedCases?.map(c => c.name),
          });
        }
        // 'none' → no changes, full LiteEngine
      } catch (error) {
        // Graceful degradation: if resolver fails, continue unchanged
        logger.warn('[CHAT] Smart Resolver failed, continuing with original intent', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 6: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
    // ═══════════════════════════════════════════════════════════════════════
    const routeToHandlerWithLogging = withFunctionLogging(routeToHandler, 'routeToHandler', functionLogger);
    await routeToHandlerWithLogging(req, res, {
      message,
      parsedIntent,
      userId,
      workspace_id,
      chatSessionId,
      conversationId,
      answers,
      context,
      abortSignal, // Pass abort signal for cancellation checks
      logger: functionLogger,
      mode: inputResult.mode || 'lite', // Pass mode from request
      attachments, // File attachments (images + documents)
    });

    // Unregister request on successful completion
    // ✅ FIX #2: unregisterActiveRequest is now async
    const unregisterActiveRequestWithLogging = withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger);
    await unregisterActiveRequestWithLogging(chatSessionId, userId);

    // Log handleChat success and flush
    functionLogger.logFunctionCall('handleChat', [req, res], { success: true });
    await functionLogger.flushSync();

  } catch (error) {
    // Log handleChat error
    functionLogger.logFunctionCall(
      'handleChat',
      [req, res],
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );

    // Unregister request on error
    if (chatSessionId && userId) {
      // ✅ FIX #2: unregisterActiveRequest is now async
      const unregisterActiveRequestWithLogging = withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger);
      await unregisterActiveRequestWithLogging(chatSessionId, userId);
    }

    // Flush logs before handling error
    await functionLogger.flushSync();

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
