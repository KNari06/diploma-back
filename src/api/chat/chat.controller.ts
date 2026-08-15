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
import { isApiFlowRequest } from './api_flow/handler';
import type { ChatAttachment } from './chat.types';
import { parseMobileContext } from './mobile_agent/shared';
import { installScopeRefusalTelemetry } from './shared/scope-refusal-telemetry';
import { incCounter } from '@/utils/core/mobile-chat-metrics';
import { checkWorkspace, manageChatSession, validateInput } from './shared/validation';
import { handlePendingExplorationConfirmation } from './shared/exploration-confirmation';
import { handlePendingManageConfirmation } from './regression/shared/manage-confirmation';
import { handlePendingRunExistingConfirmation } from './shared/run-existing-confirmation';
import {
  clearPendingEditorConfirmation,
  handlePendingEditorConfirmation,
} from './shared/editor-confirmation';
import { handleEditorSaveRequest, isEditorSaveRequest } from './shared/editor-save';
import {
  beginCompound,
  clearPendingCompound,
  completeStep,
  isCompoundCancel,
  peekCurrentStep,
  toCompoundSteps,
} from './shared/compound-queue';
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
import { ChatService } from '@/services/utils/chat.service';
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
 *
 * mobileSessionId is deliberately NOT a condition. mobileEditorMode=true
 * with a missing/empty mobileSessionId means the mobile editor has no live
 * runner session (never started, expired, or a teardown race). Falling
 * through to the classifier here — the old behaviour — was a silent
 * misroute: the classifier has no mobile signal left, sends the message to
 * web general_chat, and the user gets a generic answer with no hint that
 * the device session is the problem. Force-routing to mobile_agent instead
 * guarantees the handler's own NO_SESSION_REPLY ("start a device in the
 * editor") surfaces the real cause. `metadata.missingSession` marks the
 * degraded case for logs/metrics.
 */
export function decideForceRoute(
  context: unknown,
  flagEnabled: boolean,
): { intent: 'mobile_agent'; intent_confidence: number; confidence: number; metadata: { routingSource: 'force_route'; missingSession?: true } } | null {
  if (!flagEnabled) return null;
  const ctx = parseMobileContext(context);
  if (!ctx) return null;
  if (ctx.mobileEditorMode !== true) return null;
  const hasSession =
    typeof ctx.mobileSessionId === 'string' && ctx.mobileSessionId.length > 0;
  return {
    intent: 'mobile_agent',
    intent_confidence: 1.0,
    confidence: 1.0,
    metadata: { routingSource: 'force_route', ...(hasSession ? {} : { missingSession: true as const }) },
  };
}

/**
 * Force-route an API-spec upload/paste to the api_flow_test handler.
 *
 * The intent classifier (`parseUserIntent`) sees only the typed message text —
 * it has NO attachment/filename context. So a user who drops a Python project
 * zip (or a .py / OpenAPI / Postman / HAR file) with a message like "here's my
 * project" gets classified as general_chat, the extracted code is fed to the
 * chat LLM as context, and NO flow is ever built — a silent drop the user reads
 * as success. `isApiFlowRequest` already encodes the detection (spec URL, cURL,
 * pasted Python, or a spec/archive attachment by extension); it was exported
 * but never called. Wire it here so the deterministic signal wins over the
 * blind classifier.
 *
 * Returns a minimal parsed-intent-shaped object (matching the mobile
 * force-route contract) or null to fall through to the classifier. Kill switch:
 * env `API_FLOW_FORCE_ROUTE=false`.
 */
export function decideApiFlowRoute(
  message: string,
  attachments: ChatAttachment[] | undefined,
  flagEnabled: boolean,
): { intent: 'api_flow_test'; intent_confidence: number; confidence: number; metadata: { routingSource: 'force_route' } } | null {
  if (!flagEnabled) return null;
  if (!isApiFlowRequest(message, attachments)) return null;
  return {
    intent: 'api_flow_test',
    intent_confidence: 1.0,
    confidence: 1.0,
    metadata: { routingSource: 'force_route' },
  };
}

/**
 * Pull the client-selected `projectId` out of the request context, which
 * arrives either as an already-parsed object or as a JSON string (multipart
 * uploads). Returns a trimmed non-empty id or undefined. Pure — no validation
 * of access here; the caller must verify the user may use the project.
 */
export function extractContextProjectId(context: unknown): string | undefined {
  let ctx: unknown = context;
  if (typeof ctx === 'string') {
    try {
      ctx = JSON.parse(ctx);
    } catch {
      return undefined;
    }
  }
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return undefined;
  const pid = (ctx as Record<string, unknown>).projectId;
  return typeof pid === 'string' && pid.trim().length > 0 ? pid.trim() : undefined;
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
      // Test-case scope IS the editor surface — the user is looking at a live
      // preview of this test case. Force editor mode so the general_chat
      // executor prompt activates its editor flow (generate steps → confirm →
      // run on preview → save). Backstop for older/mismatched clients that
      // still send the lite/pro toggle value; the desktop client now sends
      // mode='editor' itself, but the lite/pro toggle is a workspace-chat
      // concept that must never leak into a test-case chat. Single source of
      // truth: both parseIntent and routeToHandler read inputResult.mode.
      inputResult.mode = 'editor';
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
      // In test-case scope the emit routes EXCLUSIVELY to `chat:tc:<tcid>`
      // (passing testCaseId) — never to `chat:<sid>` — so an editor chat
      // event cannot surface in the global chat sharing the socket.
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

      // TIER-0 PROJECT SYNC (global scope): the frontend sends the project the
      // user has selected in the UI switcher via `context.projectId`. Several
      // handlers (general_chat, api_test, ai_test, mobile_agent) resolve their
      // project from `chat_sessions.project_id`, which otherwise only gets set
      // once by the platform_test flow and then goes stale — so the chat could
      // answer about the wrong project after the user switches. Validate the
      // selection (owner OR workspace member — IDOR guard) and sync the binding
      // ONCE here so every downstream handler reads the correct project. Best-
      // effort: never block the turn. See global-chat-wrong-project fix.
      const selectedProjectId = extractContextProjectId(context);
      if (selectedProjectId && chatSessionId) {
        try {
          const { getAccessibleProject } = await import('@/services/chat/mobile-project-context.service');
          const accessible = await getAccessibleProject(userId, selectedProjectId);
          if (accessible) {
            await ChatService.updateSessionProject(chatSessionId, accessible.id, userId);
          } else {
            logger.warn('[CHAT] Client-supplied projectId rejected (no access) — leaving session binding as-is', {
              userId: userId.substring(0, 8) + '...',
              selectedProjectId,
            });
          }
        } catch (syncErr) {
          logger.warn('[CHAT] Failed to sync chat_sessions.project_id to selected project', {
            error: syncErr instanceof Error ? syncErr.message : String(syncErr),
            chatSessionId,
          });
        }
      }
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

      // Two-phase confirm for management ops: a bare "yes" replying to a
      // manage_* preview would otherwise be classified as general_chat and the
      // approval lost. Intercept it here and re-run the stored op.
      const manageHandled = await handlePendingManageConfirmation(
        req, res, message, chatSessionId!, userId,
      );
      if (manageHandled) {
        const unregisterActiveRequestWithLogging = withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger);
        await unregisterActiveRequestWithLogging(chatSessionId, userId);
        return;
      }

      // "Run an existing saved test" confirmation: when the user previously
      // asked to run a test and we offered matching saved test cases, this
      // turn's yes/no/pick reply runs the chosen one (web/mobile auto-routed).
      const runExistingHandled = await handlePendingRunExistingConfirmation(
        req, res, message, chatSessionId!, userId,
      );
      if (runExistingHandled) {
        const unregisterActiveRequestWithLogging = withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger);
        await unregisterActiveRequestWithLogging(chatSessionId, userId);
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4.6: CHECK PENDING EDITOR (TEST-CASE) CONFIRMATION
    // ═══════════════════════════════════════════════════════════════════════
    // The editor half of the same two-phase confirm. Without this, a "yes"
    // answering a write tool's preview is ordinary free text: the executor
    // re-plans and the save is silently never issued (observed live — see
    // shared/editor-confirmation.ts). Runs before intent parsing so the
    // approval reaches the SAME cached call, not a freshly re-planned one.
    //
    // Scoped to test-case chats for the mirror-image reason the block above is
    // scoped to global: the pending op can only have been cached by an editor
    // turn, so reading it from a global turn would let one surface's "yes"
    // trigger the other's pending write.
    if (chatStore.kind === 'testcase' && chatSessionId) {
      const editorHandled = await handlePendingEditorConfirmation(
        res, message, chatSessionId, userId,
      );
      if (editorHandled) {
        if (requestKey) await registryUnregister(requestKey, userId);
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4.65 (Phase 3): COMPOUND CONTINUATION
    // ═══════════════════════════════════════════════════════════════════════
    // A compound request ("test A and B, then save as a plan") runs one step
    // per turn. If a pending compound exists for this session, this turn drives
    // the NEXT step: we replace the message with the queued step text and let
    // the normal parse+route path below run it. The remainder is re-queued by
    // advanceCompound. Global chat only (test-case scope never queues).
    let effectiveMessage = message;
    let isCompoundContinuation = false;
    if (chatStore.kind === 'global' && chatSessionId) {
      // Explicit abandon ("stop"/"отмена") clears the whole queue.
      const pendingStep = await peekCurrentStep(chatSessionId);
      if (pendingStep && isCompoundCancel(message)) {
        await clearPendingCompound(chatSessionId);
        res.json({
          success: true,
          message: 'Okay, stopped the multi-step request. What would you like to do?',
          timestamp: new Date().toISOString(),
          sessionId: chatSessionId,
        });
        await withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger)(chatSessionId, userId);
        return;
      }
      if (pendingStep) {
        // ADVANCE-AFTER-SUCCESS: run the CURRENT (peeked, not popped) step. The
        // queue only advances once the step's handler reports success — see the
        // res-wrapper + completeStep call after routeToHandler below.
        logger.info('[COMPOUND] Continuing compound request', {
          step: pendingStep.index, total: pendingStep.total, userId,
        });
        effectiveMessage = pendingStep.text;
        isCompoundContinuation = true;
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
    // (session never started / expired / teardown race) ALSO force-routes:
    // `mobile_agent` replies with its own `NO_SESSION_REPLY`, which tells
    // the user to start a device — the classifier would have silently
    // misrouted the message to web general_chat.
    //
    // Kill switch: env `MOBILE_EDITOR_FORCE_ROUTE=false` reverts to
    // classifier-only routing.
    const mobileForceRoute = decideForceRoute(context, env.MOBILE_EDITOR_FORCE_ROUTE);

    // API-flow force-route: an uploaded spec/archive/.py (or pasted cURL /
    // Python / Swagger URL) deterministically routes to api_flow_test — the
    // classifier is blind to attachments and would silently drop a files-only
    // upload into general_chat. Global scope only: a per-test-case chat is the
    // editor surface (see Hard invariant #16) and must keep its own flow.
    // Mobile force-route wins if both match. Kill switch: `API_FLOW_FORCE_ROUTE=false`.
    const apiFlowForceRoute =
      !mobileForceRoute && chatStore.kind === 'global'
        ? decideApiFlowRoute(effectiveMessage, attachments, env.API_FLOW_FORCE_ROUTE)
        : null;

    const forceRouteIntent = mobileForceRoute ?? apiFlowForceRoute;

    // Backstop for the force-route: a chat scoped to a MOBILE test case whose
    // request carries no mobileEditorMode flag at all — a stale client build,
    // or (the common case) an editor whose runner session died, since the
    // frontend only sends the flags alongside a live `mobileSessionId`.
    //
    // This used to log + tag and then let the message fall through to the
    // classifier, which sends it to WEB general_chat: a surface with no device,
    // no open test case, and no authoring tools, but the SAME scope-guard block.
    // An authoring request landing there gets a generic answer at best, and the
    // user has no way to tell that a dead device session is the reason.
    //
    // NOTE: this is NOT the mechanism behind the filed scope-guard misfires —
    // that theory was refuted live on 2026-07-28, when the telemetry showed a
    // refusal with `mobileEditorMode: true, hasMobileSessionId: true`, i.e. the
    // mobile agent's own guard firing. Keep the two fixes separate in your head:
    // this one closes a real misroute, the prompt amendment closes the refusal.
    //
    // So force-route it instead. We still cannot conjure a device session, but
    // `mobile_agent` answers with its own NO_SESSION_REPLY ("start a device in
    // the editor"), which tells the user exactly what to do. Keep the counter,
    // the log line, and the `mobileContextMissing` tag — support still wants to
    // know the client sent no flags.
    let mobileBackstopRoute: ReturnType<typeof decideForceRoute> = null;
    if (
      !forceRouteIntent &&
      chatStore.kind === 'testcase' &&
      testCaseAccess?.platform?.startsWith('mobile_')
    ) {
      incCounter('mobile_chat.force_route', 'missing_flags');
      logger.warn('[CHAT] Mobile test-case chat without mobile context flags', {
        chatSessionId,
        userId,
        testCaseId,
        platform: testCaseAccess.platform,
      });
      mobileBackstopRoute = decideForceRoute(
        { ...(parseMobileContext(context) ?? {}), mobileEditorMode: true },
        env.MOBILE_EDITOR_FORCE_ROUTE,
      );
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) =>
        originalJson(
          body && typeof body === 'object' && !Array.isArray(body)
            ? {
                ...(body as Record<string, unknown>),
                metadata: {
                  ...((body as { metadata?: Record<string, unknown> }).metadata ?? {}),
                  mobileContextMissing: true,
                },
              }
            : body,
        );
    }

    // The backstop resolves to the same shape as the primary force-route, so
    // everything downstream (counters, logging, routing) treats them alike.
    const effectiveMobileRoute = mobileForceRoute ?? mobileBackstopRoute;

    let parsedIntent: Awaited<ReturnType<typeof parseIntent>>;
    if (effectiveMobileRoute) {
      parsedIntent = effectiveMobileRoute as Awaited<ReturnType<typeof parseIntent>>;
      // Phase B7: count force-route hits so ops can verify the path is
      // actually firing on real Mobile-Editor traffic. `applied_no_session`
      // marks the degraded case (mobile editor sent no live session id, so
      // mobile_agent will answer with NO_SESSION_REPLY).
      incCounter(
        'mobile_chat.force_route',
        effectiveMobileRoute.metadata.missingSession ? 'applied_no_session' : 'applied',
      );
      logger.info('[CHAT] mobileEditorMode force-route → mobile_agent', {
        chatSessionId,
        userId,
        // Re-parse just for the log fields. mobileSessionId may legitimately
        // be absent (missingSession case) — mobile_agent handles that with
        // NO_SESSION_REPLY.
        mobileSessionId: parseMobileContext(context)?.mobileSessionId ?? null,
        missingSession: effectiveMobileRoute.metadata.missingSession === true,
        // Distinguishes the flag-driven route from the mobile-test-case
        // backstop, so the two are separable in the logs.
        viaBackstop: !mobileForceRoute,
        messagePreview: message.slice(0, 60),
      });
      // Same abort guard the classifier path runs immediately after
      // its LLM call — preserves the existing cancellation contract.
      checkRequestAbortedWithLogging(abortSignal);
    } else if (apiFlowForceRoute) {
      parsedIntent = apiFlowForceRoute as Awaited<ReturnType<typeof parseIntent>>;
      incCounter('api_flow.force_route', 'applied');
      logger.info('[CHAT] api_flow force-route → api_flow_test', {
        chatSessionId,
        userId,
        attachmentNames: attachments?.map(a => a.name).slice(0, 5),
        messagePreview: message.slice(0, 60),
      });
      // Same abort guard the classifier path runs immediately after its LLM call.
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
        effectiveMessage,
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
    // STEP 5.2: DETERMINISTIC EDITOR SAVE
    // ═══════════════════════════════════════════════════════════════════════
    // "save" in an open test case means one thing: persist what was just
    // authored onto THIS test case. Leaving that to general_chat's model made
    // it optional — twice in one live session it answered "Saved…" having
    // called no tool at all, while the row stayed at 0 steps. The server
    // issues the write itself; the user still approves it (the write goes
    // through the same confirm gate, and their "yes" is replayed by the
    // interceptor at STEP 4.6). Falls through when there is nothing authored
    // to save — general_chat answers "save what?" better than a canned line.
    if (
      chatStore.kind === 'testcase'
      && chatSessionId
      && testCaseId
      && isEditorSaveRequest(effectiveMessage, !!parsedIntent?.metadata?.editorSaveRequested)
    ) {
      const editorSaveHandled = await handleEditorSaveRequest(
        res,
        effectiveMessage,
        chatSessionId,
        testCaseId,
        testCaseAccess?.name ?? undefined,
        {
          userId,
          workspaceId: workspace_id,
          chatSessionId,
          projectId: testCaseAccess?.projectId,
          mode: 'editor',
          storeKind: 'testcase',
          testCaseId,
        },
      );
      if (editorSaveHandled) {
        if (requestKey) await registryUnregister(requestKey, userId);
        return;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5.5: CHECK EXISTING TESTS BEFORE LITE-RUNNING (confirm-or-explore)
    // ═══════════════════════════════════════════════════════════════════════
    // When the user asks the global chat to run a test, never silently Lite-run.
    // First look for matching saved test cases; if any clear the partial floor,
    // ask the user to confirm (single → yes/no; multiple → pick one) — the next
    // turn runs the chosen one on its original platform (web/mobile) via
    // run_regression. If nothing matches, suggest the Explore section.
    // Runs even when the user gave a URL (the whole point of task #1). Global
    // chat only; test-case scope keeps its own editor flow.
    if (
      parsedIntent?.intent === 'platform_test' &&
      // The explicit "explore this site" UI/intent must still reach the
      // exploration confirmation in handlePlatformTest — don't intercept it.
      parsedIntent?.executionStrategy !== 'exploration' &&
      // A compound request ("test A and B") is an explicit multi-test run;
      // intercepting it (or each sub-step) with a confirm would stall the
      // compound queue. Let compound splitting (STEP 5.9) handle it.
      !isCompoundContinuation &&
      toCompoundSteps(parsedIntent?.metadata?.analysis).length < 2 &&
      chatStore.kind === 'global' &&
      chatSessionId
    ) {
      try {
        const { TestCaseResolverService } = await import(
          '@/services/testing/resolver/test-case-resolver.service'
        );
        const { storePendingRunExisting } = await import(
          './shared/run-existing-confirmation'
        );

        const resolverResult = await TestCaseResolverService.resolve({
          message: effectiveMessage,
          userId,
          workspaceId: workspace_id,
          // Only surface tests the user can actually run — the runner
          // (getSavedTestCase) is owner-scoped, so a workspace-mate's test
          // would dead-end on confirm. See resolver `ownerOnly`.
          ownerOnly: true,
        });

        // exact (≥0.85) and partial (≥0.50) both clear the confirm floor.
        const matched =
          resolverResult.matchType === 'exact'
            ? [resolverResult.bestMatch].filter(Boolean)
            : resolverResult.matchType === 'partial'
              ? (resolverResult.relatedCases || [])
              : [];

        if (matched.length > 0) {
          const candidates = matched
            .slice(0, 5)
            .map((c) => ({ id: c!.id, name: c!.name, platform: c!.platform || 'web' }));

          logger.info('[CHAT] Existing-test check: matches found → confirm', {
            count: candidates.length,
            matchType: resolverResult.matchType,
            names: candidates.map((c) => c.name),
          });

          const { reply, actions } = await storePendingRunExisting(chatSessionId, candidates);

          ChatService.saveChatMessages(chatSessionId, [
            { role: 'user', content: message },
            { role: 'ai', content: reply, metadata: { mode: 'run_existing_confirmation', actions } },
          ]).catch(() => {});

          res.json({
            success: true,
            reply,
            mode: 'run_existing_confirmation',
            metadata: { actions },
            timestamp: new Date().toISOString(),
            sessionId: chatSessionId,
          });
          await withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger)(chatSessionId, userId);
          return;
        }

        // No saved test matched → steer the user to exploration instead of
        // silently Lite-running. Message adapts to whether ANY tests exist.
        const hasAnyTests = await TestCaseResolverService.userHasAnyTests(userId, workspace_id);
        logger.info('[CHAT] Existing-test check: no match → suggest exploration', {
          hasAnyTests,
        });

        const exploreReply = hasAnyTests
          ? `I couldn't find a saved test matching that. To create new tests, open the **Explore** section (Execution menu) and add your URL or mobile app build — I'll discover test cases automatically.`
          : `You don't have any saved tests yet. Open the **Explore** section (Execution menu) and add your URL (web) or upload an APK/IPA/AAB (mobile) — I'll explore the app and generate test cases for you to run.`;

        // Make "Explore" a one-click deep link instead of prose the user has to
        // hunt for in the Execution menu.
        const exploreActions = [
          {
            id: 'open-explore',
            label: 'Open Explore',
            kind: 'navigate' as const,
            url: '/explorations',
            variant: 'primary' as const,
            icon: 'play',
          },
        ];

        ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          { role: 'ai', content: exploreReply, metadata: { mode: 'suggest_exploration', actions: exploreActions } },
        ]).catch(() => {});

        res.json({
          success: true,
          reply: exploreReply,
          mode: 'suggest_exploration',
          metadata: { actions: exploreActions },
          timestamp: new Date().toISOString(),
          sessionId: chatSessionId,
        });
        await withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger)(chatSessionId, userId);
        return;
      } catch (error) {
        // Graceful degradation: if the check fails, fall through to the normal
        // platform_test handler rather than blocking the user.
        logger.warn('[CHAT] Existing-test check failed, continuing with platform_test', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5.9 (Phase 3): COMPOUND BEGIN
    // ═══════════════════════════════════════════════════════════════════════
    // A freshly-classified compound request ("test A and B, then save a plan")
    // runs its FIRST step now; the rest are queued for subsequent turns. Skip
    // when we're already mid-compound (isCompoundContinuation) so a sub-step
    // that itself parses as compound can't recurse. Global chat only.
    if (chatStore.kind === 'global' && chatSessionId && !isCompoundContinuation) {
      const steps = toCompoundSteps(parsedIntent?.metadata?.analysis);
      if (steps.length >= 2) {
        const first = await beginCompound(chatSessionId, steps);
        if (first) {
          logger.info('[COMPOUND] Detected compound request, running step 1', {
            total: first.total, userId,
          });
          isCompoundContinuation = true; // step 1 is now a compound step too
          // Re-parse step 1 in isolation so it routes as its own intent.
          effectiveMessage = first.text;
          const reparse = withFunctionLogging(parseIntent, 'parseIntent', functionLogger);
          parsedIntent = await reparse(
            effectiveMessage, context, chatSessionId, userId, workspace_id,
            checkRequestTimeout, abortSignal, functionLogger,
            inputResult.mode || 'lite', false /* global scope → not test-case */, testCaseId,
          );
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 6: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
    // ═══════════════════════════════════════════════════════════════════════
    // For a compound step, capture the handler's response payload so we can tell
    // whether the step COMPLETED (advance the queue) or asked a clarification /
    // confirm-preview (leave the queue so the next turn retries this step).
    let stepResponsePayload: any;
    if (isCompoundContinuation) {
      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        stepResponsePayload = body;
        return originalJson(body);
      };
    }

    // Diagnostics: log the routing facts whenever a scope-guard refusal reaches
    // the user. That pairing is what distinguishes "the mobile agent refused"
    // from "the message never reached the mobile agent" — see
    // scope-refusal-telemetry.ts, which also covers why this does not conflict
    // with Hard invariant #13.
    installScopeRefusalTelemetry(res, () => {
      const mobileCtx = parseMobileContext(context);
      return {
        chatSessionId,
        userId,
        testCaseId,
        intent: parsedIntent.intent,
        routingSource:
          (parsedIntent as { metadata?: { routingSource?: string } }).metadata
            ?.routingSource ?? 'classifier',
        viaMobileBackstop: !!mobileBackstopRoute,
        storeKind: chatStore.kind,
        mobileEditorMode: mobileCtx?.mobileEditorMode === true,
        hasMobileSessionId: !!mobileCtx?.mobileSessionId,
        testCasePlatform: testCaseAccess?.platform ?? null,
        message: effectiveMessage,
      };
    });

    const routeToHandlerWithLogging = withFunctionLogging(routeToHandler, 'routeToHandler', functionLogger);
    // ACTIVE watchdog: race the handler against a real timer. The passive
    // checkRequestTimeout() above only fires when something calls it between
    // steps — a handler stalled inside an await (hung LLM/network) would never
    // reach a checkpoint, so the request hangs and the frontend spinner spins
    // forever. Racing guarantees we always settle: the loser's rejection drops
    // into the catch below, which sends an honest 408 + REQUEST_TIMEOUT message
    // instead of leaving the user on an infinite "Updating…". Covers EVERY
    // handler, present and future.
    let watchdog: NodeJS.Timeout | undefined;
    // A mobile-agent AUTHORING turn walks the app on a real device before it can
    // draft anything, so it is bounded by device round-trips (35-60s each on a
    // heavy Flutter screen), not by LLM latency. The conversational 3-minute
    // ceiling killed a perfectly healthy TC-33 walk mid-flight — see
    // CONSTANTS.MOBILE_AGENT_REQUEST_TIMEOUT. Every other intent keeps the short
    // budget, where a 3-minute cap is what stops a hung call spinning the UI.
    const requestTimeoutMs = parsedIntent?.intent === 'mobile_agent'
      ? CONSTANTS.MOBILE_AGENT_REQUEST_TIMEOUT
      : CONSTANTS.CHAT_REQUEST_TIMEOUT;
    const timeoutGuard = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => {
        // Signal the in-flight handler to stop work, then reject the race so the
        // catch sends an honest timeout response.
        abortController?.abort();
        reject(new Error(`Request timeout after ${requestTimeoutMs / 1000}s`));
      }, requestTimeoutMs);
      if (typeof watchdog.unref === 'function') watchdog.unref();
    });
    try {
      await Promise.race([
        routeToHandlerWithLogging(req, res, {
          message: effectiveMessage,
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
          // Controller-resolved project (test-case access check). Two consumers:
          //  - `projectId` → the mobile agent's save tool resolves the project
          //    without the chat_sessions.project_id lookup that is NULL in
          //    mobile scopes.
          //  - `testCaseProjectId` → the general handler scopes KB/file/project
          //    context + tools to the right project instead of the workspace
          //    default. See BUG-1.
          projectId: testCaseAccess?.projectId,
          testCaseProjectId: testCaseAccess?.projectId,
        }),
        timeoutGuard,
      ]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }

    // Advance the compound queue only if the step actually COMPLETED — not if it
    // asked a clarification or a confirm-preview (those need the same step to be
    // retried with the user's next reply). Best-effort; never throws.
    if (isCompoundContinuation && chatSessionId) {
      const data = stepResponsePayload?.data;
      const stepIncomplete = data?.needsClarification === true || data?.needsConfirmation === true;
      if (!stepIncomplete) {
        try {
          const next = await completeStep(chatSessionId);
          if (next) {
            emitProcessingStep(
              chatSessionId, 'generating_plan',
              `Done. Next (${next.index}/${next.total}): ${next.text}`,
              100,
            );
          }
        } catch (e) {
          logger.warn('[COMPOUND] completeStep failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

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
    // future requests for this user/session 409 forever.
    //
    // Guard on userId ONLY (not chatSessionId): on the graceful-degrade path
    // manageChatSession can return chatSessionId=undefined, yet the global
    // request was still registered under the per-user map (registerActiveRequest
    // always sets activeRequestsByUser). If we skipped cleanup when
    // chatSessionId is undefined, that per-user entry would leak and every
    // future request for this user would 409 until an explicit cancel/restart.
    // unregisterActiveRequest(undefined, userId) safely clears the user entry
    // and no-ops the session delete. See BUG-5.
    if (userId) {
      if (chatStore.kind === 'testcase' && requestKey) {
        await registryUnregister(requestKey, userId);
      } else {
        const unregisterActiveRequestWithLogging = withFunctionLogging(unregisterActiveRequest, 'unregisterActiveRequest', functionLogger);
        await unregisterActiveRequestWithLogging(chatSessionId, userId);
      }
    }

    // Abandon any pending compound on error — a mid-flow failure must not leave
    // a stuck queue that hijacks the user's next message. Same reasoning for a
    // pending editor write: the turn that would have described it to the user
    // died, so a later "yes" must not silently execute it.
    await clearPendingCompound(chatSessionId);
    await clearPendingEditorConfirmation(chatSessionId);

    // Flush logs before handling error
    await functionLogger.flushSync();

    // Watchdog timeout MUST be classified before the cancellation branch below.
    // The watchdog itself calls abortController.abort() (to stop the in-flight
    // handler), which sets signal.aborted=true — so without this early check the
    // cancellation branch would misclassify a timeout as a user-cancel (499)
    // instead of the honest 408 + REQUEST_TIMEOUT. Keyed on the timeout error
    // string the watchdog throws, not on signal.aborted.
    const isTimeoutError =
      error instanceof Error && error.message.toLowerCase().includes('timeout');
    if (isTimeoutError) {
      logger.warn('[CHAT] Request timed out (watchdog)', {
        chatSessionId,
        duration: Date.now() - requestStartTime,
      });
      if (!res.headersSent && !req.aborted && !req.socket?.destroyed) {
        res.status(408).json({
          success: false,
          error: MESSAGES.REQUEST_TIMEOUT,
          message: MESSAGES.REQUEST_TIMEOUT,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

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
