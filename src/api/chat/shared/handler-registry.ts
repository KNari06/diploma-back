import { Request, Response } from 'express';
import type { ChatAttachment } from '../chat.types';
import type { ChatStore } from '@/services/utils/chat-store';
import { handlePlatformTest as handlePlatformTestOriginal } from '../ai_test/handler';
import { handleApiTest as handleApiTestOriginal } from '../api_test/handler';
import { handleGeneralChat as handleGeneralChatOriginal } from '../general/handler';
import { handleAddToPlanIntent } from '../regression/add-to-plan.handler';
import { handleAnalyzeFailureIntent } from '../regression/analyze-failure.handler';
import { handleCoverageAnalysisIntent } from '../regression/coverage-analysis.handler';
import { handleCreatePlanIntent } from '../regression/create-plan.handler';
import { handleFlakyReportIntent } from '../regression/flaky-report.handler';
import { handleManageModuleIntent } from '../regression/manage-module.handler';
import { handleManagePlanIntent } from '../regression/manage-plan.handler';
import { handleManageScheduleIntent } from '../regression/manage-schedule.handler';
import { handleRunByTagIntent } from '../regression/run-by-tag.handler';
import { handleRunModuleIntent } from '../regression/run-module.handler';
import { handleRunPlanIntent } from '../regression/run-plan.handler';
import { handleRunRegressionIntent } from '../regression/run-regression.handler';
import { handleSaveTestIntent } from '../regression/save-test.handler';
import { handleTestRecommendationsIntent } from '../regression/test-recommendations.handler';
import { handleEditorAction } from '../editor_action/handler';
import { handleMobileTest as handleMobileTestOriginal } from '../mobile_test/handler';
import { handleMobileAgent as handleMobileAgentOriginal } from '../mobile_agent/handler';
import { handleMobileAction as handleMobileActionOriginal } from '../mobile_action/handler';
import { handleApiFlowTest as handleApiFlowTestOriginal } from '../api_flow/handler';
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
    mode?: 'lite' | 'pro' | 'editor'; // Test execution mode (default: 'lite')
    executionStrategy?: 'standard' | 'exploration'; // Execution strategy from frontend
    attachments?: ChatAttachment[]; // File attachments (images + documents)
    /**
     * Persistence backend. Migrated handlers (general_chat, editor_action)
     * route reads/writes through ChatPersistence with this store. Legacy
     * handlers ignore it and continue writing to the global tables —
     * which is correct for them because the test-case scope blocks all
     * non-migrated intents to general_chat upstream (see intent-parsing.ts
     * `isTestCaseScope` guard). Default at the call sites is GLOBAL_STORE.
     */
    chatStore?: ChatStore;
    /** Test-case scope marker (UUID). Mirrors the controller-level binding. */
    testCaseId?: string;
    /**
     * Controller-resolved project (from the test-case access check). Handlers
     * that need it (mobile agent save tool) use it instead of a second lookup.
     */
    projectId?: string;
    /** Test case's access-checked project id (test-case scope only). See BUG-1. */
    testCaseProjectId?: string;
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
    mode: params.mode,
    executionStrategy: params.executionStrategy,
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
    workspace_id: params.workspace_id,
    userLanguage: params.parsedIntent?.userLanguage,
    abortSignal: params.abortSignal,
    mode: params.mode,
    attachments: params.attachments,
    // Strict boolean guard: LLM may return "false" (string), 0, or null — only trust actual boolean
    needsTools: params.parsedIntent?.needsTools === false ? false : undefined,
    // Pass through persistence + test-case scope. Underlying handler
    // routes saves through ChatPersistence using this store. When unset
    // (legacy global path), the original behavior is preserved.
    chatStore: params.chatStore,
    testCaseId: params.testCaseId,
    testCaseProjectId: params.testCaseProjectId,
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
    mode: params.mode,
    // Forward persistence binding + test-case scope: needs_clarification
    // is one of the few intents allowed in test-case chats, so saves
    // and WS emits MUST route through the per-test-case backend.
    chatStore: params.chatStore,
    testCaseId: params.testCaseId,
  });
};

/**
 * Wrapper for api_flow_test handler
 * Adapts original handler signature to IntentHandler type
 */
const handleApiFlowTest: IntentHandler = async (req, res, params) => {
  return handleApiFlowTestOriginal(req, res, {
    message: params.message,
    parsedIntent: params.parsedIntent,
    userId: params.userId,
    workspace_id: params.workspace_id,
    chatSessionId: params.chatSessionId,
    conversationId: params.conversationId,
    answers: params.answers,
    abortSignal: params.abortSignal,
    attachments: params.attachments,
    // Controller-resolved project (test-case scope). Global uploads fall back
    // to the chat session's bound project inside the handler.
    projectId: params.projectId,
  });
};

/**
 * Wrapper for mobile_test handler
 * Adapts original handler signature to IntentHandler type
 */
const handleMobileTest: IntentHandler = async (req, res, params) => {
  return handleMobileTestOriginal(req, res, {
    message: params.message,
    parsedIntent: params.parsedIntent,
    userId: params.userId,
    workspace_id: params.workspace_id,
    chatSessionId: params.chatSessionId,
    conversationId: params.conversationId,
    answers: params.answers,
    abortSignal: params.abortSignal,
    mode: params.mode,
  });
};

/**
 * Wrapper for mobile_agent handler — multi-step AI Agent for the mobile
 * editor. Parallels the web `general_chat` sub-agent pipeline.
 */
const handleMobileAgent: IntentHandler = async (req, res, params) => {
  return handleMobileAgentOriginal(req, res, {
    message: params.message,
    parsedIntent: params.parsedIntent,
    userId: params.userId,
    workspace_id: params.workspace_id,
    chatSessionId: params.chatSessionId,
    conversationId: params.conversationId,
    context: params.context,
    abortSignal: params.abortSignal,
    mode: params.mode,
    // Forward the persistence backend so test-case-scoped mobile chats
    // land in the test-case store instead of leaking to the global tables.
    chatStore: params.chatStore,
    // Forward the controller-resolved project + test-case binding so the save
    // tool resolves the project (instead of dead-ending on the chat_sessions
    // lookup) and the handler can eagerly resolve the open test case's steps.
    projectId: params.projectId,
    testCaseId: params.testCaseId,
  });
};

/**
 * Wrapper for mobile_action handler — single atomic action on a live
 * device. Parallels the web `editor_action` fast-path.
 */
const handleMobileAction: IntentHandler = async (req, res, params) => {
  return handleMobileActionOriginal(req, res, {
    message: params.message,
    parsedIntent: params.parsedIntent,
    userId: params.userId,
    workspace_id: params.workspace_id,
    chatSessionId: params.chatSessionId,
    conversationId: params.conversationId,
    context: params.context,
    abortSignal: params.abortSignal,
    mode: params.mode,
    // Forward the persistence backend (see handleMobileAgent above).
    chatStore: params.chatStore,
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
  run_regression: handleRunRegressionIntent,

  // New hierarchy intents
  run_plan: handleRunPlanIntent,
  create_plan: handleCreatePlanIntent,
  add_to_plan: handleAddToPlanIntent,
  run_module: handleRunModuleIntent,
  run_by_tag: handleRunByTagIntent,

  // AI intelligence intents
  analyze_failure: handleAnalyzeFailureIntent,
  test_recommendations: handleTestRecommendationsIntent,
  coverage_analysis: handleCoverageAnalysisIntent,
  flaky_report: handleFlakyReportIntent,

  // Management intents (call qa_manage_* via the central tool pipeline)
  manage_schedule: handleManageScheduleIntent,
  manage_module: handleManageModuleIntent,
  manage_plan: handleManagePlanIntent,

  // Editor mode intent
  editor_action: handleEditorAction,

  // Mobile testing intent (async BullMQ job for recorded steps)
  mobile_test: handleMobileTest,

  // Mobile editor — single atomic action (fast path, parallels editor_action)
  mobile_action: handleMobileAction,

  // Mobile editor AI agent (multi-step authoring/exploration, parallels general_chat)
  mobile_agent: handleMobileAgent,

  // API flow testing intent (Swagger/OpenAPI/Postman chain execution)
  api_flow_test: handleApiFlowTest,
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
    run_regression: 'User wants to run a saved test case',
    run_plan: 'User wants to run a regression plan (custom test set)',
    create_plan: 'User wants to create a regression plan',
    add_to_plan: 'User wants to add module/flow to a regression plan',
    run_module: 'User wants to run all tests in a module',
    run_by_tag: 'User wants to run tests by tag (e.g., "run critical tests")',
    analyze_failure: 'User wants to understand why a test failed (root-cause analysis)',
    test_recommendations: 'User wants suggestions on what to test next',
    coverage_analysis: 'User wants to see test coverage gaps and what\'s not tested',
    flaky_report: 'User wants to find flaky / unreliable tests (inconsistent pass-fail history)',
    manage_schedule: 'User wants to create/update/activate/deactivate/delete a scheduled (cron) run',
    manage_module: 'User wants to create or update/rename a test module',
    manage_plan: 'User wants to create/update a regression plan or add/remove an item from it',
    editor_action: 'User wants to perform a direct action on the live page in editor mode',
    mobile_test: 'User wants to run a mobile (Android/iOS) test on recorded steps',
    mobile_action: 'User is in the mobile editor and wants ONE direct action on the current screen: tap, swipe, type, scroll, press key, back. Executed immediately, no planning.',
    mobile_agent: 'User is in the mobile editor and wants the agent to handle something multi-step: author a test, explore the app, answer questions about the screen, fill a whole form. Heavier pipeline.',
    api_flow_test: 'User wants to test an API flow from a Swagger/OpenAPI/Postman spec URL or file, or pasted cURL commands',
  };
}
