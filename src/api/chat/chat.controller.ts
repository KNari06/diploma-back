import { env } from '@/config/environment/env';
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
import {
  cancel as registryCancel,
  hasActive as registryHasActive,
  keyOfTestCase,
  register as registryRegister,
  unregister as registryUnregister,
  type RequestKey,
} from './shared/request-key';
import { routeToHandler } from './shared/routing';
import { parseMobileContext } from './mobile_agent/shared';
import { incCounter } from '@/utils/core/mobile-chat-metrics';
import { checkWorkspace, manageChatSession, validateInput } from './shared/validation';
import { handlePendingExplorationConfirmation } from './shared/exploration-confirmation';
import {
  TestCaseNotFoundError,
  assertCanAccessTestCase,
  type TestCaseAccess,
} from './shared/test-case-access';
// AccessDeniedError lives in workspace-access.service (re-thrown by
// assertCanAccessTestCase). Importing it directly here keeps the
// catch-block narrow without leaning on type widening.
import { AccessDeniedError } from '@/services/core/workspace-access.service';
import { TestCaseChatService } from '@/services/utils/test-case-chat.service';
import { GLOBAL_STORE, TESTCASE_STORE, type ChatStore } from '@/services/utils/chat-store';
// Used to emit the early "Analyzing..." progress event in the test-case
// branch — the legacy path gets it from `manageChatSession`, but our
// test-case branch bypasses that helper and would otherwise leave the
// chat-room subscriber with no UI feedback during the first request.
import { PROGRESS, emitProcessingStep } from './shared/utils';

// History handlers
import { debugChatData, getChatHistory, getChatSessions, getCurrentChatHistory } from './history';

/**
 * Phase B1: decide whether to short-circuit the LLM intent classifier
 * for a chat request that came from the Mobile Session Debug surface.
 *
 * Returns a synthesised `parsedIntent` (mobile_agent) when force-route
 * conditions are met, or null when the normal classifier path should
 * run. Pure function — caller passes the parsed context and the env
 * flag, gets back a decision. Easy to unit-test.
 *
 * Why we route everything to `mobile_agent` (not `mobile_action` for
 * one-shot taps): the agent handler subsumes the action handler — it
 * can dispatch single tools too, just with one extra LLM roundtrip.
 * The cost (one extra ~500ms LLM call on direct-action requests like
 * "tap login") is the price we pay to guarantee correctness on the
 * observation case ("what do you see?") that this whole phase was
 * built to fix. A future refinement could splitting on action-verb
 * detection, but heuristics here re-introduce the very classifier
 * fragility we're trying to bypass.
 *
 * Conditions for force-route (ALL must hold):
 *   - env.MOBILE_EDITOR_FORCE_ROUTE is on (default true)
 *   - context.mobileEditorMode === true
 *   - context.mobileSessionId is a non-empty string
 *
 * Missing mobileSessionId with mobileEditorMode=true is a frontend race
 * (session teardown overlap) — falls through to the classifier so
 * mobile_agent's own NO_SESSION_REPLY explains the situation instead of
 * a silent misroute.
 */
export function decideForceRoute(
  context: unknown,
  flagEnabled: boolean,
): { intent: 'mobile_agent'; intent_confidence: number; confidence: number; metadata: { routingSource: 'force_route' } } | null {
  if (!flagEnabled) return null;
  const ctx = parseMobileContext(context);
  if (!ctx) return null;
  if (ctx.mobileEditorMode !== true) return null;
  if (typeof ctx.mobileSessionId !== 'string' || ctx.mobileSessionId.length === 0) {
    return null;
  }
  return {
    intent: 'mobile_agent',
    intent_confidence: 1.0,
    confidence: 1.0,
    metadata: { routingSource: 'force_route' },
  };
}

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

  // Persistence binding decided per-request. Default GLOBAL_STORE keeps
  // the legacy workspace-chat code path 100% unchanged for any request
  // that does not opt in via `testCaseId`. Switched to TESTCASE_STORE
  // inside the `if (testCaseId)` branch below, after access check.
  let chatStore: ChatStore = GLOBAL_STORE;
  // RequestKey used for the cancellation namespace + concurrency guard.
  // For legacy global path we keep using the legacy registry helpers
  // (registerActiveRequest / hasActiveRequest / unregisterActiveRequest)
  // so behavior is byte-for-byte identical. For test-case path we use
  // the new namespaced registry — see below.
  let requestKey: RequestKey | undefined;
  let testCaseAccess: TestCaseAccess | undefined;

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
    const { message, context, sessionId, conversationId, answers, attachments, testCaseId } = inputResult;
    checkRequestTimeout(); // Check timeout after validation

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: WORKSPACE / TEST-CASE ACCESS RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════
    // Two parallel resolution paths:
    //
    //   - Legacy (no testCaseId): keep `checkWorkspace(userId, sessionId)`
    //     unchanged — this is the path 100% of production traffic uses
    //     today and we must not regress it.
    //
    //   - Test-case (testCaseId present): resolve ownership through the
    //     intent_test_cases → projects → workspace_members chain via
    //     `assertCanAccessTestCase`. Returns (workspaceId, projectId,
    //     ownerId) in one helper call so we don't duplicate workspace
    //     lookups elsewhere. Throws TestCaseNotFoundError (404) or
    //     AccessDeniedError (403) which the catch-block at the bottom
    //     translates into HTTP responses.
    //
    // The `chatStore` switch happens here too so every downstream save/
    // read picks the correct backend tables.
    let workspace_id: string;
    if (testCaseId) {
      // ─────────────────────────────────────────────────────────────────
      // Feature flag gate (ENABLE_TEST_CASE_CHAT).
      //
      // When the flag is OFF we explicitly REJECT requests that try to
      // use the per-test-case path rather than silently falling back to
      // the global chat. Falling back would write the message to the
      // global `chat_messages` table with no link back to the test
      // case — creating exactly the kind of silent cross-write the
      // ChatStore architecture was designed to prevent.
      //
      // 501 Not Implemented (vs 404) tells the frontend "the route
      // exists but this deployment hasn't enabled it yet" — clearer
      // signal than 404 which would suggest the test case is missing.
      // ─────────────────────────────────────────────────────────────────
      if (!env.ENABLE_TEST_CASE_CHAT) {
        logger.warn('[CHAT] Rejected testCaseId request — ENABLE_TEST_CASE_CHAT is off', {
          userId: userId.substring(0, 8) + '...',
          testCaseId,
        });
        if (!res.headersSent) {
          res.status(501).json({
            success: false,
            error: 'Per-test-case chat is not enabled in this deployment',
            code: 'FEATURE_DISABLED',
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }
      try {
        testCaseAccess = await assertCanAccessTestCase(userId, testCaseId);
      } catch (err) {
        if (err instanceof TestCaseNotFoundError) {
          if (!res.headersSent) {
            res.status(404).json({
              success: false,
              error: err.message,
              code: 'TEST_CASE_NOT_FOUND',
              timestamp: new Date().toISOString(),
            });
          }
          return;
        }
        if (err instanceof AccessDeniedError) {
          if (!res.headersSent) {
            res.status(403).json({
              success: false,
              error: err.message,
              code: 'ACCESS_DENIED',
              timestamp: new Date().toISOString(),
            });
          }
          return;
        }
        throw err;
      }
      workspace_id = testCaseAccess.workspaceId;
      chatStore = TESTCASE_STORE;
    } else {
      const checkWorkspaceWithLogging = withFunctionLogging(checkWorkspace, 'checkWorkspace', functionLogger);
      workspace_id = await checkWorkspaceWithLogging(userId, sessionId);
    }
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
          code: 'INSUFFICIENT_CREDITS',
          message: `You need at least ${chatCreditCheck.required} credit(s) to use the chat. You have ${chatCreditCheck.available} credit(s). Please purchase ${chatCreditCheck.shortage} more credit(s) to continue.`,
          required: chatCreditCheck.required,
          available: chatCreditCheck.available,
          shortage: chatCreditCheck.shortage,
          details: {
            required: chatCreditCheck.required,
            available: chatCreditCheck.available,
            shortage: chatCreditCheck.shortage,
          },
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    checkRequestTimeout();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: CHAT SESSION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════
    // Legacy path: workspace-default chat — `manageChatSession` get-or-
    // creates by (user_id, workspace_id) and ignores any client-supplied
    // sessionId that doesn't belong to the user. Behavior unchanged.
    //
    // Test-case path: lazy upsert by (user_id, test_case_id). Idempotent
    // under concurrent first-message races thanks to the UNIQUE
    // constraint in the migration. Client-supplied sessionId is ignored
    // — for test-case chats, the session id is owned by the backend and
    // resolved purely from testCaseId.
    if (testCaseId) {
      try {
        const session = await TestCaseChatService.getOrCreateSession(userId, testCaseId);
        chatSessionId = session.id;
      } catch (err) {
        logger.error('[CHAT] Failed to lazy-create test-case session', {
          userId: userId.substring(0, 8) + '...',
          testCaseId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Surface as 500 rather than swallowing — without a session id
        // the test-case path cannot proceed (no place to save messages).
        throw err;
      }
      // Mirror the legacy "Analyzing your request..." progress emit that
      // `manageChatSession` does for the global path. Without this, the
      // frontend subscribed to `chat:tc:<tcid>` shows zero feedback
      // between sending the message and the first sub-agent step.
      // Dual-broadcast via testCaseId — `chat:<sid>` reaches sockets
      // already in the per-session room (returning users), `chat:tc:<tcid>`
      // reaches first-time subscribers.
      emitProcessingStep(
        chatSessionId,
        'enriching_context',
        'Analyzing your request...',
        PROGRESS.ENRICHING,
        undefined,
        testCaseId,
      );
    } else {
      const manageChatSessionWithLogging = withFunctionLogging(manageChatSession, 'manageChatSession', functionLogger);
      chatSessionId = await manageChatSessionWithLogging(userId, sessionId, workspace_id, checkRequestTimeout, functionLogger);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2.2: PREVENT UNEXPECTED CONCURRENT REQUESTS
    // ═══════════════════════════════════════════════════════════════════════
    // Frontend should not send a new message while a previous request is
    // still processing. If it happens anyway (retries/double submit) we
    // return 409 — never auto-cancel, the user is the only one who can
    // decide to cancel.
    //
    // For the test-case path the concurrency guard uses the namespaced
    // RequestKey registry — its Map is separate from the legacy global
    // Map, so an in-flight global chat for the same user does NOT block
    // a test-case chat (they're independent surfaces). Symmetrically a
    // test-case chat does not block a global chat.
    let alreadyActive = false;
    if (chatStore.kind === 'testcase' && chatSessionId) {
      requestKey = keyOfTestCase(chatSessionId);
      alreadyActive = await registryHasActive(requestKey);
    } else {
      const hasActiveRequestWithLogging = withFunctionLogging(hasActiveRequest, 'hasActiveRequest', functionLogger);
      alreadyActive = await hasActiveRequestWithLogging(chatSessionId, userId);
    }
    if (alreadyActive) {
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
    // Register this request so it can be cancelled via /cancel endpoint.
    // Test-case requests register under their own namespace so cancelling
    // a test-case chat never aborts the user's global chat (and vice
    // versa). The returned AbortController is the same shape regardless
    // of which registry handled the call — handlers don't care.
    if (chatStore.kind === 'testcase' && requestKey) {
      abortController = await registryRegister(requestKey, userId, message);
    } else {
      const registerActiveRequestWithLogging = withFunctionLogging(registerActiveRequest, 'registerActiveRequest', functionLogger);
      abortController = await registerActiveRequestWithLogging(chatSessionId, userId, message);
    }
    const abortSignal = abortController.signal;

    // Check if already aborted (shouldn't happen, but safety check)
    const checkRequestAbortedWithLogging = withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger);
    checkRequestAbortedWithLogging(abortSignal);

    // Check if request was cancelled
    checkRequestAbortedWithLogging(abortSignal);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4.5: CHECK PENDING EXPLORATION CONFIRMATION
    // If user previously requested exploration and we asked for confirmation,
    // handle the yes/no response before parsing a new intent.
    //
    // Test-case scope skip: exploration confirmation is part of the
    // workspace-chat regression flow (saved-test execution, scheduling,
    // etc.). All those intents are blocked in test-case scope, so the
    // confirmation flag can only originate from the global chat. Reading
    // it here would let a global "yes" leak into a test-case turn.
    // ═══════════════════════════════════════════════════════════════════════
    if (chatStore.kind === 'global') {
      const explorationHandled = await handlePendingExplorationConfirmation(
        req, res, message, chatSessionId!, userId, workspace_id,
      );
      if (explorationHandled) {
        const unregisterActiveRequestWithLogging = withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger);
        await unregisterActiveRequestWithLogging(chatSessionId, userId);
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4.7 (Phase B1): MOBILE EDITOR FORCE-ROUTE
    // ═══════════════════════════════════════════════════════════════════════
    // The frontend's Mobile Session Debug surface (TestSuitesMobile.tsx)
    // ALWAYS attaches `context.mobileEditorMode=true` + a live
    // `mobileSessionId` to every chat request. Every message in that
    // surface is about THIS mobile session — never an API test, regression
    // suite, or web preview. The text-based intent classifier sometimes
    // mis-routes short / chatty messages ("hi", "what do you see?") to
    // `general_chat`, which has no mobile context and no
    // `observe_mobile_page` tool — that's the trace behind the user-
    // reported "I help with UI/API/regression…" generic reply.
    //
    // We trust the frontend signal here for the same reason web trusts
    // `mode === 'editor'` — both are set by the editor shell, not by the
    // user. A request with `mobileEditorMode=true` but no `mobileSessionId`
    // is a frontend race (session teardown overlap); we fall through to
    // the normal classifier so `mobile_agent` returns its own
    // `NO_SESSION_REPLY` instead of a silent misroute.
    //
    // Kill switch: env `MOBILE_EDITOR_FORCE_ROUTE=false` reverts to
    // classifier-only routing.
    const forceRouteIntent = decideForceRoute(context, env.MOBILE_EDITOR_FORCE_ROUTE);

    let parsedIntent: Awaited<ReturnType<typeof parseIntent>>;
    if (forceRouteIntent) {
      parsedIntent = forceRouteIntent as Awaited<ReturnType<typeof parseIntent>>;
      // Phase B7: count force-route hits so ops can verify the path is
      // actually firing on real Mobile-Editor traffic. Label = `applied`
      // so future work can distinguish e.g. `disabled_by_env`.
      incCounter('mobile_chat.force_route', 'applied');
      logger.info('[CHAT] mobileEditorMode force-route → mobile_agent', {
        chatSessionId,
        userId,
        // Re-parse here just for the log field — the helper already
        // validated mobileSessionId is a non-empty string, so this is
        // safe to cast.
        mobileSessionId: (parseMobileContext(context) as { mobileSessionId: string }).mobileSessionId,
        messagePreview: message.slice(0, 60),
      });
      // Same abort guard the classifier path runs immediately after
      // its LLM call — preserves the existing cancellation contract.
      checkRequestAbortedWithLogging(abortSignal);
    } else {
      // ═══════════════════════════════════════════════════════════════════════
      // STEP 5: PARSE INTENT (FIX #5)
      // ═══════════════════════════════════════════════════════════════════════
      // `isTestCaseScope` activates the per-test-case intent guard inside
      // parseIntent (mirrors the editor-mode platform_test guard). Blocked
      // intents are silently rewritten to general_chat with a logged warning;
      // the user gets a normal AI reply rather than a 4xx they can't recover
      // from mid-flow.
      const parseIntentWithLogging = withFunctionLogging(parseIntent, 'parseIntent', functionLogger);
      parsedIntent = await parseIntentWithLogging(
        message,
        context,
        chatSessionId,
        userId,
        workspace_id,
        checkRequestTimeout,
        abortSignal, // Pass abort signal for cancellation checks
        functionLogger,
        inputResult.mode || 'lite', // Pass mode for editor action detection
        chatStore.kind === 'testcase', // isTestCaseScope
        testCaseId, // dual-emit progress events into chat:tc:<tcid>
      );

      // Check if request was cancelled
      checkRequestAbortedWithLogging(abortSignal);
    }

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
            sourceTestCases: resolverResult.relatedCases?.map((c) => ({
              id: c.id,
              name: c.name,
              matchScore: c.score,
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
      executionStrategy: inputResult.executionStrategy, // Explicit exploration from frontend
      attachments, // File attachments (images + documents)
      // Persistence binding: GLOBAL_STORE for legacy, TESTCASE_STORE
      // when this is a per-test-case chat. Migrated handlers
      // (general_chat, editor_action) use this to route saves through
      // ChatPersistence; legacy handlers receive but ignore it.
      chatStore,
      testCaseId,
    });

    // Unregister request on successful completion. Use the namespaced
    // registry for test-case requests so we don't drop a global-Map
    // entry that doesn't exist (cheap, but cleaner state).
    if (chatStore.kind === 'testcase' && requestKey) {
      await registryUnregister(requestKey, userId);
    } else {
      const unregisterActiveRequestWithLogging = withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger);
      await unregisterActiveRequestWithLogging(chatSessionId, userId);
    }

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

    // Unregister request on error. Use the same registry the request was
    // registered against — otherwise we leak the AbortController and
    // future requests for this session 409 forever.
    if (chatSessionId && userId) {
      if (chatStore.kind === 'testcase' && requestKey) {
        await registryUnregister(requestKey, userId);
      } else {
        const unregisterActiveRequestWithLogging = withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger);
        await unregisterActiveRequestWithLogging(chatSessionId, userId);
      }
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
