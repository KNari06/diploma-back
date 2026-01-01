import { Request, Response } from 'express';
import { handlePlatformTest } from '../ai_test/handler';
import { handleApiTest } from '../api_test/handler';
import { handleGeneralChat } from '../general/handler';
import { handleClarificationRequest } from './clarification';
import { PROGRESS } from './constants';
import { checkRequestAborted } from './request-cancellation';
import { emitProcessingStep } from './utils';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';

/**
 * STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
 */
export async function routeToHandler(
  req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent: any;
    userId: string;
    workspace_id: string;
    chatSessionId?: string;
    conversationId?: string;
    answers?: Record<string, any>;
    context?: any;
    abortSignal?: AbortSignal;
    logger?: FunctionLogger;
    mode?: 'lite' | 'pro'; // Test execution mode (default: 'lite')
  }
): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
  // ═══════════════════════════════════════════════════════════════════════

  const emitProcessingStepWithLogging = params.logger
    ? withFunctionLogging(emitProcessingStep, 'emitProcessingStep', params.logger)
    : emitProcessingStep;
  emitProcessingStepWithLogging(params.chatSessionId, 'generating_plan', '🚀 Processing your request...', PROGRESS.ROUTING);

  if (params.abortSignal) {
    const checkRequestAbortedWithLogging = params.logger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', params.logger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(params.abortSignal);
  }

  const intent = params.parsedIntent?.intent || 'general_chat';

  // Handle clarification requests (new!)
  if (intent === 'needs_clarification') {
    const handleClarificationRequestWithLogging = params.logger
      ? withFunctionLogging(handleClarificationRequest, 'handleClarificationRequest', params.logger)
      : handleClarificationRequest;
    return await handleClarificationRequestWithLogging(req, res, {
      parsedIntent: params.parsedIntent,
      userId: params.userId,
      chatSessionId: params.chatSessionId,
      abortSignal: params.abortSignal,
    });
  }

  if (intent === 'platform_test') {
    const handlePlatformTestWithLogging = params.logger
      ? withFunctionLogging(handlePlatformTest, 'handlePlatformTest', params.logger)
      : handlePlatformTest;
    return await handlePlatformTestWithLogging(req, res, {
      message: params.message,
      parsedIntent: params.parsedIntent,
      userId: params.userId,
      workspace_id: params.workspace_id,
      chatSessionId: params.chatSessionId,
      conversationId: params.conversationId,
      answers: params.answers,
      abortSignal: params.abortSignal,
      logger: params.logger,
      mode: params.mode || 'lite', // Pass mode to handler
    });
  }

  if (intent === 'api_test') {
    const handleApiTestWithLogging = params.logger
      ? withFunctionLogging(handleApiTest, 'handleApiTest', params.logger)
      : handleApiTest;
    return await handleApiTestWithLogging(req, res, {
      message: params.message,
      parsedIntent: params.parsedIntent,
      userId: params.userId,
      workspace_id: params.workspace_id,
      chatSessionId: params.chatSessionId,
      conversationId: params.conversationId,
      answers: params.answers,
      abortSignal: params.abortSignal,
      logger: params.logger,
    });
  }

  // general_chat
  const handleGeneralChatWithLogging = params.logger
    ? withFunctionLogging(handleGeneralChat, 'handleGeneralChat', params.logger)
    : handleGeneralChat;
  return await handleGeneralChatWithLogging(req, res, {
    message: params.message,
    userId: params.userId,
    chatSessionId: params.chatSessionId,
    context: params.context,
    userLanguage: params.parsedIntent?.userLanguage, // Pass language from intent parser (avoid re-detection)
    abortSignal: params.abortSignal,
    logger: params.logger,
  });
}
