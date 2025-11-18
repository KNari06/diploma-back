import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { convertRoleForOpenAI } from '@/utils/chat-helpers';
import { Request, Response } from 'express';

// New services
import { WorkspaceService } from '@/services/core/workspace.service';
import { ProjectContextService } from '@/services/utils/project-context.service';

// Testing services - API
import { ApiTestPlanService } from '@/services/testing/api/api-test-plan.service';
import { executeApiTest } from '@/services/testing/api/apiTest.service';
import { ApiFuzzingExecutorService } from '@/services/testing/api/fuzzing/api-fuzzing-executor.service';
import { IntelligentApiFuzzerService } from '@/services/testing/api/fuzzing/intelligent-api-fuzzer.service';

// Testing services - UI
import { confirmTestPlan, requestMissingInformation, runAutonomousExploration } from '@/services/testing/ui/autonomous/autonomous-orchestrator.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';

// Testing services - Plans
import { getLatestPendingTestPlan, getTestPlan, saveTestPlan } from '@/services/testing/plans/exploration-cache.service';

// Testing services - Shared
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';

// Existing services
import { detectUserApproval } from '@/services/ai/ai-helpers.service';
import { parseUserIntent } from '@/services/ai/intentParser.service';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { autoEmbedOldMessages, searchChatHistory } from '@/services/chat-embeddings.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { detectLanguage, searchKB } from '@/services/kb/kb.service';
import { RulesCacheService } from '@/services/kb/rules-cache.service';
import { ChatService } from '@/services/utils/chat.service';

// Types
import { ChatProcessingStepPayload, ChatTestUpdatePayload } from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';
import { ChatRequest } from './chat.types';

// Prompts
import { buildChatSystemPrompt } from '@/ai/prompts';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONSTANTS (FIX #9: Centralized magic numbers)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CONSTANTS = {
  // Chat history
  RECENT_MESSAGES_LIMIT: 20,

  // Knowledge base search
  KB_MATCH_COUNT: 3,
  KB_MATCH_THRESHOLD: 0.6,

  // Timeouts
  FUZZING_TIMEOUT: 30000, // 30 seconds
  AUTO_EMBED_TIMEOUT: 5000, // 5 seconds
  CHAT_REQUEST_TIMEOUT: 30000, // 30 seconds max for entire chat request

  // Test plan expiration
  TEST_PLAN_EXPIRY_HOURS: 24,
} as const;

// Progress percentages for consistent WebSocket updates
const PROGRESS = {
  START: 0,
  ENRICHING: 10,
  INTENT_PARSING: 20,
  INTENT_PARSED: 40,
  ROUTING: 50,
} as const;

// Response messages
const MESSAGES = {
  APPROVAL_UNCLEAR: '❓ I didn\'t quite understand. Could you please clarify?\n\n✅ Approve and run the test?\n❌ Cancel?',
  TEST_REJECTED: '❌ Test plan canceled. Feel free to request a different test or ask any questions!',
  REQUEST_TIMEOUT: '⏱️ Request timeout - please try again',
  INVALID_REQUEST: '❌ Invalid request - message is required',
  AUTH_REQUIRED: '🔒 Authentication required',
} as const;

// FIX #7: Centralized UUID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate UUID format
 */
function isValidUUID(uuid: string | undefined): boolean {
  if (!uuid || typeof uuid !== 'string') return false;
  return UUID_REGEX.test(uuid);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAIN CHAT HANDLER (REFACTORED - PRODUCTION READY)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE:
 * 1. Input validation (req.body, req.user, message)
 * 2. Workspace check (mandatory)
 * 3. Chat session management
 * 4. Check pending test plan approval
 * 5. Parse intent (platform_test, api_test, general_chat)
 * 6. Route to appropriate handler
 *
 * FIXES:
 * - FIX #1-2: Input validation
 * - FIX #3-5: Error handling for all async operations
 * - FIX #6: Response already sent check
 * - FIX #8: Global timeout for entire request
 * - FIX #11: Using PROGRESS constants
 */
export const handleChat = async (req: Request, res: Response): Promise<void> => {
  // FIX #8: Setup global timeout for entire request
  const requestStartTime = Date.now();
  const checkRequestTimeout = () => {
    if (Date.now() - requestStartTime > CONSTANTS.CHAT_REQUEST_TIMEOUT) {
      throw new Error(`Request timeout after ${CONSTANTS.CHAT_REQUEST_TIMEOUT / 1000}s`);
    }
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 0: INPUT VALIDATION (FIX #1 & #2)
    // ═══════════════════════════════════════════════════════════════════════

    // Validate req.user (FIX #2)
    if (!req.user || !req.user.id) {
      logger.error('[CHAT] Authentication required - req.user missing', {
        hasReqUser: !!req.user,
        hasUserId: !!req.user?.id,
      });
      res.status(401).json({
        success: false,
        error: MESSAGES.AUTH_REQUIRED,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const userId = req.user.id;

    // Validate req.body (FIX #1)
    if (!req.body || typeof req.body !== 'object') {
      logger.error('[CHAT] Invalid request body', { userId });
      res.status(400).json({
        success: false,
        error: MESSAGES.INVALID_REQUEST,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { message, context, sessionId, conversationId, answers } = req.body as ChatRequest;

    // Validate message (FIX #1)
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      logger.error('[CHAT] Message is required', { userId, messageType: typeof message });
      res.status(400).json({
        success: false,
        error: MESSAGES.INVALID_REQUEST,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[CHAT] Request received', {
      userId,
      messageLength: message.length,
      hasSession: !!sessionId,
      hasConversation: !!conversationId,
      hasAnswers: !!answers,
      timeout: CONSTANTS.CHAT_REQUEST_TIMEOUT,
    });

    checkRequestTimeout(); // Check timeout after validation

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: WORKSPACE CHECK (MANDATORY!) (FIX #3)
    // ═══════════════════════════════════════════════════════════════════════

    let workspace_id: string;
    try {
      const workspaceResult = await WorkspaceService.checkOrCreateWorkspace(userId);
      workspace_id = workspaceResult.workspace_id;

      if (workspaceResult.is_new) {
      logger.info('[CHAT] Created new workspace', { userId, workspace_id });
    }
    } catch (workspaceError) {
      logger.error('[CHAT] WorkspaceService failed', {
        error: workspaceError instanceof Error ? workspaceError.message : String(workspaceError),
        userId,
      });
      throw new Error(`Failed to initialize workspace: ${workspaceError instanceof Error ? workspaceError.message : 'Unknown error'}`);
    }

    checkRequestTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: CHAT SESSION MANAGEMENT (FIX #4)
    // ═══════════════════════════════════════════════════════════════════════

    let chatSessionId: string | undefined;
    try {
      chatSessionId = await getOrCreateChatSession(userId, sessionId, workspace_id);
      logger.debug('[CHAT] Chat session ready', {
        chatSessionId: chatSessionId || 'none',
        providedSessionId: sessionId || 'none',
      });
    } catch (sessionError) {
      logger.warn('[CHAT] getOrCreateChatSession failed, continuing without session', {
        error: sessionError instanceof Error ? sessionError.message : String(sessionError),
          userId,
      });
      // Continue without session (graceful degradation)
      chatSessionId = undefined;
    }

    // Emit: Enriching context (FIX #11: Using PROGRESS constants)
    emitProcessingStep(chatSessionId, 'enriching_context', '🔍 Analyzing your request...', PROGRESS.ENRICHING);

    checkRequestTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: CHECK FOR PENDING TEST PLAN APPROVAL (MUST BE FIRST!)
    // ═══════════════════════════════════════════════════════════════════════

    const approvalHandled = await handlePendingTestPlanApproval({
      req,
      res,
      message,
      conversationId,
              userId,
            chatSessionId,
            workspace_id,
          });

    // If approval was handled (approved/rejected/clarification), return early
    if (approvalHandled) {
          return;
    }

    checkRequestTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: PARSE INTENT (Only if not responding to test plan) (FIX #5)
    // ═══════════════════════════════════════════════════════════════════════

    emitProcessingStep(chatSessionId, 'parsing_intent', '🧠 Understanding what you need...', PROGRESS.INTENT_PARSING);

    // Get chat history for context
    const chatHistory = await getChatHistoryForIntent(chatSessionId, userId); // SECURITY: Pass userId for verification

    checkRequestTimeout();

    // Parse intent with error handling (FIX #5)
    let parsedIntent: any;
    try {
      parsedIntent = await parseUserIntent(
      message,
        { chatHistory },
      workspace_id
    );
    } catch (intentError) {
      logger.error('[CHAT] parseUserIntent failed', {
        error: intentError instanceof Error ? intentError.message : String(intentError),
        userId,
        messageLength: message.length,
      });
      // Fallback to general_chat if intent parsing fails
      parsedIntent = { intent: 'general_chat', confidence: 0 };
    }

    // Emit detailed intent information
    const intentMessage = buildIntentMessage(parsedIntent);
    emitProcessingStep(chatSessionId, 'parsing_intent', intentMessage, PROGRESS.INTENT_PARSED);

    const intent = parsedIntent?.intent || 'general_chat';

    logger.info('[CHAT] Intent parsed', {
      intent,
      scope: parsedIntent?.scope,
      confidence: parsedIntent?.confidence,
      usedRAG: parsedIntent?.metadata?.usedRAG,
    });

    checkRequestTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
    // ═══════════════════════════════════════════════════════════════════════

    emitProcessingStep(chatSessionId, 'generating_plan', '🚀 Processing your request...', PROGRESS.ROUTING);

    if (intent === 'platform_test') {
      return await handlePlatformTest(req, res, {
        message,
        parsedIntent,
        userId,
        workspace_id,
        chatSessionId,
        conversationId,
        answers,
      });
    }

    if (intent === 'api_test') {
      return await handleApiTest(req, res, {
        message,
        parsedIntent,
        userId,
        workspace_id,
        chatSessionId,
        conversationId,
        answers,
      });
    }

    // general_chat
    return await handleGeneralChat(req, res, {
      message,
      userId,
      chatSessionId,
      context,
    });

  } catch (error) {
    // FIX #6: Check if response already sent
    if (res.headersSent) {
      logger.warn('[CHAT] Response already sent, cannot send error response', {
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

/**
 * Get chat history for intent parsing (extracted helper)
 */
async function getChatHistoryForIntent(
  chatSessionId: string | undefined,
  userId?: string // SECURITY: Optional userId for verification
): Promise<Array<{ role: string; content: string }>> {
  if (!chatSessionId) {
    return [];
  }

  try {
    const recentMessages = await ChatService.getRecentMessages(
      chatSessionId,
      userId, // SECURITY: Pass userId for verification
      CONSTANTS.RECENT_MESSAGES_LIMIT
    );
    // Convert 'ai' role to 'assistant' for OpenAI compatibility
    const chatHistory = recentMessages.map(msg => ({
      role: convertRoleForOpenAI(msg.role),
      content: msg.content,
    }));

    logger.debug('[CHAT] Retrieved chat history for intent parsing', {
      historyLength: chatHistory.length,
    });

    return chatHistory;
  } catch (error) {
    logger.warn('[CHAT] Failed to get chat history, continuing without it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: HANDLE PENDING TEST PLAN APPROVAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Checks if user has a pending test plan and processes their approval/rejection.
 * Returns true if approval was handled (and response sent), false otherwise.
 */
async function handlePendingTestPlanApproval(params: {
  req: Request;
  res: Response;
  message: string;
  conversationId?: string;
  userId: string;
  chatSessionId?: string;
  workspace_id: string;
}): Promise<boolean> {
  const { req, res, message, conversationId, userId, chatSessionId, workspace_id } = params;

  logger.info('🔍 [APPROVAL_CHECK] Checking for pending test plan approval', {
    userId: userId.substring(0, 8) + '...',
    message: message.substring(0, 50),
    hasConversationId: !!conversationId,
    conversationId: conversationId || 'NOT PROVIDED',
    chatSessionId: chatSessionId?.substring(0, 8) + '...' || 'none',
  });

  // Find pending test plan (parallel search for performance)
  const pendingPlan = await findPendingTestPlan(conversationId, userId);

  if (!pendingPlan) {
    logger.info('[CHAT] No pending test plan found', {
      userId: userId.substring(0, 8) + '...',
      conversationId: conversationId || 'none',
    });
    return false; // No approval to handle
  }

  if (pendingPlan.status !== 'pending_confirmation') {
    logger.info('[CHAT] Found plan but not pending confirmation', {
      planId: pendingPlan.id,
      status: pendingPlan.status,
    });
    return false; // Plan exists but not awaiting approval
  }

  // User is responding to test plan - process approval/rejection
  logger.info('🔍 [CHAT] Found pending test plan, checking for approval/rejection', {
    planId: pendingPlan.id,
    scope: pendingPlan.scope,
    createdAt: pendingPlan.createdAt,
    userMessage: message,
  });

  const approvalResult = await detectUserApproval(message);

  logger.info('[CHAT] Test plan response detected', {
    planId: pendingPlan.id,
    approved: approvalResult.approved,
    confidence: approvalResult.confidence,
  });

  // Handle unclear response - if confidence is too low, continue with normal flow
  // This allows users to ask questions or modify the plan instead of just approving/rejecting
  if (approvalResult.confidence < 0.5) {
    logger.info('[CHAT] Approval detection unclear, continuing with normal chat flow', {
      planId: pendingPlan.id,
      message: message.substring(0, 50),
      confidence: approvalResult.confidence,
      reasoning: 'User message might be a question or modification request, not approval/rejection',
    });
    // Return false to continue with normal intent parsing flow
    // User can still approve/reject later with clearer message
    return false;
  }

  // Handle approval
  if (approvalResult.approved === true) {
    logger.info('🟢 [APPROVAL] Test approved, executing now...', {
      planId: pendingPlan.id,
      userId,
      chatSessionId,
      scope: pendingPlan.scope,
    });

    await executeApprovedTestPlan(req, res, {
      planId: pendingPlan.id,
      userId,
      chatSessionId,
      workspace_id,
      userMessage: message, // FIX #14: Pass actual user message
    });
    return true;
  }

  // Handle rejection
  if (approvalResult.approved === false) {
    logger.info('[CHAT] Test plan rejected', { planId: pendingPlan.id });

    await saveAndRespond(
      chatSessionId,
      res,
      message,
      MESSAGES.TEST_REJECTED
    );
    return true;
  }

  // Shouldn't reach here, but handle gracefully
  return false;
}

/**
 * Find pending test plan (parallel search for performance)
 */
async function findPendingTestPlan(
  conversationId: string | undefined,
  userId: string
): Promise<any | null> {
  logger.info('🔍 [PENDING_PLAN_SEARCH] Starting parallel search', {
    conversationId: conversationId || 'NONE',
    userId: userId.substring(0, 8) + '...',
  });

  // Validate conversationId format
  const isValidConversationId = conversationId && isValidUUID(conversationId);

  if (conversationId && !isValidConversationId) {
    logger.warn('⚠️ [PENDING_PLAN_SEARCH] Invalid conversationId format, ignoring', {
      conversationId,
      userId,
    });
  }

  // Run both queries in parallel (50ms instead of 100ms)
  const [planByConversation, latestPlan] = await Promise.all([
    isValidConversationId ? getTestPlan(conversationId, userId) : Promise.resolve(null),
    getLatestPendingTestPlan(userId),
  ]);

  // Prefer plan by conversationId, fallback to latest
  const pendingPlan = planByConversation || latestPlan;

  if (pendingPlan) {
    if (planByConversation) {
      logger.info('✅ [PENDING_PLAN_SEARCH] Found plan by conversationId!', {
        planId: pendingPlan.id,
        status: pendingPlan.status,
        scope: pendingPlan.scope,
        searchMethod: 'conversationId',
      });
    } else {
      logger.info('✅ [PENDING_PLAN_SEARCH] Found plan via FALLBACK (latest pending)!', {
        planId: pendingPlan.id,
        status: pendingPlan.status,
        scope: pendingPlan.scope,
        createdAt: pendingPlan.createdAt,
        searchMethod: 'fallback',
      });
    }
  } else {
    logger.info('ℹ️ [PENDING_PLAN_SEARCH] No pending plan found', {
      userId,
      triedConversationId: conversationId || 'none',
      conversationIdValid: isValidConversationId,
    });
  }

  return pendingPlan;
}

/**
 * Save message to chat history and send response
 */
async function saveAndRespond(
  chatSessionId: string | undefined,
  res: Response,
  userMessage: string,
  aiMessage: string
): Promise<void> {
  if (chatSessionId) {
    await ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: userMessage },
      { role: 'ai', content: aiMessage },
    ]);
  }

  res.json({
    reply: aiMessage,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: PLATFORM TEST (UI Testing) - REFACTORED & FIXED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CRITICAL FIXES:
 * - FIX #1: Added comprehensive error handling for all async operations
 * - FIX #2: Implemented proper test plan approval flow (like API test)
 * - FIX #3: Added timeout protection for entire flow
 * - FIX #4: Improved WebSocket progress updates
 * - FIX #5: Fixed extractUrlFromMessage undefined issue
 * - FIX #6: Removed duplicate question asking logic
 *
 * NEW FLOW (CORRECT):
 * 1. Validate URL + scope
 * 2. Create/find project
 * 3. GENERATE TEST PLAN (not run immediately!)
 * 4. Save test plan to DB
 * 5. Show to user for APPROVAL
 * 6. User approves → handlePendingTestPlanApproval → executeUiTestFlow
 */
async function handlePlatformTest(
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
  }
): Promise<void> {
  const { message, parsedIntent, userId, workspace_id, chatSessionId, conversationId, answers } = params;

  // FIX #3: Setup timeout for entire platform test flow
  const flowStartTime = Date.now();
  const flowTimeout = 60000; // 60 seconds
  const checkTimeout = () => {
    if (Date.now() - flowStartTime > flowTimeout) {
      throw new Error(`Platform test flow timeout after ${flowTimeout / 1000}s`);
    }
  };

  try {
  logger.info('[PLATFORM_TEST] Starting UI test flow', {
    scope: parsedIntent?.scope,
    target: parsedIntent?.target,
    hasUrl: !!parsedIntent?.page,
      hasAnswers: !!answers,
      timeout: flowTimeout,
  });

    // FIX #4: Better progress updates
    emitProcessingStep(chatSessionId, 'checking_autonomous', '🤖 Analyzing your request...', 30);

  // ═══════════════════════════════════════════════════════════════════════
    // STEP 0: LOAD CHAT SESSION CONTEXT (FIX #1: Error handling)
  // ═══════════════════════════════════════════════════════════════════════

  let sessionProject = null;
  if (chatSessionId) {
      try {
    const sessionData = await ChatService.getSessionWithProject(chatSessionId, userId); // SECURITY: Pass userId for verification
    sessionProject = sessionData?.project;

    if (sessionProject?.settings?.main_url) {
      logger.info('[PLATFORM_TEST] Found project in session', {
        projectId: sessionProject.id,
        projectName: sessionProject.name,
        projectUrl: sessionProject.settings.main_url,
      });
        } else {
          logger.debug('[PLATFORM_TEST] No project in session yet');
        }
      } catch (error) {
        logger.warn('[PLATFORM_TEST] Failed to get session project', {
          error: error instanceof Error ? error.message : String(error),
          chatSessionId,
        });
        // Continue without session project (graceful degradation)
        sessionProject = null;
      }
    }

    checkTimeout();

    // Load user projects (FIX #1: Error handling)
    let userProjects: any[] = [];
    try {
      const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id, name, settings')
    .eq('user_id', userId)
    .eq('workspace_id', workspace_id)
    .order('created_at', { ascending: false })
    .limit(10);

      if (error) {
        logger.error('[PLATFORM_TEST] Failed to load user projects', { error });
      } else {
        userProjects = data || [];
      }

  logger.info('[PLATFORM_TEST] Loaded user projects', {
        projectCount: userProjects.length,
      });
    } catch (error) {
      logger.warn('[PLATFORM_TEST] Error loading projects, continuing without them', {
        error: error instanceof Error ? error.message : String(error),
      });
      userProjects = [];
    }

    checkTimeout();

  // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: PROCESS ANSWERS (if user provided them)
  // ═══════════════════════════════════════════════════════════════════════

  let parsedAnswers: any = null;

  // ✅ FIX: Parse user answers if they were provided
  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    logger.info('[PLATFORM_TEST] Processing user answers', {
      answerKeys: Object.keys(answers),
      hasCredentials: !!answers.credentials,
      hasUrl: !!answers.url,
    });

    try {
      // Import parseAnswers from question-generator
      const { parseAnswers } = await import('@/services/utils/question-generator.service');
      parsedAnswers = parseAnswers(answers);

      logger.info('[PLATFORM_TEST] Parsed answers successfully', {
        hasUrl: !!parsedAnswers.url,
        hasScope: !!parsedAnswers.scope,
        needsAuth: parsedAnswers.needsAuth,
        hasCredentials: !!parsedAnswers.credentials,
      });
    } catch (parseError) {
      logger.error('[PLATFORM_TEST] Failed to parse answers', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        answers: JSON.stringify(answers).substring(0, 100),
      });
      // Continue without parsed answers (will re-ask if needed)
      parsedAnswers = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: VALIDATE URL + SCOPE (FIX #5: Safe URL extraction)
  // ═══════════════════════════════════════════════════════════════════════

    // FIX #5: Safe URL extraction with priority: answers > parsedIntent > session
    const extractedUrl =
      parsedAnswers?.url ||
      parsedIntent?.page ||
      sessionProject?.settings?.main_url ||
      null;

  const hasUrl = !!extractedUrl;
  const hasScope = !!(parsedAnswers?.scope || parsedIntent?.scope);

    logger.info('[PLATFORM_TEST] Validation check', {
      hasUrl,
      hasScope,
      extractedUrl: extractedUrl || 'none',
      scope: parsedAnswers?.scope || parsedIntent?.scope || 'none',
      fromAnswers: !!parsedAnswers,
    });

    // If missing info, ask questions
  if (!hasUrl || !hasScope) {
      logger.info('[PLATFORM_TEST] Missing required information', { hasUrl, hasScope });

      try {
    const result = await requestMissingInformation(message, {
      hasUrl,
      hasScope,
      intent: 'platform_test',
          userProjects,
    });

        // Save to history (non-blocking)
    if (chatSessionId) {
          ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: message },
        {
          role: 'ai',
          content: '📝 I need some more information to set up the test:',
          metadata: {
            questions: result.questions,
            conversationId: result.conversationId,
            requiresAnswers: true,
          },
        },
          ]).catch(saveError => {
            logger.error('[PLATFORM_TEST] Failed to save messages', {
              error: saveError instanceof Error ? saveError.message : String(saveError),
            });
          });
    }

      res.json({
      reply: '📝 I need some more information to set up the test:',
      questions: result.questions,
      conversationId: result.conversationId,
        timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
      });
      return;
      } catch (error) {
        logger.error('[PLATFORM_TEST] requestMissingInformation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error('Failed to generate questions');
      }
    }

    checkTimeout();

  // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: FIND OR CREATE PROJECT (FIX #1: Error handling)
  // ═══════════════════════════════════════════════════════════════════════

    emitProcessingStep(chatSessionId, 'checking_autonomous', '🔍 Setting up project...', 40);

    let project_id: string;
    try {
      const projectResult = await ProjectContextService.findOrCreateProject(
    workspace_id,
    extractedUrl,
    userId
  );
      project_id = projectResult.project_id;

      if (projectResult.is_new) {
    logger.info('[PLATFORM_TEST] Created new project', { project_id, url: extractedUrl });
  }

      // Update session with project (non-blocking)
      if (chatSessionId) {
        ChatService.updateSessionProject(chatSessionId, project_id).catch(updateError => {
          logger.warn('[PLATFORM_TEST] Failed to update session project', {
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        });
      }
    } catch (error) {
      logger.error('[PLATFORM_TEST] ProjectContextService failed', {
        error: error instanceof Error ? error.message : String(error),
        url: extractedUrl,
      });
      throw new Error(`Failed to initialize project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    checkTimeout();

  // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: HANDLE CREDENTIALS (from answers OR saved in DB)
  // ═══════════════════════════════════════════════════════════════════════

  let finalCredentials: any = null;

  // Priority 1: Credentials from user answers (fresh input)
  if (parsedAnswers?.credentials) {
    logger.info('[PLATFORM_TEST] Using credentials from user answers');
    finalCredentials = parsedAnswers.credentials;
  }
  // Priority 2: Saved credentials from DB
  else {
    try {
      const savedCredentials = await ProjectContextService.getProjectCredentials(project_id, userId);

      if (savedCredentials) {
        logger.info('[PLATFORM_TEST] Found saved credentials in DB', { project_id });
        finalCredentials = savedCredentials;
      }
    } catch (error) {
      logger.warn('[PLATFORM_TEST] Failed to get saved credentials', {
        error: error instanceof Error ? error.message : String(error),
      });
      finalCredentials = null;
    }
  }

  // Determine if authentication is needed
  const needsAuth = parsedAnswers?.needsAuth ?? !!finalCredentials;

    checkTimeout();

  // ═══════════════════════════════════════════════════════════════════════
    // ✅ NEW STEP 4: RUN AUTONOMOUS EXPLORATION + GENERATE REAL TEST PLAN
    // Replaces UiTestPlanService with real browser-based exploration
  // ═══════════════════════════════════════════════════════════════════════

    emitProcessingStep(chatSessionId, 'generating_plan', '🔍 Analyzing page with real browser...', 50);

    // Determine scope: from answers > from parsedIntent
    const finalScope = parsedAnswers?.scope || parsedIntent.scope;

    logger.info('[PLATFORM_TEST] Starting autonomous exploration', {
      url: extractedUrl,
      scope: finalScope,
      hasCredentials: !!finalCredentials,
      needsAuth,
      fromAnswers: !!parsedAnswers,
    });

    // ✅ Run autonomous exploration: Launch browser → Analyze real page → Generate accurate plan
    let exploration, testPlan, formattedPlan;

    try {
      const result = await runAutonomousExploration({
        userMessage: message,
        answers: {
          url: extractedUrl,
          scope: finalScope,
          target: parsedIntent.target,
          credentials: finalCredentials,
          needsAuth,
          additionalInfo: {
            projectName: sessionProject?.name,
            ...(parsedAnswers?.additionalInfo || {}),
          },
        },
        userId,
        projectId: project_id,
        sessionId: chatSessionId,
      });

      exploration = result.exploration;
      testPlan = result.testPlan;
      formattedPlan = result.message;

    } catch (explorationError) {
      const errorMsg = explorationError instanceof Error ? explorationError.message : String(explorationError);

      // ✅ FIX: Check if error is about missing credentials
      if (errorMsg.includes('Authentication required') || errorMsg.includes('credentials')) {
        logger.info('[PLATFORM_TEST] Auth required, asking for credentials', {
          url: extractedUrl,
          originalError: errorMsg,
        });

        // Re-ask with credentials question
        try {
          const result = await requestMissingInformation(message, {
            hasUrl: true,
            hasScope: true,
            hasCredentials: false, // ← Force credentials question
            intent: 'platform_test',
            userProjects,
          });

          // Save to history
          if (chatSessionId) {
            ChatService.saveChatMessages(chatSessionId, [
              { role: 'user', content: message },
              {
                role: 'ai',
                content: '🔐 This site requires authentication. Please provide your credentials:',
                metadata: {
                  questions: result.questions,
                  conversationId: result.conversationId,
                  requiresAnswers: true,
                },
              },
            ]).catch(saveError => {
              logger.error('[PLATFORM_TEST] Failed to save credential request', {
                error: saveError instanceof Error ? saveError.message : String(saveError),
              });
            });
          }

          res.json({
            reply: '🔐 This site requires authentication. Please provide your credentials:',
            questions: result.questions,
            conversationId: result.conversationId,
            timestamp: new Date().toISOString(),
            sessionId: chatSessionId,
          });
          return;

        } catch (reqError) {
          logger.error('[PLATFORM_TEST] Failed to request credentials', {
            error: reqError instanceof Error ? reqError.message : String(reqError),
          });
          // Fall through to generic error handler
        }
      }

      // Re-throw if not a credentials error
      throw explorationError;
    }

    logger.info('[PLATFORM_TEST] Autonomous exploration completed', {
      planId: testPlan.id,
      explorationId: exploration.timestamp,
      stepsCount: testPlan.steps.length,
      commandsCount: testPlan.commands.length,
      intelligentMode: testPlan.intelligentMode || false,
    });

    checkTimeout();

    // Save to history (non-blocking)
      if (chatSessionId) {
      ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          {
            role: 'ai',
          content: formattedPlan,
            metadata: {
            testPlan,
            requiresApproval: true,
          },
        },
      ]).catch(saveError => {
        logger.error('[PLATFORM_TEST] Failed to save messages', {
          error: saveError instanceof Error ? saveError.message : String(saveError),
        });
      });
    }

    // Send response with test plan
        res.json({
      reply: formattedPlan,
      testPlan,
      conversationId: testPlan.id, // ← For tracking approval
      requiresApproval: true, // ← KEY! User must approve
          timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
        });

    logger.info('[PLATFORM_TEST] Test plan sent for user approval', {
      planId: testPlan.id,
      duration: Date.now() - flowStartTime,
    });

  } catch (error) {
    // Check if response already sent
    if (res.headersSent) {
      logger.warn('[PLATFORM_TEST] Response already sent, cannot send error', {
        error: error instanceof Error ? error.message : String(error),
        });
        return;
    }

    logger.error('[PLATFORM_TEST] Error in platform test flow', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      duration: Date.now() - flowStartTime,
    });

    const errorMessage = error instanceof Error && error.message
      ? error.message
      : (error ? String(error) : 'Failed to process platform test');

    // Check for timeout
    const isTimeout = errorMessage.includes('timeout');

    // Save error to history (non-blocking)
  if (chatSessionId) {
      ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
        { role: 'ai', content: `❌ Error: ${errorMessage}` },
      ]).catch(saveError => {
        logger.error('[PLATFORM_TEST] Failed to save error message', {
          error: saveError instanceof Error ? saveError.message : String(saveError),
        });
      });
    }

    res.status(isTimeout ? 408 : 500).json({
      success: false,
      error: isTimeout ? 'Request timeout' : 'Failed to process platform test',
      message: errorMessage,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: API TEST
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function handleApiTest(
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
  }
): Promise<void> {
  const { message, parsedIntent, userId, workspace_id, chatSessionId, conversationId, answers } = params;

  try {
    // FIX #8: Validate and merge answers into parsedIntent if provided
    if (answers) {
      // Validate answers structure
      if (typeof answers !== 'object' || Array.isArray(answers)) {
        logger.error('[API_TEST] Invalid answers structure', { answers: typeof answers });
        throw new Error('Invalid answers format - expected object');
      }

      // Safely merge answers with validation
      const validatedAnswers: Record<string, any> = {};

      if (answers.apiMethod && typeof answers.apiMethod === 'string') {
        parsedIntent.apiMethod = answers.apiMethod.toUpperCase();
        validatedAnswers.apiMethod = answers.apiMethod;
      }

      if (answers.apiUrl && typeof answers.apiUrl === 'string') {
        // Validate URL format
        try {
          new URL(answers.apiUrl);
          parsedIntent.apiUrl = answers.apiUrl;
          validatedAnswers.apiUrl = answers.apiUrl;
        } catch {
          logger.warn('[API_TEST] Invalid URL in answers', { apiUrl: answers.apiUrl });
        }
      }

      if (answers.apiBody) {
        parsedIntent.apiBody = answers.apiBody;
        validatedAnswers.apiBody = typeof answers.apiBody === 'string' ? 'provided' : 'object';
      }

      if (answers.apiHeaders && typeof answers.apiHeaders === 'object') {
        parsedIntent.apiHeaders = answers.apiHeaders;
        validatedAnswers.apiHeaders = Object.keys(answers.apiHeaders).length;
      }

      logger.info('[API_TEST] Merged validated answers into parsedIntent', {
        answersProvided: Object.keys(validatedAnswers),
        method: parsedIntent.apiMethod,
        url: parsedIntent.apiUrl,
      });
    }

    logger.info('[API_TEST] Starting API test flow', {
      method: parsedIntent?.apiMethod,
      url: parsedIntent?.apiUrl,
      hasParsedIntent: !!parsedIntent,
      hasAnswers: !!answers,
    });

    emitProcessingStep(chatSessionId, 'checking_autonomous', '🔍 Analyzing API request...', 30);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: VALIDATE API INFO - ASK FOR MISSING DETAILS
    // ═══════════════════════════════════════════════════════════════════════

    const hasMethod = !!parsedIntent?.apiMethod;
    const hasUrl = !!parsedIntent?.apiUrl;

    // If missing method OR URL, ask clarifying questions
    if (!hasMethod || !hasUrl) {
      logger.info('[API_TEST] Missing API details, asking for clarification', {
        hasMethod,
        hasUrl,
        message: message.substring(0, 50),
      });

      const questions = [];

      if (!hasUrl) {
        questions.push({
          id: 'apiUrl',
          question: '🌐 What is the API endpoint URL?',
          type: 'text',
          required: true,
          placeholder: 'https://api.example.com/v1/users',
        });
      }

      if (!hasMethod) {
        questions.push({
          id: 'apiMethod',
          question: '📡 Which HTTP method should I use?',
          type: 'select',
          required: true,
          options: [
            { value: 'GET', label: 'GET - Retrieve data' },
            { value: 'POST', label: 'POST - Create/Submit data' },
            { value: 'PUT', label: 'PUT - Update/Replace data' },
            { value: 'PATCH', label: 'PATCH - Partial update' },
            { value: 'DELETE', label: 'DELETE - Remove data' },
          ],
        });
      }

      const clarificationMessage = `📋 I need a few more details to set up the API test:\n\n${questions.map(q => `• ${q.question}`).join('\n')}`;

      // Save to history
      if (chatSessionId) {
        await ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          { role: 'ai', content: clarificationMessage },
        ]);
      }

      // Note: This conversationId is just for tracking clarification, not a test plan ID
      // So it can use timestamp, but for consistency we could use UUID too
      res.json({
        reply: clarificationMessage,
        questions,
        conversationId: `api_clarify_${Date.now()}`, // Clarification tracking ID (not a test plan)
        needsMoreInfo: true,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: FIND OR CREATE PROJECT
  // ═══════════════════════════════════════════════════════════════════════

  const { project_id } = await ProjectContextService.findOrCreateProject(
    workspace_id,
    parsedIntent.apiUrl,
    userId
  );

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: GENERATE API TEST PLAN
  // ═══════════════════════════════════════════════════════════════════════

  emitProcessingStep(chatSessionId, 'generating_plan', '📋 Creating test plan...', 60);

  const apiTestPlan = await ApiTestPlanService.generateApiTestPlan({
              method: parsedIntent.apiMethod,
              url: parsedIntent.apiUrl,
                body: parsedIntent.apiBody,
    headers: parsedIntent.apiHeaders,
    userMessage: message,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: CONVERT API TEST PLAN TO UNIFIED TEST PLAN FORMAT
  // ═══════════════════════════════════════════════════════════════════════

  // Convert ApiTestPlan to TestPlan for storage and execution
  const testPlan = convertApiTestPlanToTestPlan(apiTestPlan);

  // Save test plan to database for approval tracking
  // Note: userId/projectId are shortened for logs (privacy + readability)
  logger.info('[API_TEST] Saving test plan to database', {
    planId: testPlan.id,
    userId: userId.substring(0, 8) + '...', // First 8 chars only (privacy)
    projectId: project_id.substring(0, 8) + '...', // First 8 chars only (privacy)
    scope: testPlan.scope,
    status: testPlan.status,
  });

  const saveResult = await saveTestPlan(testPlan, userId, project_id);

  logger.info('[API_TEST] Test plan save result', {
    planId: testPlan.id,
    success: saveResult.success,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: SHOW TEST PLAN TO USER FOR APPROVAL
  // ═══════════════════════════════════════════════════════════════════════

  const formattedPlan = ApiTestPlanService.formatApiTestPlanForConfirmation(apiTestPlan);

  // Save chat messages
  if (chatSessionId) {
    await ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      {
        role: 'ai',
        content: formattedPlan,
        metadata: {
          testPlan: apiTestPlan,
          requiresApproval: true,
        },
      },
    ]);
  }

    res.json({
      reply: formattedPlan,
      testPlan: apiTestPlan,
      conversationId: testPlan.id, // Use this to track approval
      requiresApproval: true,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  } catch (error) {
    logger.error('[API_TEST] Error in API test flow', {
      error,
      errorType: error?.constructor?.name,
      errorMessage: error instanceof Error ? error.message : String(error),
      parsedIntent,
    });

    const errorMessage = error instanceof Error && error.message
      ? error.message
      : (error ? String(error) : 'Failed to process API test request');

    // Save error to history
    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: params.message },
        { role: 'ai', content: `❌ Error: ${errorMessage}` },
      ]);
    }

    res.status(500).json({
      success: false,
      error: 'Failed to process API test',
      message: errorMessage,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: GENERAL CHAT
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function handleGeneralChat(
  req: Request,
  res: Response,
  params: {
    message: string;
    userId: string;
    chatSessionId?: string;
    context?: any;
  }
): Promise<void> {
  const { message, userId, chatSessionId, context } = params;

  logger.info('[GENERAL_CHAT] Handling general conversation', {
    hasSession: !!chatSessionId,
    messageLength: message.length
  });

  emitProcessingStep(chatSessionId, 'generating_response', '💬 Thinking...', 90);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: BUILD CONTEXT WITH HISTORY
  // ═══════════════════════════════════════════════════════════════════════

  let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let oldContextSummary = '';

  if (chatSessionId) {
    // Get total message count first
    const { count: totalMessageCount, error: countError } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', chatSessionId);

    if (countError) {
      logger.error('[GENERAL_CHAT] Failed to count messages', { error: countError });
    }

    const totalMessages = totalMessageCount || 0;

    logger.info('[GENERAL_CHAT] Message count', {
      sessionId: chatSessionId,
      totalMessages
    });

    // Get recent messages (last 20)
    const recentMessages = await ChatService.getRecentMessages(chatSessionId, userId, CONSTANTS.RECENT_MESSAGES_LIMIT); // SECURITY: Pass userId for verification

    logger.info('[GENERAL_CHAT] Retrieved recent history', {
      messageCount: recentMessages.length
    });

    // ═══════════════════════════════════════════════════════════════════════
    // VECTOR-BASED CONTEXT RETRIEVAL (Better than GPT summarization!)
    // ═══════════════════════════════════════════════════════════════════════
    // Benefits: 20x faster, 20x cheaper, more accurate semantic search
    // Cost: ~$0.0001 per 1K messages (vs $0.002 for GPT summary)
    // Speed: ~100ms (vs 2-3 sec for GPT summary)
    // ═══════════════════════════════════════════════════════════════════════

    // Note: chatSessionId is always defined (requireAuth middleware ensures valid user)
    // But we check anyway as defensive programming
    if (totalMessages > CONSTANTS.RECENT_MESSAGES_LIMIT && chatSessionId) {
      logger.info('[GENERAL_CHAT] Chat has old messages, using vector search');

      try {
        // FIX #4: Auto-embed with timeout to prevent memory leak
        const embedPromise = autoEmbedOldMessages(chatSessionId);
        const embedTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Auto-embed timeout')), CONSTANTS.AUTO_EMBED_TIMEOUT)
        );

        Promise.race([embedPromise, embedTimeout]).catch(error => {
          logger.warn('[GENERAL_CHAT] Failed to auto-embed messages', {
            error: error instanceof Error ? error.message : String(error),
            timeout: CONSTANTS.AUTO_EMBED_TIMEOUT,
          });
        });

        // Search for relevant old messages using semantic similarity
        const relevantOldMessages = await searchChatHistory(
          chatSessionId,
          message, // Current user query
          {
            matchCount: CONSTANTS.KB_MATCH_COUNT, // Top 3 most relevant old messages
            matchThreshold: CONSTANTS.KB_MATCH_THRESHOLD, // Only include if similarity > 0.6
          }
        );

        if (relevantOldMessages.length > 0) {
          // Format relevant messages as context
          oldContextSummary = relevantOldMessages
            .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
            .join('\n\n');

          logger.info('[GENERAL_CHAT] Retrieved relevant old context via vectors', {
            retrievedCount: relevantOldMessages.length,
            avgSimilarity: (relevantOldMessages.reduce((sum, m) => sum + m.similarity, 0) / relevantOldMessages.length).toFixed(2),
            oldestDate: relevantOldMessages[0]?.created_at,
          });
        } else {
          logger.info('[GENERAL_CHAT] No relevant old messages found');
        }
      } catch (vectorError) {
        // Fallback: If vector search fails, continue without old context
        logger.error('[GENERAL_CHAT] Vector search failed, continuing without old context', {
          error: vectorError,
          sessionId: chatSessionId
        });
        oldContextSummary = ''; // No old context
      }
    }

    // Build conversation history with compressed content (use helper for role conversion)
    conversationHistory = recentMessages.map(msg => ({
      role: convertRoleForOpenAI(msg.role) as 'user' | 'assistant',
      content: compressMessageContent(msg.content),
    })) as Array<{ role: 'user' | 'assistant'; content: string }>;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: SEARCH GLOBAL KB FOR GENERAL CHAT (ALWAYS!)
  // ═══════════════════════════════════════════════════════════════════════

  let kbContext = '';
  let kbRulesContext = '';

  // Detect user language from message
  const userLanguage = await detectLanguage(message);

  logger.info('[GENERAL_CHAT] Detected user language', {
    language: userLanguage,
    message: message.substring(0, 100),
  });

  // For general_chat ALWAYS search in Global KB
  try {
    logger.info('[GENERAL_CHAT] Searching Global KB for context and rules', {
      message: message.substring(0, 100),
      language: userLanguage,
    });

    // Search for general context related to user's message
    const kbResults = await searchKB(message, undefined, {
      matchCount: CONSTANTS.KB_MATCH_COUNT,
      matchThreshold: CONSTANTS.KB_MATCH_THRESHOLD,
      language: userLanguage, // Filter by detected language
    });

    if (kbResults.chunks.length > 0) {
      kbContext = kbResults.chunks
        .map(chunk => chunk.content)
        .join('\n\n');

      logger.info('[GENERAL_CHAT] Found KB context', {
        chunksCount: kbResults.chunks.length,
        sources: kbResults.sources.global,
        contextLength: kbContext.length,
      });
    } else {
      logger.info('[GENERAL_CHAT] No relevant KB context found');
    }

    // Try to get rules from cache first (FAST PATH - ~0ms)
    try {
      // Fallback to 'en' for neutral language
      const cacheLanguage = userLanguage === 'neutral' ? 'en' : userLanguage;
      const cachedRules = RulesCacheService.getRules(cacheLanguage);

      if (cachedRules) {
        // Rules found in cache! No need for searchKB()
        kbRulesContext = cachedRules;

        logger.info('[GENERAL_CHAT] Using cached rules (FAST PATH)', {
          language: userLanguage,
          cacheLanguage,
          rulesLength: cachedRules.length,
          cacheHit: true,
        });
      } else {
        // Fallback to searchKB if cache miss (SLOW PATH - ~200-300ms)
        logger.warn('[GENERAL_CHAT] Rules cache miss, falling back to searchKB', {
          language: userLanguage,
        });

        const kbRulesSearch = await searchKB('AI response guidelines rules', undefined, {
          matchCount: 2,
          matchThreshold: 0.5,
          language: userLanguage,
        });

        if (kbRulesSearch.chunks.length > 0) {
          const rulesChunks = kbRulesSearch.chunks.filter(
            chunk => chunk.source_file?.includes('rules') || chunk.source_file?.includes('general_ai')
          );

          if (rulesChunks.length > 0) {
            kbRulesContext = rulesChunks
              .map(chunk => chunk.content)
              .join('\n\n');

            logger.info('[GENERAL_CHAT] Found KB rules via searchKB (SLOW PATH)', {
              rulesChunksCount: rulesChunks.length,
              sources: kbRulesSearch.sources.global,
              rulesContextLength: kbRulesContext.length,
              cacheHit: false,
            });
          }
        }
      }
    } catch (rulesError) {
      logger.warn('[GENERAL_CHAT] Failed to get rules, continuing without them', { error: rulesError });
      // Continue without rules - not critical
    }
  } catch (error) {
    logger.warn('[GENERAL_CHAT] KB search failed', { error });
    // Continue without KB context
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: BUILD MESSAGES ARRAY FOR OPENAI
  // ═══════════════════════════════════════════════════════════════════════

  const systemPrompt = buildChatSystemPrompt();

  // Enhance system prompt with old context summary
  const enhancedSystemPrompt = oldContextSummary
    ? `${systemPrompt}\n\n--- Previous Conversation Context ---\n${oldContextSummary}\n\nNote: The above is a summary of earlier messages. Recent messages follow below.`
    : systemPrompt;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: enhancedSystemPrompt },
  ];

  // Add Global KB RULES FIRST (if available) - IMPORTANT for response guidelines
  if (kbRulesContext) {
    messages.push({
      role: 'system',
      content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 RESPONSE GUIDELINES FROM KNOWLEDGE BASE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${kbRulesContext}

IMPORTANT: Follow these guidelines when generating responses.`,
    });
  }

  // Add Global KB context (ALWAYS for general_chat)
  if (kbContext) {
    messages.push({
      role: 'system',
      content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 RELEVANT KNOWLEDGE FROM KNOWLEDGE BASE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${kbContext}

Use this knowledge to provide more accurate and helpful responses.`,
    });
  }

  // Add additional context if provided (legacy support)
  const contextString = typeof context === 'string' ? context : undefined;
  if (contextString) {
    messages.push({
      role: 'system',
      content: `Additional Context: ${contextString}`,
    });
  }

  // Add conversation history
  messages.push(...conversationHistory);

  // Add current message
  messages.push({ role: 'user', content: message });

  logger.info('[GENERAL_CHAT] Built context for AI', {
    totalMessages: messages.length,
    hasOldSummary: !!oldContextSummary,
    recentHistoryCount: conversationHistory.length,
    hasKbContext: !!kbContext,
    kbContextLength: kbContext.length,
    hasKbRules: !!kbRulesContext,
    kbRulesLength: kbRulesContext.length,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: GET AI RESPONSE
  // ═══════════════════════════════════════════════════════════════════════

  let gptResponse: { content: string; usage?: any };
  try {
    gptResponse = await getChatCompletionWithMessages(messages, {
      temperature: 0.5,
      max_tokens: 1000,
    });
  } catch (openaiError: any) {
    // Fallback response if OpenAI fails
    logger.error('[GENERAL_CHAT] OpenAI API failed, using fallback response', {
      error: openaiError instanceof Error ? openaiError.message : String(openaiError),
      status: openaiError?.status,
      code: openaiError?.code,
      userId,
    });

    // Provide helpful fallback message based on error type
    let fallbackMessage = 'I apologize, but I\'m currently experiencing technical difficulties. Please try again in a few moments.';

    if (openaiError?.status === 401 || openaiError?.code === 'invalid_api_key') {
      fallbackMessage = 'I\'m temporarily unavailable due to a configuration issue. Our team has been notified.';
    } else if (openaiError?.status === 429 || openaiError?.code === 'insufficient_quota') {
      fallbackMessage = 'I\'m temporarily unavailable due to high demand. Please try again in a few minutes.';
    } else if (openaiError?.message?.includes('timeout')) {
      fallbackMessage = 'The request took too long to process. Please try again with a shorter message.';
    }

    gptResponse = {
      content: fallbackMessage,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'fallback',
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: SAVE MESSAGES
  // ═══════════════════════════════════════════════════════════════════════

    if (chatSessionId) {
    await ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      { role: 'ai', content: gptResponse.content },
    ]);

    // Auto-generate title for new chats (after first user message)
    // This runs in background, doesn't block response
    ChatService.autoGenerateTitle(chatSessionId).catch(error => {
      logger.warn('[GENERAL_CHAT] Failed to auto-generate title', { error, chatSessionId });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: RESPOND (NO CREDIT DEDUCTION FOR CHAT!)
  // ═══════════════════════════════════════════════════════════════════════
  // IMPORTANT: Chat messages are FREE
  // Credits are only deducted for TESTS (intelligent, standard, api)

  const response: any = {
    reply: gptResponse.content,
            timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  };

  // Show user's current credit balance (but don't deduct)
  if (userId && userId !== 'anonymous') {
    try {
      // FIX #7: Use centralized UUID validation
      if (isValidUUID(userId)) {
        const credits = await UserCreditsService.getUserCredits(userId);
        response.creditsRemaining = credits?.credits_balance || 0;
        response.chatIsFree = true; // Indicate that chat is free
      }
    } catch (error) {
      logger.warn('[GENERAL_CHAT] Failed to get credits', { error, userId });
    }
  }

  res.json(response);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: VALIDATE TEST PLAN
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function validateTestPlan(
  planId: string,
  userId: string,
  res: Response
): Promise<any | null> {
    const plan = await getTestPlan(planId, userId);

    if (!plan) {
      res.status(404).json({
        success: false,
        error: 'Test plan not found or expired',
            timestamp: new Date().toISOString(),
      });
    return null;
  }

  return plan;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: DETERMINE TEST TYPE
 * ═══════════════════════════════════════════════════════════════════════════
 */
function determineTestType(plan: any): 'api' | 'intelligent' | 'standard' {
  if (!plan) {
    logger.warn('[DETERMINE_TYPE] Plan is null/undefined');
    return 'standard';
  }

  // Check if API test (priority 1)
  const isApiTest = plan.scope === 'api_test' || (plan.metadata?.type === 'api_test');

  if (isApiTest) {
    logger.debug('[DETERMINE_TYPE] Detected API test', {
      scope: plan.scope,
      metadataType: plan.metadata?.type
    });
    return 'api';
  }

  // Check intelligent mode (priority 2)
  if (plan.intelligentMode) {
    logger.debug('[DETERMINE_TYPE] Detected intelligent test');
    return 'intelligent';
  }

  // Default to standard
  logger.debug('[DETERMINE_TYPE] Defaulting to standard test');
  return 'standard';
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: CHECK CREDITS BEFORE TEST
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function checkCreditsBeforeTest(
  userId: string,
  testType: 'api' | 'intelligent' | 'standard',
  res: Response
): Promise<boolean> {
    const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, testType);

    if (!creditCheck.hasEnough) {
      logger.warn('[EXECUTE] Insufficient credits for test', {
        userId,
        testType,
        required: creditCheck.required,
        available: creditCheck.available,
        shortage: creditCheck.shortage,
      });

      res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        message: `You need ${creditCheck.required} credits to run this test. You have ${creditCheck.available} credits. Please purchase ${creditCheck.shortage} more credits.`,
        required: creditCheck.required,
        available: creditCheck.available,
        shortage: creditCheck.shortage,
        timestamp: new Date().toISOString(),
      });
    return false;
    }

    logger.info('[EXECUTE] Credit check passed', {
      userId,
      testType,
      required: creditCheck.required,
      available: creditCheck.available,
    });

  return true;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: EXECUTE API TEST FLOW (REFACTORED - CRITICAL FIXES)
 * ═══════════════════════════════════════════════════════════════════════════
 * FIX #1-5: Error handling, validation, non-blocking chat save
 * FIX #12: Global timeout for entire flow (60s)
 * FIX #13: Consistent WebSocket progress (0-100%)
 */
async function executeApiTestFlow(
  res: Response,
  params: {
    plan: any;
    planId: string;
    userId: string;
    chatSessionId?: string;
    userMessage?: string; // FIX #14: Actual user message
  }
): Promise<void> {
  const { plan, planId, userId, chatSessionId, userMessage = 'Approved test execution' } = params;

  // FIX #12: Global timeout for entire API test flow
  const flowTimeout = 60000; // 60 seconds
  const flowStartTime = Date.now();

  const checkTimeout = () => {
    if (Date.now() - flowStartTime > flowTimeout) {
      throw new Error(`API test flow timeout after ${flowTimeout / 1000}s`);
    }
  };

      logger.info('🔵 [API_TEST] Starting API test execution', {
        planId,
        url: plan.url,
    method: plan.metadata?.method,
        chatSessionId,
    timeout: flowTimeout,
  });

  try {
    // FIX #13: Consistent progress starting from 0%
    emitProcessingStep(chatSessionId, 'executing_test', '🚀 Starting API test execution...', 0);
    emitProcessingStep(chatSessionId, 'executing_test', '📋 Confirming test plan...', 5);

    // FIX #4: Validate plan.url before execution
    if (!plan.url || typeof plan.url !== 'string') {
      throw new Error('Invalid plan URL - URL is required for API testing');
    }

    // Validate URL format
    try {
      new URL(plan.url);
    } catch {
      throw new Error(`Invalid URL format: ${plan.url}`);
    }

    checkTimeout(); // Check timeout before each major step

    // Confirm plan
    const confirmResult = await confirmTestPlan(planId, userId);
    if (!confirmResult.success) {
      throw new Error(`Failed to confirm test plan: ${confirmResult.message}`);
    }

    emitProcessingStep(chatSessionId, 'executing_test', '💳 Checking credits...', 10);
    checkTimeout();

    // FIX #3: Deduct credits BEFORE test execution (not after)
    const apiTestId = `api_${planId}_${Date.now()}`;
    const apiDetails = plan.metadata || {};

    try {
      await CreditCostTrackerService.deductCreditsForTest({
        userId,
        testType: 'api',
        credits: TokenCalculatorService.getTestCreditCost('api'),
        costUSD: 0.0011,
        testId: apiTestId,
        description: `API test: ${apiDetails.method || 'GET'} ${plan.url}`,
      });
    } catch (creditError) {
      logger.error('[API_TEST] Failed to deduct credits', {
        error: creditError instanceof Error ? creditError.message : String(creditError),
        userId,
      });
      throw new Error('Insufficient credits or payment error');
    }

    emitProcessingStep(chatSessionId, 'executing_test', '🔧 Preparing API request...', 15);
    checkTimeout();

    // FIX #1: Wrap executeApiTest in try-catch
    let apiTestResult: any;
    try {
      apiTestResult = await executeApiTest(
        {
          method: apiDetails.method || 'GET',
          url: plan.url,
          body: apiDetails.body,
          headers: apiDetails.headers || {},
          expectedStatus: apiDetails.expectedStatus || 200,
        },
        chatSessionId
      );
    } catch (testError) {
      logger.error('[API_TEST] executeApiTest failed', {
        error: testError instanceof Error ? testError.message : String(testError),
        url: plan.url,
      });
      throw new Error(`API test execution failed: ${testError instanceof Error ? testError.message : 'Unknown error'}`);
    }

    checkTimeout();

    // FIX #2: Wrap runApiFuzzing in try-catch (already has internal try-catch, but double-check)
    let fuzzingReport: any = null;
    try {
      fuzzingReport = await runApiFuzzing(apiTestResult, apiDetails, plan.url, chatSessionId);
    } catch (fuzzingError) {
      // Fuzzing is optional, don't fail the entire test
      logger.warn('[API_TEST] Fuzzing failed, continuing without it', {
        error: fuzzingError instanceof Error ? fuzzingError.message : String(fuzzingError),
      });
      // fuzzingReport stays null
    }

    checkTimeout();

    // Save test-chat mapping (non-blocking)
      if (chatSessionId && userId) {
      TestChatMappingService.saveTestChatMapping({
          testId: apiTestId,
          chatSessionId,
          userId,
      }).catch(mappingError => {
        logger.error('[API_TEST] Failed to save test-chat mapping', {
          error: mappingError instanceof Error ? mappingError.message : String(mappingError),
          testId: apiTestId,
        });
      });
    }

    // Format response
    const { finalMessage } = await formatApiResponse(
      apiTestResult,
      fuzzingReport,
      plan,
      apiDetails
    );

    // FIX #5: Make chat save non-blocking (fire-and-forget)
    if (chatSessionId) {
      ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: userMessage }, // FIX #14: Use actual user message
        {
          role: 'ai',
          content: finalMessage,
          metadata: {
            testResult: apiTestResult,
            testId: apiTestId,
        testType: 'api',
            fuzzingReport: fuzzingReport ? {
              totalTests: fuzzingReport.summary.totalTests,
              passed: fuzzingReport.summary.passed,
              failed: fuzzingReport.summary.failed,
              issuesFound: fuzzingReport.issues.length,
              securityScore: fuzzingReport.securityScore,
            } : null,
          },
        },
      ]).catch(saveError => {
        logger.error('[API_TEST] Failed to save chat messages', {
          error: saveError instanceof Error ? saveError.message : String(saveError),
          sessionId: chatSessionId,
        });
      });
    }

    // Send response immediately (don't wait for chat save)
    res.json({
      reply: finalMessage,
      testResult: apiTestResult,
      fuzzingReport: fuzzingReport || undefined,
        testId: apiTestId,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
      });

    logger.info('✅ [API_TEST] HTTP response sent successfully', {
        testId: apiTestId,
      duration: Date.now() - flowStartTime,
    });
  } catch (error) {
    logger.error('❌ [API_TEST] Critical error in API test flow', {
      error: error instanceof Error ? error.message : String(error),
      planId,
      userId,
    });

    // If response not sent yet, send error
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'API test failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    throw error; // Re-throw for handleExecutionError
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: RUN API FUZZING (REFACTORED)
 * ═══════════════════════════════════════════════════════════════════════════
 * FIX #1: Proper AbortController for timeout
 * FIX #2: Cleanup on timeout
 * FIX #5: Progress reporting during fuzzing
 * FIX #8: Static imports (moved to top)
 */
async function runApiFuzzing(
  apiTestResult: any,
  apiDetails: any,
  url: string,
  chatSessionId?: string
): Promise<any | null> {
  // Only run if happy path succeeded
  if (!apiTestResult.success || !chatSessionId) {
    return null;
  }

  // FIX #1: Create AbortController for proper cleanup
  const abortController = new AbortController();
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    logger.info('[API_FUZZING] Starting intelligent fuzzing', {
      method: apiDetails.method,
      url,
      timeout: CONSTANTS.FUZZING_TIMEOUT,
    });

    emitProcessingStep(chatSessionId, 'analyzing_results', '🔍 Generating security test scenarios...', 70);

    const fuzzingScenarios = await IntelligentApiFuzzerService.generateFuzzingScenarios(
      {
        method: apiDetails.method || 'GET',
        url,
        body: apiDetails.body,
        headers: apiDetails.headers || {},
        expectedStatus: apiDetails.expectedStatus || 200,
      },
      apiTestResult
    );

    emitProcessingStep(
      chatSessionId,
      'analyzing_results',
      `🎯 Testing ${fuzzingScenarios.length} security scenarios...`,
      75
    );

    // FIX #1: Setup timeout that aborts all requests
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort(); // ← Cancel all ongoing requests
        reject(new Error('Fuzzing timeout'));
      }, CONSTANTS.FUZZING_TIMEOUT);
    });

    // FIX #5: Progress callback for real-time updates
    const onProgress = (completed: number, total: number) => {
      const progressPercent = 75 + Math.floor((completed / total) * 20); // 75% → 95%
      emitProcessingStep(
        chatSessionId,
        'analyzing_results',
        `🔒 Testing security (${completed}/${total} scenarios)...`,
        progressPercent
      );
    };

    // Execute with abort signal + progress
    const fuzzingPromise = ApiFuzzingExecutorService.executeFuzzingScenarios(
      fuzzingScenarios,
      apiTestResult,
      abortController.signal, // ← Pass abort signal
      onProgress              // ← Pass progress callback
    );

    const fuzzingReport = await Promise.race([fuzzingPromise, timeoutPromise]) as any;

    // FIX #2: Clear timeout if completed successfully
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    logger.info('[API_FUZZING] Fuzzing completed', {
      totalTests: fuzzingReport.summary.totalTests,
      passed: fuzzingReport.summary.passed,
      failed: fuzzingReport.summary.failed,
      issuesFound: fuzzingReport.issues.length,
      securityScore: fuzzingReport.securityScore,
    });

    emitProcessingStep(
      chatSessionId,
      'analyzing_results',
      `✅ Security analysis complete! Found ${fuzzingReport.issues.length} issue(s)`,
      100
    );

    return fuzzingReport;
  } catch (fuzzingError) {
    const isTimeout = fuzzingError instanceof Error && fuzzingError.message === 'Fuzzing timeout';
    const isAborted = fuzzingError instanceof Error && fuzzingError.message.includes('aborted');

    logger.error('[API_FUZZING] Fuzzing failed, continuing without it', {
      error: fuzzingError instanceof Error ? fuzzingError.message : String(fuzzingError),
      isTimeout,
      isAborted,
      maxTimeout: CONSTANTS.FUZZING_TIMEOUT,
    });

    if ((isTimeout || isAborted) && chatSessionId) {
      emitProcessingStep(
        chatSessionId,
        'analyzing_results',
        `⚠️ Security analysis timed out (max ${CONSTANTS.FUZZING_TIMEOUT / 1000}s), skipping fuzzing`,
        100
      );
    }

    return null;
  } finally {
    // FIX #2: Always cleanup timeout
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: FORMAT API RESPONSE
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function formatApiResponse(
  apiTestResult: any,
  fuzzingReport: any,
  plan: any,
  apiDetails: any
): Promise<{ finalMessage: string; responseBodyDisplay: string }> {
  // Format response body
      let responseBodyDisplay = '';

      if (apiTestResult.responseBody) {
        if (typeof apiTestResult.responseBody === 'object') {
      responseBodyDisplay = '\n\n**Response Body:**\n```json\n' +
        JSON.stringify(apiTestResult.responseBody, null, 2) + '\n```';
        } else if (typeof apiTestResult.responseBody === 'string' && apiTestResult.responseBody.length > 0) {
          try {
            const parsed = JSON.parse(apiTestResult.responseBody);
        responseBodyDisplay = '\n\n**Response Body:**\n```json\n' +
          JSON.stringify(parsed, null, 2) + '\n```';
          } catch {
            const truncated = apiTestResult.responseBody.length > 500
              ? apiTestResult.responseBody.substring(0, 500) + '...'
              : apiTestResult.responseBody;
            responseBodyDisplay = '\n\n**Response Body:**\n```\n' + truncated + '\n```';
          }
        }
  }

  let finalMessage = '';

  if (fuzzingReport) {
    const { ApiFuzzingFormatterService } = await import('@/services/testing/api/fuzzing/api-fuzzing-formatter.service');
    const fuzzingFormatted = ApiFuzzingFormatterService.formatComprehensiveReport(fuzzingReport);

    finalMessage = `✅ **API Test Results**\n\n` +
      `**Happy Path Test:** PASSED ✅\n` +
      `• URL: ${plan.url}\n` +
      `• Method: ${apiDetails.method}\n` +
      `• Status: ${apiTestResult.status}\n` +
      `• Duration: ${apiTestResult.durationMs}ms\n` +
      responseBodyDisplay + '\n\n' +
      '─────────────────────────────────────────────\n\n' +
      fuzzingFormatted;
  } else {
    finalMessage = `✅ API test executed successfully!

**URL:** ${plan.url}
**Method:** ${apiDetails.method}
**Status Code:** ${apiTestResult.status}
**Success:** ${apiTestResult.success ? 'Yes' : 'No'}
**Duration:** ${apiTestResult.durationMs}ms${responseBodyDisplay}`;
  }

  return { finalMessage, responseBodyDisplay };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: EXECUTE UI TEST FLOW (REFACTORED - CRITICAL FIXES)
 * ═══════════════════════════════════════════════════════════════════════════
 * FIX #6-11: Error handling, validation, non-blocking operations
 * FIX #12: Global timeout for entire flow (90s for UI tests)
 * FIX #13: Consistent WebSocket progress (0-100%)
 */
async function executeUiTestFlow(
  res: Response,
  params: {
    plan: any;
    planId: string;
    userId: string;
    chatSessionId?: string;
    workspace_id: string;
    userMessage?: string; // FIX #14: Actual user message
  }
): Promise<void> {
  const { plan, planId, userId, chatSessionId, workspace_id, userMessage = 'Approved test execution' } = params;

  // FIX #12: Global timeout for UI test flow (longer than API because browser tests are slower)
  const flowTimeout = 90000; // 90 seconds
  const flowStartTime = Date.now();

  const checkTimeout = () => {
    if (Date.now() - flowStartTime > flowTimeout) {
      throw new Error(`UI test flow timeout after ${flowTimeout / 1000}s`);
    }
  };

  logger.info('🔵 [UI_TEST] Starting UI test execution', {
    planId,
    userId,
    url: plan.url,
    intelligentMode: plan.intelligentMode,
    timeout: flowTimeout,
  });

  try {
    // FIX #13: Consistent progress starting from 0%
    emitProcessingStep(chatSessionId, 'executing_test', '🚀 Starting UI test execution...', 0);
    emitProcessingStep(chatSessionId, 'executing_test', '📋 Confirming test plan...', 5);

    // Validate plan.url
    if (!plan.url || typeof plan.url !== 'string') {
      throw new Error('Invalid plan URL - URL is required for UI testing');
    }

    checkTimeout();

    // FIX #6 & #7: Confirm plan and check result properly
    const confirmResult = await confirmTestPlan(planId, userId);

    if (!confirmResult.success) {
      throw new Error(`Failed to confirm test plan: ${confirmResult.message || 'Unknown error'}`);
    }

    emitProcessingStep(chatSessionId, 'executing_test', '💳 Checking credits...', 10);
    checkTimeout();

    // FIX #10: Deduct credits BEFORE test execution (not after)
    const uiTestType = plan.intelligentMode ? 'intelligent' : 'standard';
    const testId = `ui_${planId}_${Date.now()}`;

    try {
      await CreditCostTrackerService.deductCreditsForTest({
        userId,
        testType: uiTestType,
        credits: TokenCalculatorService.getTestCreditCost(uiTestType),
        costUSD: uiTestType === 'intelligent' ? 0.08 : 0.001,
        testId,
        description: `${uiTestType} UI test: ${plan.url}`,
      });
    } catch (creditError) {
      logger.error('[UI_TEST] Failed to deduct credits', {
        error: creditError instanceof Error ? creditError.message : String(creditError),
        userId,
      });
      throw new Error('Insufficient credits or payment error');
    }

    emitProcessingStep(chatSessionId, 'executing_test', '🔍 Finding project context...', 20);
    checkTimeout();

    // FIX #8: Wrap ProjectContextService in try-catch
    let project_id: string;
    try {
      const projectResult = await ProjectContextService.findOrCreateProject(
          workspace_id,
          plan.url,
          userId
        );
      project_id = projectResult.project_id;

      if (!project_id) {
        throw new Error('Failed to get project_id from ProjectContextService');
      }
    } catch (projectError) {
      logger.error('[UI_TEST] ProjectContextService failed', {
        error: projectError instanceof Error ? projectError.message : String(projectError),
        workspace_id,
        url: plan.url,
      });
      throw new Error(`Failed to initialize project: ${projectError instanceof Error ? projectError.message : 'Unknown error'}`);
    }

    emitProcessingStep(chatSessionId, 'executing_test', '⚙️ Launching browser test...', 30);
    checkTimeout();

    // FIX #9: Wrap ManualTestService.runTest in try-catch
    let testCreated: any;
    try {
        const testRequest = {
          url: plan.url,
          browsers: ['chrome' as const],
          projectId: project_id,
          userId,
          options: {},
          commands: plan.commands,
          intent: plan.scope,
          intelligentMode: plan.intelligentMode,
          testGoal: plan.intelligentMode ? plan.summary : undefined,
          estimatedCost: plan.estimatedCost, // For dynamic credit calculation
        };
    /// Here we run the main UI/UX manual test
      testCreated = await ManualTestService.runTest(testRequest);

      if (!testCreated.success || !testCreated.data?.id) {
        throw new Error('Test creation failed - no test ID returned');
      }
    } catch (testError) {
      logger.error('[UI_TEST] ManualTestService.runTest failed', {
        error: testError instanceof Error ? testError.message : String(testError),
          url: plan.url,
      });
      throw new Error(`Failed to start test: ${testError instanceof Error ? testError.message : 'Unknown error'}`);
    }

    logger.info('✅ [UI_TEST] Test created successfully', {
            testId: testCreated.data.id,
      intelligentMode: plan.intelligentMode,
    });

    emitProcessingStep(chatSessionId, 'executing_test', '✅ Test started successfully!', 100);

    // Save test-chat mapping (non-blocking)
    if (chatSessionId && userId) {
      TestChatMappingService.saveTestChatMapping({
            testId: testCreated.data.id,
            chatSessionId,
            userId,
      }).catch(mappingError => {
        logger.error('[UI_TEST] Failed to save test-chat mapping', {
          error: mappingError instanceof Error ? mappingError.message : String(mappingError),
            testId: testCreated.data.id,
        });
          });
        }

    // Emit WebSocket event (non-blocking)
    if (chatSessionId) {
      try {
          const testModeMessage = plan.intelligentMode
            ? '🤖 Intelligent test started! AI will autonomously explore and adapt to your site.'
            : '✅ Test started! Monitor progress in real-time.';

          const chatTestUpdatePayload: ChatTestUpdatePayload = {
          sessionId: chatSessionId,
            testId: testCreated.data.id,
            message: testModeMessage,
            status: 'created',
            links: {
              fullReport: `/api/v1/manual-test/${testCreated.data.id}/summary`,
            },
          timestamp: new Date().toISOString(),
        };
          webSocketService.emitChatTestUpdate(chatSessionId, chatTestUpdatePayload);
      } catch (wsError) {
        logger.warn('[UI_TEST] Failed to emit WebSocket event', {
          error: wsError instanceof Error ? wsError.message : String(wsError),
        });
      }
        }

    // Build success message
        const testModeInfo = plan.intelligentMode
          ? `\n\n🤖 **Mode:** Intelligent/Adaptive Testing\n📊 **Estimated:** ${plan.estimatedPages || '5-10 pages'}, ${plan.estimatedCost || '$0.10-0.20'}`
          : '';

    const successMessage = `✅ Test plan approved and running!${testModeInfo}\n\nTest ID: ${testCreated.data.id}\n\nCheck status: GET /api/v1/manual-test/${testCreated.data.id}/status`;

    // FIX #11: Make chat save non-blocking (fire-and-forget)
        if (chatSessionId) {
      ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: userMessage }, // FIX #14: Use actual user message
            {
              role: 'ai',
              content: successMessage,
              metadata: {
            testId: testCreated.data.id,
                testMode: plan.intelligentMode ? 'intelligent' : 'standard',
              },
            },
      ]).catch(saveError => {
        logger.error('[UI_TEST] Failed to save chat messages', {
          error: saveError instanceof Error ? saveError.message : String(saveError),
          sessionId: chatSessionId,
        });
      });
    }

    // Send response immediately (don't wait for chat save)
        res.json({
          reply: successMessage,
      testId: testCreated.data.id,
          timestamp: new Date().toISOString(),
          sessionId: chatSessionId,
        });

    logger.info('✅ [UI_TEST] HTTP response sent successfully', {
      testId: testCreated.data.id,
      duration: Date.now() - flowStartTime,
    });
  } catch (error) {
    logger.error('❌ [UI_TEST] Critical error in UI test flow', {
      error: error instanceof Error ? error.message : String(error),
      planId,
      userId,
    });

    // If response not sent yet, send error
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'UI test failed',
        message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
      });
    }

    throw error; // Re-throw for handleExecutionError
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: HANDLE EXECUTION ERROR
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function handleExecutionError(
  error: unknown,
  res: Response,
  params: { planId: string; chatSessionId?: string }
): Promise<void> {
  const { planId, chatSessionId } = params;

  logger.error('❌ [EXECUTE] CRITICAL ERROR executing test plan', {
      error,
      planId,
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    const errorMessage = error instanceof Error && error.message
      ? error.message
      : (error ? String(error) : 'An unexpected error occurred');

  // Check if response already sent
  if (res.headersSent) {
    logger.warn('[EXECUTE] Response already sent, cannot send error response', {
      planId,
      errorMessage,
    });
    return;
  }

  // Save error to chat history (non-blocking)
    if (chatSessionId) {
    ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: 'Approved test execution' },
          { role: 'ai', content: `❌ Error executing test: ${errorMessage}` },
    ]).catch(saveError => {
      logger.error('[EXECUTE] Failed to save error message to chat', {
        saveError: saveError instanceof Error ? saveError.message : String(saveError),
        planId,
      });
    });
  }

  // Send error response
    res.status(500).json({
      success: false,
      error: 'Failed to execute test plan',
      message: errorMessage,
      timestamp: new Date().toISOString(),
    });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: EXECUTE APPROVED TEST PLAN (REFACTORED)
 * ═══════════════════════════════════════════════════════════════════════════
 * Orchestrates test plan execution flow:
 * 1. Validate test plan
 * 2. Check credits
 * 3. Route to API or UI test flow
 * 4. Handle errors
 */
async function executeApprovedTestPlan(
  req: Request,
  res: Response,
  params: {
    planId: string;
    userId: string;
    chatSessionId?: string;
    workspace_id: string;
    userMessage?: string; // FIX #14: Actual user message for chat history
  }
): Promise<void> {
  const { planId, userId, chatSessionId, workspace_id, userMessage } = params;

  logger.info('🚀 [EXECUTE] Test plan approved', {
    planId,
    userId,
    chatSessionId,
    timestamp: new Date().toISOString()
  });

  try {
    // STEP 1: Validate test plan
    const plan = await validateTestPlan(planId, userId, res);
    if (!plan) return; // Response already sent

    // STEP 2: Determine test type
    const testType = determineTestType(plan);
    const isApiTest = testType === 'api';

    // STEP 3: Check credits
    const creditCheckPassed = await checkCreditsBeforeTest(userId, testType, res);
    if (!creditCheckPassed) return; // Response already sent

    // STEP 4: Route to appropriate test flow
    if (isApiTest) {
      await executeApiTestFlow(res, {
        plan,
        planId,
        userId,
        chatSessionId,
        userMessage, // FIX #14: Pass user message
      });
    } else {
      await executeUiTestFlow(res, {
        plan,
        planId,
        userId,
        chatSessionId,
        workspace_id,
        userMessage, // FIX #14: Pass user message
      });
    }
  } catch (error) {
    await handleExecutionError(error, res, { planId, chatSessionId });
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPERS: CHAT HISTORY & CONTEXT
 * ═══════════════════════════════════════════════════════════════════════════
 */

// REMOVED: Duplicate function - use ChatService.getRecentMessages() instead






/**
 * Compress long test plans in message content
 */
function compressMessageContent(content: string): string {
  // If content contains a test plan (detected by length and keywords)
  if (content.length > 1000 && (
    content.includes('Test Plan') ||
    content.includes('test plan') ||
    content.includes('✅') && content.includes('❌')
  )) {
    // Extract key info
    const urlMatch = content.match(/https?:\/\/[^\s)]+/);
    const url = urlMatch ? urlMatch[0] : 'URL';

    const approvalMatch = content.match(/approved|rejected/i);
    const status = approvalMatch ? approvalMatch[0] : 'shown';

    return `[Test plan for ${url} - ${status}]`;
  }

  // If content is very long, truncate
  if (content.length > 2000) {
    return content.substring(0, 2000) + '... [truncated]';
  }

  return content;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPERS: CHAT SESSION MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Get or create chat session with multi-chat support
 * @param userId - User ID
 * @param providedSessionId - Existing session ID (optional)
 * @param workspaceId - Workspace ID
 * @param createNew - Force create new session (for multi-chat support)
 * @returns Chat session ID or undefined for anonymous
 */
async function getOrCreateChatSession(
  userId: string,
  providedSessionId: string | undefined,
  workspaceId: string,
  createNew: boolean = false
): Promise<string | undefined> {
  // FIX #7: Use centralized UUID validation
  if (!isValidUUID(userId)) {
    // Anonymous user - no session
    return undefined;
  }

  // If providedSessionId exists, verify and use it
  if (providedSessionId) {
    const { data: existing } = await supabaseAdmin
      .from('chat_sessions')
      .select('id')
      .eq('id', providedSessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      logger.info('[CHAT_SESSION] Using provided session', { sessionId: existing.id, userId });
      return existing.id;
    } else {
      logger.warn('[CHAT_SESSION] Provided session not found, will create new', {
        providedSessionId,
        userId,
      });
    }
  }

  // If createNew = true, always create new session (multi-chat support)
  if (createNew) {
    logger.info('[CHAT_SESSION] Creating new chat session (multi-chat)', { userId, workspaceId });
    return await ChatService.createChatSession(userId, workspaceId);
  }

  // Otherwise, find latest session (backward compatibility)
  const { data: existing } = await supabaseAdmin
    .from('chat_sessions')
    .select('id')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false }) // Sort by updated_at for recent activity
    .limit(1)
    .maybeSingle();

  if (existing) {
    logger.info('[CHAT_SESSION] Using existing session', { sessionId: existing.id, userId });
    return existing.id;
  }

  // Create new session if none exists
  logger.info('[CHAT_SESSION] No existing session, creating new', { userId, workspaceId });
  return await ChatService.createChatSession(userId, workspaceId);
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPERS: TYPE CONVERSIONS
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Convert ApiTestPlan to unified TestPlan format
 * This allows API tests to use the same storage and execution flow as UI tests
 */
function convertApiTestPlanToTestPlan(apiPlan: any): any {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + CONSTANTS.TEST_PLAN_EXPIRY_HOURS);

  return {
    id: apiPlan.id,
    status: 'pending_confirmation',
    url: apiPlan.url,
    scope: 'api_test', // Special scope for API tests
    summary: apiPlan.summary,
    steps: apiPlan.validation_steps.map((step: string, index: number) => ({
      id: `step_${index + 1}`,
      action: 'validate',
      description: step,
    })),
    commands: [], // No Playwright commands for API tests
    estimatedDuration: apiPlan.estimated_duration,
    whatWillBeTested: apiPlan.what_will_be_tested,
    whatWillNotBeTested: [], // Not provided in ApiTestPlan
    risks: apiPlan.potential_issues || [],
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    // Store API-specific data in metadata
          metadata: {
      type: 'api_test',
      method: apiPlan.method,
      headers: apiPlan.headers,
      body: apiPlan.body,
      expectedStatus: apiPlan.expected_status,
    },
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPERS: WEBSOCKET EVENTS
 * ═══════════════════════════════════════════════════════════════════════════
 */

function emitProcessingStep(
  sessionId: string | undefined,
  step: ChatProcessingStepPayload['step'],
  message: string,
  progress: number
): void {
  if (!sessionId) return;

  const payload: ChatProcessingStepPayload = {
    sessionId,
    step,
    message,
    progress,
    timestamp: new Date().toISOString(),
  };

  webSocketService.emitChatProcessingStep(sessionId, payload);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HISTORY AND SESSION HANDLERS (Legacy from backup for routes compatibility)
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Get current chat history (single active session per user)
 */
export const getCurrentChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    // Get user's session
    const { data: session } = await supabaseAdmin
        .from('chat_sessions')
        .select('id, title, created_at')
      .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!session) {
      res.json({
        success: true,
        data: {
          session: null,
          messages: [],
          pagination: { limit, offset, total: 0, has_more: false },
        },
      });
      return;
    }

    // Get total count
    const { count } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', session.id);

    // Get messages (newest first when offset=0)
    const { data: messages } = await supabaseAdmin
      .from('chat_messages')
      .select('id, role, content, metadata, created_at')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    res.json({
      success: true,
      data: {
        session,
        messages: messages || [],
        pagination: {
          limit,
          offset,
          total: count || 0,
          has_more: (offset + limit) < (count || 0),
        },
      },
    });
  } catch (error) {
    logger.error('[CHAT_HISTORY] Error getting current history', { error });
    res.status(500).json({ error: 'Failed to get chat history' });
  }
};

/**
 * Get all chat sessions for user
 */
export const getChatSessions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const { data: sessions } = await supabaseAdmin
      .from('chat_sessions')
      .select(`
        id,
        title,
        created_at,
        chat_messages (
          id,
          role,
          content,
          created_at
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const processedSessions = (sessions || []).map((session: any) => ({
        id: session.id,
        title: session.title,
        created_at: session.created_at,
      message_count: session.chat_messages?.length || 0,
      last_message: session.chat_messages?.[0] || null,
    }));

    res.json({
      success: true,
      data: {
        sessions: processedSessions,
        pagination: {
          limit,
          offset,
          total: processedSessions.length,
        },
      },
    });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error getting sessions', { error });
    res.status(500).json({ error: 'Failed to get chat sessions' });
  }
};

/**
 * Get chat history by session ID
 */
export const getChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;

    // Verify session belongs to user
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, title, created_at')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Get all messages for this session
    const { data: messages } = await supabaseAdmin
      .from('chat_messages')
      .select('id, role, content, metadata, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    res.json({
      success: true,
      data: {
        session,
        messages: messages || [],
      },
    });
  } catch (error) {
    logger.error('[CHAT_HISTORY] Error getting history', { error, sessionId: req.params.sessionId });
    res.status(500).json({ error: 'Failed to get chat history' });
  }
};

/**
 * Debug: Get all chat data for user
 */
export const debugChatData = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from('chat_sessions')
      .select('*')
      .eq('user_id', userId);

    const sessionIds = sessions?.map(s => s.id) || [];
    const { data: messages, error: messagesError } = sessionIds.length > 0
      ? await supabaseAdmin
          .from('chat_messages')
          .select('*')
          .in('session_id', sessionIds)
      : { data: [], error: null };

    res.json({
      success: true,
      debug: {
        userId,
        sessions: sessions || [],
        messages: messages || [],
        errors: {
          sessions: sessionsError?.message,
          messages: messagesError?.message,
        },
      },
    });
  } catch (error) {
    logger.error('[DEBUG] Error getting chat data', { error });
    res.status(500).json({ error: 'Debug failed' });
  }
};

/**
 * Build user-friendly intent message for WebSocket
 */
function buildIntentMessage(parsedIntent: any): string {
  if (!parsedIntent) {
    return '🤔 Understanding your request...';
  }

  const { intent, scope, target, page, apiMethod, apiUrl, urgency } = parsedIntent;

  switch (intent) {
    case 'api_test':
      if (apiUrl && apiMethod) {
        return `🔍 Got it! Testing ${apiMethod} ${apiUrl}`;
      } else if (apiUrl) {
        return `🔍 Got it! Testing API endpoint ${apiUrl}`;
      } else {
        return '🔍 Got it! You want to test an API endpoint';
      }

    case 'platform_test':
      if (page && scope && target) {
        return `🌐 Got it! Testing ${target} on ${page}`;
      } else if (page && scope) {
        return `🌐 Got it! Testing ${scope} on ${page}`;
      } else if (scope && target) {
        return `🌐 Got it! Testing ${target} (${scope})`;
      } else if (page) {
        return `🌐 Got it! Testing website ${page}`;
      } else {
        return '🌐 Got it! You want to test a website';
      }

    case 'general_chat':
      return '💬 Got it! Let me help you with that';

    default:
      return '✅ Intent understood!';
  }
}
