/**
 * Mobile Action Handler — single-step direct action on a live mobile device.
 *
 * Role (parallel to web's `editor_action`):
 *   - "tap the login button"
 *   - "swipe up"
 *   - "type 'hello' in the search field"
 *   - "scroll down"
 *   - "press back"
 *
 * The user expects a fast (~1-2s) round-trip: one LLM call picks a tool,
 * we execute it, we reply. No multi-turn loop, no planning, no authoring.
 *
 * Phase 4 wiring:
 *   1. Parse context, reject if no mobileSessionId.
 *   2. Snapshot the screen so the LLM can see what\u2019s there (the action
 *      tools themselves don\u2019t include observation — they expect the
 *      caller has context).
 *   3. One LLM call with `tool_choice: 'required'` — the model MUST call
 *      exactly one action tool; we don\u2019t want it chatting back instead.
 *   4. Dispatch the chosen tool.
 *   5. Surface a short success/failure message.
 *
 * For anything more complex — multi-step flows, authoring, screen
 * questions — the intent classifier routes to `mobile_agent` instead.
 */

import { Request, Response } from 'express';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';
import {
  parseMobileContext,
  saveMobileChatTurn,
  NO_SESSION_REPLY,
} from '../mobile_agent/shared';
import { MobileBlackboard } from '../mobile_agent/blackboard';
import { MOBILE_ACTION_TOOLS, executeTool } from '../mobile_agent/tools';
import {
  emitMobileAgentThinking,
  emitMobileToolStep,
} from '../mobile_agent/progress';
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';

interface MobileActionParams {
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

const SYSTEM_PROMPT = [
  'You are QAIT\u2019s mobile fast-path action selector.',
  'The user wants ONE atomic action on the mobile device. Pick the right tool and',
  'call it exactly once. Do not ask questions. Do not call multiple tools —',
  'the pipeline will only execute the first tool call you return.',
  '',
  'The current screen is INCLUDED BELOW when observation succeeded. If it says',
  '"(screen capture unavailable)" the device state is unknown — still pick the',
  'best-guess tool call based on the user\u2019s words alone; the runner will fail',
  'the call gracefully if the target doesn\u2019t exist.',
  '',
  'Rules:',
  '- Call exactly ONE of: tap_element, type_text, swipe, scroll, press_key.',
  '- Describe targets by visible text / resId / accessibility-id, never coordinates.',
  '- For passwords / OTPs / tokens, set isSensitive=true on type_text.',
  '- If the user\u2019s request would need multiple actions (e.g. "log in"), still pick',
  '  the FIRST reasonable single action; the caller will follow up.',
  '- If you truly cannot decide, still call the most plausible tool — never reply',
  '  with plain text from this handler.',
].join('\n');

export async function handleMobileAction(
  _req: Request,
  res: Response,
  params: MobileActionParams,
): Promise<void> {
  const { message, userId, chatSessionId, context, abortSignal } = params;
  const startedAt = Date.now();

  const ctxObj = parseMobileContext(context);
  const mobileSessionId = ctxObj?.mobileSessionId;

  if (!mobileSessionId) {
    logger.warn('[MOBILE_ACTION] No mobileSessionId in context', { userId });
    await saveMobileChatTurn(
      chatSessionId,
      message,
      NO_SESSION_REPLY,
      { noSession: true },
      'mobile_action',
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

  // Phase 7: pulse the chat indicator at turn-start. Same WS contract
  // (`chat:processing:step`) the web sub-agent uses, so the frontend
  // renders mobile fast-path progress without any client-side change.
  emitMobileAgentThinking(
    chatSessionId,
    'Reading the screen…',
    60,
    { sessionId: mobileSessionId, kind: 'mobile_action_observe' },
  );

  // ── Step 1: snapshot the screen so the LLM has context ─────────────
  let snapshotHeader = '';
  try {
    const snap = await getMobileRunnerClient().fetchUiState(mobileSessionId, {
      includeTree: false,
      includeScreenshot: false, // fast-path skips the screenshot — text tree is enough
      signal: abortSignal,
      userId,
    });
    blackboard.setSnapshot(snap);
    snapshotHeader = formatSnapshotForPrompt(snap);
  } catch (err) {
    // Failure modes:
    //   - 404 session not found       → kind user message, stop.
    //   - 0 / 5xx / NETWORK_ERROR     → runner unreachable. Don't burn an
    //                                    LLM call only to have the action
    //                                    tool fail against the same runner
    //                                    a second later. Fail fast.
    //   - 409 screen unreadable       → proceed blind; the LLM may still
    //                                    pick a reasonable target from the
    //                                    user's words alone.
    //   - other                       → same as 409.
    if (err instanceof MobileRunnerError && err.statusCode === 404) {
      // Match the started "Reading the screen…" indicator with a final
      // pulse-stop event — otherwise the chat indicator hangs at 60%
      // until the user's next message dismisses it.
      emitMobileAgentThinking(
        chatSessionId,
        'Mobile session is no longer active.',
        60,
        { sessionId: mobileSessionId, kind: 'mobile_action_failed', reason: 'session_gone' },
      );
      const reply =
        '📱 The mobile session is no longer active. Start a fresh device and try again.';
      await saveMobileChatTurn(chatSessionId, message, reply, { sessionGone: true }, 'mobile_action');
      res.json({
        success: false,
        reply,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }
    if (err instanceof MobileRunnerError && (err.statusCode === 0 || (err.statusCode ?? 0) >= 500)) {
      emitMobileAgentThinking(
        chatSessionId,
        'Mobile runner unreachable.',
        60,
        { sessionId: mobileSessionId, kind: 'mobile_action_failed', reason: 'runner_unreachable' },
      );
      const reply =
        '⚠️ The mobile runner is unreachable right now. Please try again in a moment.';
      await saveMobileChatTurn(
        chatSessionId,
        message,
        reply,
        { runnerUnreachable: true, error: err.message },
        'mobile_action',
      );
      res.json({
        success: false,
        reply,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }
    logger.warn('[MOBILE_ACTION] Observation failed, proceeding blind', {
      error: err instanceof Error ? err.message : String(err),
    });
    snapshotHeader = '(screen capture unavailable — proceed with the user request alone)';
  }

  // ── Step 2: single LLM call picks a tool ───────────────────────────
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Current screen:\n${snapshotHeader}\n\nUser request: ${message}`,
    },
  ];

  let toolCalls: ChatCompletionMessageToolCall[] = [];
  try {
    const response = await getChatCompletionWithMessages(messages, {
      model: chooseToolCapableModel(),
      temperature: 0.1,
      tools: MOBILE_ACTION_TOOLS,
      tool_choice: 'required',
      abortSignal,
    });
    toolCalls = (response.tool_calls ?? []) as ChatCompletionMessageToolCall[];
  } catch (err) {
    await respondError(
      res,
      chatSessionId,
      message,
      mobileSessionId,
      err,
      'mobile_action',
    );
    return;
  }

  if (toolCalls.length === 0) {
    const reply =
      '⚠️ I could not pick an action for that. Try being more specific — e.g. "tap login button", "type hello in the search field", "scroll down".';
    await saveMobileChatTurn(
      chatSessionId,
      message,
      reply,
      { noToolCalls: true },
      'mobile_action',
    );
    res.json({
      success: true,
      reply,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return;
  }

  // ── Step 3: execute the first tool. Fast-path ignores additional ones. ─
  // OpenAI `tool_choice: 'required'` guarantees ≥1 tool call but does NOT
  // cap at 1. If the model over-eagerly emits more (e.g. [tap, swipe]),
  // log the dropped ones for observability and proceed with the first —
  // this is a fast-path by design, extras belong in mobile_agent.
  if (toolCalls.length > 1) {
    logger.warn('[MOBILE_ACTION] Multiple tool calls returned; executing first only', {
      userId,
      mobileSessionId,
      picked: toolCalls[0]?.function.name,
      dropped: toolCalls.slice(1).map((c) => c.function.name),
    });
  }
  const tc = toolCalls[0]!;

  // Stream the tool dispatch so the user sees what's actually happening.
  // Fast-path is one round, so we hard-code 80% (between observe @ 60%
  // and the final HTTP reply); start vs finish frame the action.
  emitMobileToolStep(chatSessionId, tc.function.name, 'started', 80, {
    sessionId: mobileSessionId,
    fastPath: true,
  });
  const toolStartedAt = Date.now();
  const toolResult = await executeTool(
    tc.function.name,
    tc.function.arguments,
    blackboard,
    { abortSignal },
  );
  emitMobileToolStep(
    chatSessionId,
    tc.function.name,
    toolResult.ok ? 'finished' : 'failed',
    90,
    {
      sessionId: mobileSessionId,
      fastPath: true,
      durationMs: Date.now() - toolStartedAt,
      preview: toolResult.content.slice(0, 120),
    },
  );

  const replyPrefix = toolResult.ok ? '✅' : '⚠️';
  const reply = `${replyPrefix} ${toolResult.content}`;

  logger.info('[MOBILE_ACTION] Fast-path completed', {
    userId,
    mobileSessionId,
    tool: tc.function.name,
    ok: toolResult.ok,
    durationMs: Date.now() - startedAt,
  });

  await saveMobileChatTurn(
    chatSessionId,
    message,
    reply,
    {
      mobileSessionId,
      tool: tc.function.name,
      ok: toolResult.ok,
      durationMs: Date.now() - startedAt,
    },
    'mobile_action',
  );

  res.json({
    success: toolResult.ok,
    reply,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function chooseToolCapableModel(): string {
  const configured = AI_MODELS.fast;
  if (configured.startsWith('gemini-')) {
    logger.warn(
      '[MOBILE_ACTION] Configured fast model is Gemini; function calling unsupported ' +
        'through the shared wrapper. Falling back to gpt-4.1-mini.',
      { configured },
    );
    return 'gpt-4.1-mini';
  }
  return configured;
}

function formatSnapshotForPrompt(
  snap: import('@/services/mobile/mobile-runner.types').MobileUiState,
): string {
  const header = [
    `platform: ${snap.platform}`,
    snap.app ? `app: ${snap.app}` : null,
    snap.activity ? `activity: ${snap.activity}` : null,
    `screen: ${snap.screenSize.width}x${snap.screenSize.height}`,
    snap.windowInfo?.keyboardVisible ? 'keyboard: visible' : null,
    snap.windowInfo?.hasDialog ? 'dialog: visible' : null,
  ]
    .filter(Boolean)
    .join('\n');
  return `${header}\n${snap.formattedTree}`;
}

async function respondError(
  res: Response,
  chatSessionId: string | undefined,
  userMessage: string,
  mobileSessionId: string,
  err: unknown,
  intentTag: 'mobile_action' | 'mobile_agent',
): Promise<void> {
  const fallback =
    err instanceof MobileRunnerError && err.statusCode === 503
      ? '📱 Mobile testing is not enabled on this deployment.'
      : '⚠️ Something went wrong while picking an action. Please try again.';

  logger.error('[MOBILE_ACTION] Handler error', {
    mobileSessionId,
    error: err instanceof Error ? err.message : String(err),
  });

  // Stop the chat indicator from pulsing on early-return error paths
  // (LLM call failed, no tool ever dispatched). Without this, the UI
  // shows "Reading the screen…" frozen until the next message.
  emitMobileAgentThinking(
    chatSessionId,
    'Something went wrong.',
    70,
    { sessionId: mobileSessionId, kind: 'mobile_action_failed' },
  );

  await saveMobileChatTurn(
    chatSessionId,
    userMessage,
    fallback,
    {
      mobileSessionId,
      error: err instanceof Error ? err.message : String(err),
    },
    intentTag,
  );

  if (!res.headersSent) {
    res.json({
      success: false,
      reply: fallback,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  }
}
