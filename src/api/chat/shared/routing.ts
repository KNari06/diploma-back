import { Request, Response } from 'express';
import { INTENT_HANDLERS, getHandler } from './handler-registry';
import { PROGRESS } from './constants';
import { checkRequestAborted } from './request-cancellation';
import { emitProcessingStep } from './utils';
import { logger } from '@/utils/core/logger';

/**
 * STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
 * Uses dynamic handler registry instead of hardcoded if/else
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
  }
): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT (DYNAMIC)
  // ═══════════════════════════════════════════════════════════════════════

  emitProcessingStep(params.chatSessionId, 'generating_plan', '🚀 Processing your request...', PROGRESS.ROUTING);

  if (params.abortSignal) {
    checkRequestAborted(params.abortSignal);
  }

  const intent = params.parsedIntent?.intent || 'general_chat';

  logger.info('[ROUTING] Routing to handler', { intent, userId: params.userId });

  // Get handler from registry (dynamic lookup)
  const handler = getHandler(intent);

  if (!handler) {
    // Fallback to general_chat if handler not found
    logger.warn('[ROUTING] No handler found for intent, falling back to general_chat', { intent });
    const fallbackHandler = getHandler('general_chat');

    if (!fallbackHandler) {
      throw new Error('Critical error: general_chat handler not registered');
    }

    return await fallbackHandler(req, res, {
      message: params.message,
      userId: params.userId,
      workspace_id: params.workspace_id,
      chatSessionId: params.chatSessionId,
      context: params.context,
      abortSignal: params.abortSignal,
    });
  }

  // Call the handler with all params
  return await handler(req, res, {
    message: params.message,
    parsedIntent: params.parsedIntent,
    userId: params.userId,
    workspace_id: params.workspace_id,
    chatSessionId: params.chatSessionId,
    conversationId: params.conversationId,
    answers: params.answers,
    context: params.context,
    abortSignal: params.abortSignal,
  });
}
