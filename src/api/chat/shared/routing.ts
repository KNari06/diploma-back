import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import type { ChatAttachment } from '../chat.types';
import type { ChatStore } from '@/services/utils/chat-store';
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
    executionStrategy?: 'standard' | 'exploration'; // Execution strategy from frontend
    attachments?: ChatAttachment[]; // File attachments (images + documents)
    /**
     * Persistence backend for this request. Set by the controller branch:
     * GLOBAL_STORE for legacy workspace chat, TESTCASE_STORE for per-test-
     * case chat. Handlers MUST use ChatPersistence.* with this store rather
     * than calling ChatService.* directly — otherwise test-case writes leak
     * into the global tables. New handlers thread this through unchanged;
     * legacy handlers default to GLOBAL_STORE so the global path stays
     * byte-for-byte identical until they're individually migrated.
     */
    chatStore?: ChatStore;
    /**
     * The exact RequestKey under which this request was registered with
     * the cancellation registry. Handlers don't need this for happy-path
     * work — but pass it through so quick-action endpoints / sub-handlers
     * that may emit further WS traffic can target the right room.
     */
    testCaseId?: string;
    /**
     * Controller-resolved project (from the test-case access check). Threaded
     * to handlers that need it without a second lookup — the mobile agent's
     * save tool uses it so it doesn't dead-end on the chat_sessions lookup.
     */
    projectId?: string;
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
    PROGRESS.ROUTING,
    undefined,
    // Pass testCaseId for dual-emit into `chat:tc:<tcid>` room. When
    // unset (legacy global path) emit goes only to `chat:<sessionId>`.
    params.testCaseId,
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
    executionStrategy: params.executionStrategy,
    attachments: params.attachments,
    // Pass through persistence backend + test-case binding. Migrated
    // handlers (general_chat, editor_action) read these and route their
    // saves accordingly. Non-migrated handlers receive but ignore them
    // (TypeScript widens IntentHandlerParams below to accept extras).
    chatStore: params.chatStore,
    testCaseId: params.testCaseId,
    projectId: params.projectId,
  });
}

/**
 * Get context-aware routing message based on intent type.
 */
function getRoutingMessage(intent: string): string {
  switch (intent) {
    case 'general_chat':
      return 'Thinking...';
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
    case 'flaky_report':
      return 'Scanning for flaky tests...';
    case 'manage_schedule':
      return 'Updating the schedule...';
    case 'manage_module':
      return 'Updating the module...';
    case 'manage_plan':
      return 'Updating the regression plan...';
    case 'test_recommendations':
      return 'Generating recommendations...';
    case 'create_plan':
    case 'add_to_plan':
      return 'Preparing regression plan...';
    case 'editor_action':
      return 'Executing action...';
    case 'mobile_test':
      return 'Preparing mobile emulator...';
    case 'mobile_action':
      return 'Tapping on the device...';
    case 'mobile_agent':
      return 'Reading the mobile screen...';
    default:
      return 'Processing your request...';
  }
}
