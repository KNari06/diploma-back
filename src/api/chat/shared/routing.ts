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

  const intent = params.parsedIntent?.intent || 'general_chat';
  const routingMessage = getRoutingMessage(intent);
  emitProcessingStepWithLogging(
    params.chatSessionId,
    'generating_plan',
    routingMessage,
    PROGRESS.ROUTING
  );

  if (params.abortSignal) {
    const checkRequestAbortedWithLogging = params.logger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', params.logger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(params.abortSignal);
  }

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

/**
 * Get context-aware routing message based on intent type.
 */
function getRoutingMessage(intent: string): string {
  switch (intent) {
    case 'general_chat':
      return 'Connecting to assistant...';
    case 'platform_test':
      return 'Preparing test environment...';
    case 'api_test':
      return 'Setting up API test...';
    case 'run_regression':
      return 'Loading saved test...';
    case 'run_plan':
      return 'Loading regression plan...';
    case 'run_module':
      return 'Loading test module...';
    case 'run_by_tag':
      return 'Finding tests by tag...';
    case 'save_test':
      return 'Saving your test...';
    case 'analyze_failure':
      return 'Starting failure analysis...';
    case 'coverage_analysis':
      return 'Analyzing coverage...';
    case 'test_recommendations':
      return 'Generating recommendations...';
    case 'create_plan':
    case 'add_to_plan':
      return 'Preparing regression plan...';
    case 'editor_action':
      return 'Executing action...';
    default:
      return 'Processing your request...';
  }
}
