import { Request, Response } from 'express';
import { logger } from '@/utils/logger';
import { PROGRESS } from './constants';
import { emitProcessingStep } from './utils';
import { handleClarificationRequest } from './clarification';
import { handlePlatformTest } from '../ai_test/handler';
import { handleApiTest } from '../api_test/handler';
import { handleGeneralChat } from '../general/handler';

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
  }
): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
  // ═══════════════════════════════════════════════════════════════════════

  emitProcessingStep(params.chatSessionId, 'generating_plan', '🚀 Processing your request...', PROGRESS.ROUTING);

  const intent = params.parsedIntent?.intent || 'general_chat';

  // Handle clarification requests (new!)
  if (intent === 'needs_clarification') {
    return await handleClarificationRequest(req, res, {
      parsedIntent: params.parsedIntent,
      userId: params.userId,
      chatSessionId: params.chatSessionId,
    });
  }

  if (intent === 'platform_test') {
    return await handlePlatformTest(req, res, {
      message: params.message,
      parsedIntent: params.parsedIntent,
      userId: params.userId,
      workspace_id: params.workspace_id,
      chatSessionId: params.chatSessionId,
      conversationId: params.conversationId,
      answers: params.answers,
    });
  }

  if (intent === 'api_test') {
    return await handleApiTest(req, res, {
      message: params.message,
      parsedIntent: params.parsedIntent,
      userId: params.userId,
      workspace_id: params.workspace_id,
      chatSessionId: params.chatSessionId,
      conversationId: params.conversationId,
      answers: params.answers,
    });
  }

  // general_chat
  return await handleGeneralChat(req, res, {
    message: params.message,
    userId: params.userId,
    chatSessionId: params.chatSessionId,
    context: params.context,
    userLanguage: params.parsedIntent?.userLanguage, // Pass language from intent parser (avoid re-detection)
  });
}
