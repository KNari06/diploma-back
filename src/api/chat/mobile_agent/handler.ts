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
import {
  assertMobileSessionOwnership,
  MobileSessionAuthzError,
} from '@/services/mobile/mobile-session-authz';
import { GLOBAL_STORE, type ChatStore } from '@/services/utils/chat-store';

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
}

export async function handleMobileAgent(
  _req: Request,
  res: Response,
  params: MobileAgentParams,
): Promise<void> {
  const { message, userId, chatSessionId, context, abortSignal } = params;
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

    const result = await runMobileAgentPipeline(blackboard, {
      abortSignal,
      snapshot,
    });

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
