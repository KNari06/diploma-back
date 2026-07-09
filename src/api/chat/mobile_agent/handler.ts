/**
 * Mobile Agent Handler — multi-step AI assistant for the mobile editor.
 *
 * Role (parallel to web's `general_chat` in editor mode):
 *   - "create a checkout test on mobile"
 *   - "what's on the screen?"
 *   - "explore this app"
 *   - Anything that needs planning, observation, or a multi-turn tool loop.
 *
 * Phase 3: wires the mini pipeline — one tool (observe_mobile_page),
 * up to MAX_TOOL_ROUNDS LLM calls. Read-only, no mutations on the device.
 *
 * Pattern mirrors: src/api/chat/general/handler.ts (scaled down).
 */

import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { env } from '@/config/environment/env';
import {
  parseMobileContext,
  saveMobileChatTurn,
  NO_SESSION_REPLY,
} from './shared';
import { MobileBlackboard } from './blackboard';
import { runMobileAgentPipeline } from './pipeline';
import { emitMobileAgentThinking } from './progress';
import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';
import { isReasoningPersistEnabled } from './reasoning-trace';
import { resolveMobileSessionContext } from '@/services/chat/mobile-context.service';
import { incCounter, observeMs } from '@/utils/core/mobile-chat-metrics';
import { AIUsageTracker } from '@/services/ai/tracking/ai-usage-tracker';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import {
  assertMobileSessionOwnership,
  MobileSessionAuthzError,
} from '@/services/mobile/mobile-session-authz';
import { GLOBAL_STORE, type ChatStore } from '@/services/utils/chat-store';
import { wrapUntrusted } from '@/services/chat/untrusted-content-wrapper';
import { convertRoleForOpenAI } from '@/utils/helpers/chat-helpers';
import { redactPii } from '@/services/chat/pii-redactor';
import { compressHistoryTurns } from './history-compression';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * How many prior messages to load for cross-turn memory. The most recent
 * MOBILE_HISTORY_VERBATIM are kept as full turns; anything older within this
 * window is compressed into one summary block so a reference to a much earlier
 * turn ("what I asked ~20 messages ago") still lands, without blowing the token
 * budget on full verbatim history.
 */
const MOBILE_HISTORY_LIMIT = 20;
const MOBILE_HISTORY_VERBATIM = 8;
/** Cap per compressed line so one long older turn can't dominate the summary. */
const MOBILE_HISTORY_PREVIEW_CHARS = 160;

/**
 * Load recent conversation turns for the agent so it can resolve references to
 * earlier turns ("now do the same on signup", "no, the other one", or a much
 * older ask). Returns oldest→newest, role-mapped for OpenAI, PII/secret-
 * redacted. The recent tail is verbatim; older turns are compressed into a
 * single system "earlier conversation" block (deterministic truncation — no
 * extra LLM call, mirrors the web editor-mode compression). Best-effort — any
 * failure returns [] and the turn proceeds stateless.
 *
 * The current user message is NOT yet persisted at this point (saveMobileChatTurn
 * runs AFTER the pipeline), so history contains only PRIOR turns — no dupe of
 * the current goal.
 */
async function buildMobileHistory(
  chatSessionId: string | undefined,
  userId: string,
  store: ChatStore,
): Promise<ChatCompletionMessageParam[]> {
  if (!chatSessionId) return [];
  try {
    // Lazy import: ChatPersistence pulls the Supabase client into the module
    // graph, which throws at import time without env vars (breaks handler.test).
    // Same pattern as buildOpenTestCaseBlock / resolveProjectId.
    const { ChatPersistence } = await import('@/services/utils/chat-persistence');
    const rows = await ChatPersistence.getRecentMessages(
      store,
      chatSessionId,
      userId,
      MOBILE_HISTORY_LIMIT,
    );
    // Redact BEFORE compression so both the verbatim tail AND the summary are
    // secret-free (invariant #10 — a new sink for step bodies).
    const turns = (rows ?? [])
      .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({
        role: convertRoleForOpenAI(m.role) as 'user' | 'assistant',
        content: redactPii(m.content),
      }));

    // Keep the recent tail verbatim; condense older turns into one summary
    // block (pure + unit-tested in history-compression.ts).
    return compressHistoryTurns(turns, {
      verbatimCount: MOBILE_HISTORY_VERBATIM,
      previewChars: MOBILE_HISTORY_PREVIEW_CHARS,
    });
  } catch (err) {
    logger.debug('[MOBILE_AGENT] buildMobileHistory skipped', {
      chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Build the OPEN TEST CASE system block from a saved test case's existing
 * steps so the agent extends the flow rather than duplicating it. Owner-scoped
 * read; best-effort — any failure (not found / no access / no steps) returns
 * null and the turn proceeds without the block. Caps the summary so a long
 * test doesn't blow the prompt budget.
 */
async function buildOpenTestCaseBlock(
  testCaseId: string | undefined,
  userId: string,
): Promise<string | null> {
  if (!testCaseId) return null;
  try {
    // Lazy import: pulling IntentTestCaseService at module top drags the
    // Supabase client into the graph, which throws at import time without env
    // vars (breaks handler.test.ts). Dynamic import keeps the handler test-
    // loadable — same pattern resolveProjectId uses for supabaseAdmin.
    const { IntentTestCaseService } = await import(
      '@/services/testing/ui/preview/intent-test-case.service'
    );
    const tc = await IntentTestCaseService.getById(testCaseId, userId);
    const steps = Array.isArray(tc?.stepsJson) ? tc!.stepsJson : [];
    if (!tc || steps.length === 0) return null;
    const MAX_STEPS = 40;
    const shown = steps.slice(0, MAX_STEPS);
    const lines = shown.map((s: any, i: number) => {
      const type = String(s?.type ?? 'step');
      const desc = String(s?.description ?? '').slice(0, 120);
      return `${i + 1}. ${type}${desc ? ` — ${desc}` : ''}`;
    });
    if (steps.length > MAX_STEPS) lines.push(`… (+${steps.length - MAX_STEPS} more)`);
    const body =
      `Test case "${tc.name ?? testCaseId}" already has ${steps.length} step(s):\n` +
      lines.join('\n');
    return (
      '## OPEN TEST CASE (the editor is scoped to this saved test)\n' +
      'These steps ALREADY exist. When the user asks to add/change steps, EXTEND ' +
      'this flow — do not re-author steps it already has.\n' +
      wrapUntrusted(body)
    );
  } catch (err) {
    logger.debug('[MOBILE_AGENT] buildOpenTestCaseBlock skipped', {
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

interface MobileAgentParams {
  message: string;
  parsedIntent?: any;
  userId: string;
  workspace_id: string;
  chatSessionId?: string;
  conversationId?: string;
  context?: any;
  abortSignal?: AbortSignal;
  mode?: 'lite' | 'pro' | 'editor';
  /**
   * Persistence backend for this turn. TESTCASE_STORE when the mobile
   * editor is scoped to a saved test case, GLOBAL_STORE otherwise. Threaded
   * to `saveMobileChatTurn` so test-case turns don't leak into the global
   * chat tables (parallel to web editor_action). Defaults to GLOBAL_STORE.
   */
  chatStore?: ChatStore;
  /**
   * Project the chat is scoped to, resolved by the controller (test-case
   * access check or workspace context). Threaded onto the blackboard so the
   * save tool doesn't dead-end on the chat_sessions.project_id lookup (NULL in
   * both mobile scopes). See resolveProjectId in tools.ts.
   */
  projectId?: string;
  /** Saved test case the mobile editor is scoped to, when opened on one. */
  testCaseId?: string;
}

export async function handleMobileAgent(
  _req: Request,
  res: Response,
  params: MobileAgentParams,
): Promise<void> {
  const { message, userId, chatSessionId, context, abortSignal } = params;
  const workspaceId = params.workspace_id;
  const chatStore: ChatStore = params.chatStore ?? GLOBAL_STORE;
  const startedAt = Date.now();

  const ctxObj = parseMobileContext(context);
  const mobileSessionId = ctxObj?.mobileSessionId;

  if (!mobileSessionId) {
    logger.warn('[MOBILE_AGENT] No mobileSessionId in context', { userId });
    await saveMobileChatTurn(
      chatSessionId,
      message,
      NO_SESSION_REPLY,
      { noSession: true },
      'mobile_agent',
      chatStore,
    );
    res.json({
      success: false,
      reply: NO_SESSION_REPLY,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return;
  }

  // HIGH-1 fix: verify the client-supplied `mobileSessionId` actually
  // belongs to this authenticated user BEFORE we touch the runner. The
  // chat surface only validates the *shape* of the string in
  // `decideForceRoute`; an attacker who knows another user's sessionId
  // could otherwise observe/tap/type into a foreign session.
  //
  // Done BEFORE constructing the blackboard / running eager-fetch so a
  // forged sessionId never reaches `fetchUiState`. A 403 here is the
  // correct semantic — the request was authenticated but not authorised
  // for THIS resource. We log + count the rejection for ops visibility.
  try {
    await assertMobileSessionOwnership(userId, mobileSessionId);
  } catch (authzErr) {
    if (authzErr instanceof MobileSessionAuthzError) {
      incCounter('mobile_chat.authz_rejection', authzErr.reason);
      logger.warn('[MOBILE_AGENT] Rejected unauthorised mobileSessionId', {
        userId,
        mobileSessionId,
        reason: authzErr.reason,
      });
      // Don't persist the foreign sessionId into chat history — pass
      // the bare fallback reply through saveMobileChatTurn the same way
      // a "no session" turn does.
      await saveMobileChatTurn(
        chatSessionId,
        message,
        NO_SESSION_REPLY,
        { noSession: true, authzRejected: true },
        'mobile_agent',
        chatStore,
      );
      res.status(403).json({
        success: false,
        reply: NO_SESSION_REPLY,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }
    throw authzErr;
  }

  const blackboard = new MobileBlackboard({
    goal: message,
    mobileSessionId,
    userId,
    chatSessionId,
    // Prefer the controller-resolved projectId; fall back to the one the
    // frontend put in context. Either makes the save tool resolve without the
    // dead-ending chat_sessions lookup.
    projectId: params.projectId ?? (typeof ctxObj?.projectId === 'string' ? ctxObj.projectId : undefined),
    testCaseId: params.testCaseId,
  });

  try {
    // Phase B2-B4: eagerly fetch a snapshot of the device state BEFORE
    // the first LLM call. Mirrors web's `getPageContext` in
    // `general/handler.ts:152` — the LLM gets the device-fresh foreground
    // + a11y tree pushed into its system prompt instead of having to
    // call `observe_mobile_page` and roundtrip back to the runner.
    //
    // The fetch lives INSIDE the outer try so an AbortError (user closed
    // the tab during the 1-6s fetch window) flows into the same fallback-
    // reply path as a pipeline failure — we don't want a half-aborted
    // request to throw out of the handler.
    //
    // `resolveMobileSessionContext` swallows runtime errors (404 / 403 /
    // 503 / timeout) into `null` and the pipeline falls back to PULL
    // mode. Only AbortError / signal.aborted re-throws, which is caught
    // here and turned into the standard fallback message.
    let snapshot = null;
    if (env.MOBILE_CHAT_EAGER_SNAPSHOT) {
      // Emit "observing screen" BEFORE the fetch so the frontend
      // ChatProcessingIndicator pulses immediately — without this the
      // user sees a silent 1-6s gap before the first LLM token arrives.
      // The phase name 'observing_screen' is intentionally distinct from
      // the pipeline's 'agent_thinking' so the frontend (or future
      // operator dashboards) can attribute latency between the pre-fetch
      // and the LLM call.
      emitMobileAgentThinking(
        chatSessionId,
        'Observing the screen…',
        40,
        { sessionId: mobileSessionId, kind: 'observing_screen' },
      );
      // Phase B7: measure the eager-snapshot cost end-to-end. The
      // resolver's own timeout (6s default) caps this — observed values
      // outside that range mean either the timer cap moved or the
      // measurement is wrong.
      const fetchStartedAt = Date.now();
      snapshot = await resolveMobileSessionContext(mobileSessionId, userId, {
        signal: abortSignal,
      });
      observeMs('mobile_chat.eager_snapshot_ms', Date.now() - fetchStartedAt);
      if (snapshot) {
        incCounter('mobile_chat.eager_snapshot', 'success');
        // Seed the snapshot onto the blackboard so tools that read
        // bb.getSnapshot() (mobile_run_draft_steps platform/app stamping,
        // plan_flow currentScreen, list_webview_contexts, screen-size lookup)
        // see the eagerly-fetched data instead of null. Without this the LLM
        // could author a draft in round 1 (before any observe_mobile_page) and
        // the saved test would be mis-stamped platform:android with no app
        // package, and plan_flow would plan blind. MobileSnapshot is a
        // MobileUiState minus tree/screenshot with expectedApp aliasing app —
        // map it back to the getSnapshot() contract.
        blackboard.setSnapshot({
          sessionId: snapshot.sessionId,
          platform: snapshot.platform,
          app: snapshot.expectedApp,
          expectedApp: snapshot.expectedApp,
          activity: snapshot.activity,
          fingerprint: snapshot.fingerprint,
          screenSize: snapshot.screenSize,
          windowInfo: snapshot.windowInfo,
          formattedTree: snapshot.formattedTree,
          actualForeground: snapshot.actualForeground,
          foregroundMismatch: snapshot.foregroundMismatch,
          recentDisruption: snapshot.recentDisruption,
          webView: snapshot.webView,
          capturedAt: snapshot.capturedAt,
        });
        // foregroundMismatch is the load-bearing reason this whole
        // phase exists — count it as a top-level metric. recentDisruption
        // travels with it for the same dashboard.
        if (snapshot.foregroundMismatch) {
          incCounter('mobile_chat.foreground_mismatch', 'detected');
        }
        if (snapshot.recentDisruption) {
          incCounter('mobile_chat.recent_disruption', snapshot.recentDisruption.type);
        }
        logger.debug('[MOBILE_AGENT] Eager snapshot injected', {
          userId,
          mobileSessionId,
          foregroundMismatch: !!snapshot.foregroundMismatch,
          recentDisruption: !!snapshot.recentDisruption,
        });
      } else {
        // Null means resolveMobileSessionContext fell through (runner
        // 404/403/503/timeout, or it returned null on no-session). We
        // can't distinguish the cause here — the resolver already
        // logged the specifics; this just counts the failure rate.
        incCounter('mobile_chat.eager_snapshot', 'failed');
      }
    } else {
      incCounter('mobile_chat.eager_snapshot', 'disabled');
    }

    // AI-usage tracking — parity with general_chat. mobile_agent is a real
    // multi-step agent, so its decisions (tool calls, duration) must leave a
    // trace in ai_usage_log for post-hoc analysis, not only Winston files.
    // Best-effort: tracking must never break the agent turn.
    const trackingSessionId = workspaceId && chatSessionId ? chatSessionId : null;
    if (trackingSessionId && workspaceId) {
      AIUsageTracker.beginSession(trackingSessionId, {
        workspaceId,
        userId,
        operationType: 'chat',
      });
    }

    // When the editor is scoped to a saved test case, summarise its existing
    // steps so the agent EXTENDS the flow instead of re-authoring it (the
    // duplicate-vs-extend gap). Best-effort + owner-scoped; never blocks the
    // turn on a read failure.
    const openTestCaseBlock = await buildOpenTestCaseBlock(params.testCaseId, userId);

    // Prior turns for cross-turn memory (best-effort). Read BEFORE this turn is
    // saved, so it contains only earlier turns — no dupe of the current goal.
    const history = await buildMobileHistory(chatSessionId, userId, chatStore);

    const pipelineOpts = { abortSignal, snapshot, openTestCaseBlock, history };
    const result = trackingSessionId && workspaceId
      ? await withAIContext(
          { workspaceId, userId, operationType: 'chat' },
          () => runMobileAgentPipeline(blackboard, pipelineOpts),
        )
      : await runMobileAgentPipeline(blackboard, pipelineOpts);

    if (trackingSessionId) {
      AIUsageTracker.recordPipelineMetrics(trackingSessionId, {
        path: 'mobile_agent',
        success: true,
        toolCallsMade: result.toolCallsMade,
        observed: result.observed,
        durationMs: result.durationMs,
      });
      const usageStats = await AIUsageTracker.endSession(trackingSessionId);
      if (usageStats) {
        logger.info('[MOBILE_AGENT] AI usage stats', { chatSessionId: trackingSessionId, workspaceId, ...usageStats });
      }
    }

    logger.info('[MOBILE_AGENT] Pipeline finished', {
      userId,
      ...blackboard.summary(),
      toolCallsMade: result.toolCallsMade,
      observed: result.observed,
      durationMs: result.durationMs,
    });

    // Phase 7+: include the sanitised reasoning trace in chat metadata
    // when persistence is enabled (default). Frontend can later surface
    // this as a collapsible "Why did the agent do this?" panel without
    // any backend change. Trace entries are already sanitised + truncated
    // by the think_aloud executor; the array is already bounded by
    // MobileBlackboard.appendReasoning. No further filtering here.
    const reasoningTrace = isReasoningPersistEnabled()
      ? blackboard.getReasoningTrace()
      : [];

    // Phase C: surface the eager-snapshot's high-signal verdicts as
    // chat metadata. The LLM already mentioned them in `result.reply`
    // (the system prompt told it to), but the frontend can render an
    // explicit chip on top — much faster to scan than reading a
    // paragraph for "by the way, you might be in the wrong app".
    //
    // Both fields are optional: pre-snapshot turns (eager-inject off,
    // or runner unreachable) just don't include them. Frontend already
    // ignores unknown metadata gracefully.
    const visualMetadata: Record<string, unknown> = {};
    if (snapshot?.foregroundMismatch) {
      visualMetadata.foregroundMismatch = snapshot.foregroundMismatch;
    }
    if (snapshot?.recentDisruption) {
      visualMetadata.recentDisruption = {
        type: snapshot.recentDisruption.type,
        packageName: snapshot.recentDisruption.packageName,
        capturedAt: snapshot.recentDisruption.capturedAt,
        // Drop the snippet from the visible metadata — it's only useful
        // inside the LLM prompt. Surfacing the raw stack trace in the
        // chat panel adds noise without help.
      };
    }

    // Draft steps authored this turn (mobile_run_draft_steps) → the chat
    // renders them as editable step widgets. `draftMeta.executed` tells the
    // UI whether they already ran (confirm=true) or await a UI-confirm run
    // (confirm=false). Values are already sanitised to {{param_*}} by the tool.
    if (result.draftSteps && result.draftMeta) {
      visualMetadata.draftSteps = result.draftSteps;
      visualMetadata.draftMeta = result.draftMeta;
    }

    await saveMobileChatTurn(
      chatSessionId,
      message,
      result.reply,
      {
        mobileSessionId,
        toolCallsMade: result.toolCallsMade,
        observed: result.observed,
        durationMs: result.durationMs,
        ...visualMetadata,
        ...(reasoningTrace.length > 0 ? { reasoningTrace } : {}),
      },
      'mobile_agent',
      chatStore,
    );

    res.json({
      success: true,
      reply: result.reply,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
      // Mirror visualMetadata into the HTTP response so the frontend
      // doesn't have to re-fetch the chat history just to render the
      // chip on the just-arrived message.
      ...(Object.keys(visualMetadata).length > 0 ? { metadata: visualMetadata } : {}),
    });
  } catch (err) {
    const duration = Date.now() - startedAt;
    const message404 =
      err instanceof MobileRunnerError && err.statusCode === 404
        ? '📱 The mobile session is no longer active. Start a fresh device and try again.'
        : null;
    const message503 =
      err instanceof MobileRunnerError && err.statusCode === 503
        ? '📱 Mobile testing is not enabled on this deployment yet.'
        : null;
    const fallbackMessage =
      message404 ??
      message503 ??
      '⚠️ Something went wrong while reading the mobile screen. Please try again.';

    logger.error('[MOBILE_AGENT] Pipeline failed', {
      userId,
      mobileSessionId,
      error: err instanceof Error ? err.message : String(err),
      durationMs: duration,
    });

    // Persist whatever reasoning we accumulated before the failure —
    // helps the user (and us) understand WHY the agent failed mid-flow.
    const reasoningTrace = isReasoningPersistEnabled()
      ? blackboard.getReasoningTrace()
      : [];

    await saveMobileChatTurn(
      chatSessionId,
      params.message,
      fallbackMessage,
      {
        mobileSessionId,
        error: err instanceof Error ? err.message : String(err),
        ...(reasoningTrace.length > 0 ? { reasoningTrace } : {}),
      },
      'mobile_agent',
      chatStore,
    );

    // Pipeline failures are user-visible text, not 5xx — the chat already
    // handled it gracefully. Keep HTTP 200 so the frontend doesn't treat
    // this as a transport error and hide the message.
    if (!res.headersSent) {
      res.json({
        success: false,
        reply: fallbackMessage,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
    }
  }
}
