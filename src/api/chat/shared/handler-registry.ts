import { Request, Response } from 'express';
import { handlePlatformTest as handlePlatformTestOriginal } from '../ai_test/handler';
import { handleApiTest as handleApiTestOriginal } from '../api_test/handler';
import { handleGeneralChat as handleGeneralChatOriginal } from '../general/handler';
import { handleCreateSuiteIntent } from '../regression/create-suite.handler';
import { handleRunRegressionIntent } from '../regression/run-regression.handler';
import { handleSaveTestIntent } from '../regression/save-test.handler';
import { handleClarificationRequest as handleClarificationOriginal } from './clarification';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER REGISTRY - Dynamic Intent Routing System
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module provides a centralized registry for all intent handlers.
 * It replaces hardcoded if/else routing with a dynamic, extensible system.
 *
 * Benefits:
 * - Single source of truth for available intents
 * - Easy to add new intents (just add handler to registry)
 * - Dynamic prompt building (getAvailableIntents())
 * - Type-safe handler lookup
 */

/**
 * Intent handler function type
 * All handlers must conform to this signature for consistent routing
 */
export type IntentHandler = (
  req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent?: any;
    userId: string;
    workspace_id: string;
    chatSessionId?: string;
    conversationId?: string;
    answers?: Record<string, any>;
    context?: any;
    abortSignal?: AbortSignal;
  }
) => Promise<void>;

/**
 * Wrapper for platform_test handler
 * Adapts original handler signature to IntentHandler type
 * Validates that parsedIntent is present (required for platform_test)
 */
const handlePlatformTest: IntentHandler = async (req, res, params) => {
  if (!params.parsedIntent) {
    throw new Error('platform_test handler requires parsedIntent');
  }
  return handlePlatformTestOriginal(req, res, {
    message: params.message,
    parsedIntent: params.parsedIntent,
    userId: params.userId,
    workspace_id: params.workspace_id,
    chatSessionId: params.chatSessionId,
    conversationId: params.conversationId,
    answers: params.answers,
    abortSignal: params.abortSignal,
  });
};

/**
 * Wrapper for api_test handler
 * Adapts original handler signature to IntentHandler type
 * Validates that parsedIntent is present (required for api_test)
 */
const handleApiTest: IntentHandler = async (req, res, params) => {
  if (!params.parsedIntent) {
    throw new Error('api_test handler requires parsedIntent');
  }
  return handleApiTestOriginal(req, res, {
    message: params.message,
    parsedIntent: params.parsedIntent,
    userId: params.userId,
    workspace_id: params.workspace_id,
    chatSessionId: params.chatSessionId,
    conversationId: params.conversationId,
    answers: params.answers,
    abortSignal: params.abortSignal,
  });
};

/**
 * Wrapper for general_chat handler
 * Adapts original handler signature to IntentHandler type
 * Extracts userLanguage from parsedIntent for localization
 */
const handleGeneralChat: IntentHandler = async (req, res, params) => {
  return handleGeneralChatOriginal(req, res, {
    message: params.message,
    userId: params.userId,
    chatSessionId: params.chatSessionId,
    context: params.context,
    userLanguage: params.parsedIntent?.userLanguage,
    abortSignal: params.abortSignal,
  });
};

/**
 * Wrapper for needs_clarification handler
 * Adapts original handler signature to IntentHandler type
 * Only requires parsedIntent (no message needed)
 */
const handleClarificationRequest: IntentHandler = async (req, res, params) => {
  return handleClarificationOriginal(req, res, {
    parsedIntent: params.parsedIntent,
    userId: params.userId,
    chatSessionId: params.chatSessionId,
    abortSignal: params.abortSignal,
  });
};

/**
 * Registry of all available intent handlers
 * Single source of truth for intent routing
 */
export const INTENT_HANDLERS: Record<string, IntentHandler> = {
  // Core intents
  platform_test: handlePlatformTest,
  api_test: handleApiTest,
  general_chat: handleGeneralChat,
  needs_clarification: handleClarificationRequest,

  // Regression intents
  save_test: handleSaveTestIntent,
  create_suite: handleCreateSuiteIntent,
  run_regression: handleRunRegressionIntent,
};

/**
 * Get list of all available intent types
 * Used for dynamic prompt building in intent parser
 * Returns array of intent names that have registered handlers
 *
 * @returns Array of intent type strings (e.g., ['platform_test', 'api_test', ...])
 */
export function getAvailableIntents(): string[] {
  return Object.keys(INTENT_HANDLERS);
}

/**
 * Check if intent has a registered handler
 * Used for validation before routing
 *
 * @param intent - Intent type to check
 * @returns True if handler exists, false otherwise
 */
export function hasHandler(intent: string): boolean {
  return intent in INTENT_HANDLERS;
}

/**
 * Get handler function for a specific intent
 * Used by routing system to dynamically dispatch to correct handler
 *
 * @param intent - Intent type to get handler for
 * @returns Handler function or undefined if not found
 */
export function getHandler(intent: string): IntentHandler | undefined {
  return INTENT_HANDLERS[intent];
}

/**
 * Get human-readable descriptions for all intents
 * Used in AI prompts to help model understand available intents
 *
 * @returns Map of intent names to their descriptions
 */
export function getIntentDescriptions(): Record<string, string> {
  return {
    platform_test: 'User wants to run a new UI/website test',
    api_test: 'User wants to run a new API test',
    general_chat: 'User wants to talk, ask, or discuss',
    needs_clarification: 'Uncertain about user intent, need clarification',
    save_test: 'User wants to save current/last test flow for replay',
    create_suite: 'User wants to create a regression suite from test cases',
    run_regression: 'User wants to run a saved test case or suite',
  };
}
