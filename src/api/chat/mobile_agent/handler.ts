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
import {
  parseMobileContext,
  saveMobileChatTurn,
  NO_SESSION_REPLY,
} from './shared';
import { MobileBlackboard } from './blackboard';
import { runMobileAgentPipeline } from './pipeline';
import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';
import { isReasoningPersistEnabled } from './reasoning-trace';

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
}

export async function handleMobileAgent(
  _req: Request,
  res: Response,
  params: MobileAgentParams,
): Promise<void> {
  const { message, userId, chatSessionId, context, abortSignal } = params;
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
    );
    res.json({
      success: false,
      reply: NO_SESSION_REPLY,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return;
  }

  const blackboard = new MobileBlackboard({
    goal: message,
    mobileSessionId,
    userId,
    chatSessionId,
  });

  try {
    const result = await runMobileAgentPipeline(blackboard, { abortSignal });

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

    await saveMobileChatTurn(
      chatSessionId,
      message,
      result.reply,
      {
        mobileSessionId,
        toolCallsMade: result.toolCallsMade,
        observed: result.observed,
        durationMs: result.durationMs,
        ...(reasoningTrace.length > 0 ? { reasoningTrace } : {}),
      },
      'mobile_agent',
    );

    res.json({
      success: true,
      reply: result.reply,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
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
