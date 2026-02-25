import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import type { ChatAttachment } from '../chat.types';
import { PROGRESS } from './constants';
import { getHandler, type IntentHandler } from './handler-registry';
import { checkRequestAborted } from './request-cancellation';
import { emitProcessingStep } from './utils';

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
    logger?: FunctionLogger;
    mode?: 'lite' | 'pro' | 'editor'; // Test execution mode (default: 'lite')
    attachments?: ChatAttachment[]; // File attachments (images + documents)
  }
): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT (DYNAMIC)
  // ═══════════════════════════════════════════════════════════════════════

  const emitProcessingStepWithLogging = params.logger
    ? withFunctionLogging(emitProcessingStep, 'emitProcessingStep', params.logger)
    : emitProcessingStep;
  emitProcessingStepWithLogging(
    params.chatSessionId,
    'generating_plan',
    'Processing your request...',
    PROGRESS.ROUTING
  );

  if (params.abortSignal) {
    const checkRequestAbortedWithLogging = params.logger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', params.logger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(params.abortSignal);
  }

  const intent = params.parsedIntent?.intent || 'general_chat';

  logger.info('[ROUTING] Routing to handler', {
    intent,
    userId: params.userId,
  });

  // Get handler from registry (dynamic lookup)
  let handler: IntentHandler | undefined = getHandler(intent);

  // Fallback to general_chat if handler not found
  if (!handler) {
    logger.warn('[ROUTING] No handler found for intent, falling back to general_chat', {
      intent,
    });
    handler = getHandler('general_chat');

    if (!handler) {
      throw new Error('Critical error: general_chat handler not registered');
    }
  }

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
    mode: params.mode,
    attachments: params.attachments,
  });
}
