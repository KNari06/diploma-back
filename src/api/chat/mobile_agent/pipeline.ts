/**
 * Mobile-agent mini pipeline (Phase 3).
 *
 * Shape:
 *   1. Build messages: [system, user].
 *   2. LLM call with tools = [observe_mobile_page], tool_choice = 'auto'.
 *   3. If the LLM returned a tool_call:
 *        - Dispatch the tool → get ToolResult.
 *        - Append assistant + tool messages.
 *        - LLM call again WITHOUT tools → produce the final text reply.
 *   4. If the LLM returned text directly, that's the final reply.
 *   5. Hard cap of MAX_TOOL_ROUNDS to stop any runaway loops (even though
 *      phase 3 only has a read tool, defensive is cheap).
 *
 * Not in phase 3: planner sub-agent, reviewer, responder, parallel tools,
 * streaming. Those come with the action-tool phase.
 */

import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { MobileBlackboard } from './blackboard';
import { buildMobileAgentSystemPrompt } from './prompts';
import { MOBILE_AGENT_TOOLS, executeTool } from './tools';
import {
  emitMobileAgentThinking,
  emitMobileToolStep,
  mobileToolProgress,
} from './progress';

// Upper bound on "LLM → tool dispatch" rounds in a single turn.
//
// Phase 5 budget (planner + multi-step):
//   plan_flow (1) +
//   per-step: start_plan_step (1) + observe (1) + action (1) + observe (1)
//           + finish_plan_step (1) = 5 rounds per step
// A 5-step login flow → 1 + 5*5 = 26 rounds. Budget 30 to leave room for
// one retry on a failed step.
//
// If the LLM keeps calling tools past this cap, the pipeline forces a
// final text reply without tools so the user gets SOMETHING instead of a
// silent hang. Cap is defensive; healthy flows finish well under it.
const MAX_TOOL_ROUNDS = 30;

/**
 * The OpenAI wrapper (`getChatCompletionWithMessages`) auto-routes any
 * model starting with "gemini-" into the Gemini SDK, and that SDK path
 * does NOT forward the `tools` parameter. If an operator sets
 * OPENAI_MODEL_FAST=gemini-2.5-flash, the pipeline would silently stop
 * calling tools — the LLM never sees observe_mobile_page.
 *
 * Gate the model choice here: if AI_MODELS.fast is a Gemini model, fall
 * back to a known OpenAI model that supports function calling. Phase 4+
 * can revisit this when we wire a proper multi-provider tool abstraction.
 */
function chooseToolCapableModel(): string {
  const configured = AI_MODELS.fast;
  if (configured.startsWith('gemini-')) {
    logger.warn(
      '[MOBILE_AGENT_PIPELINE] Configured fast model is Gemini; function calling ' +
        'is unsupported through the shared wrapper. Falling back to gpt-4.1-mini.',
      { configured },
    );
    return 'gpt-4.1-mini';
  }
  return configured;
}

export interface MobileAgentResult {
  reply: string;
  toolCallsMade: number;
  observed: boolean;
  durationMs: number;
}

export async function runMobileAgentPipeline(
  blackboard: MobileBlackboard,
  opts?: { abortSignal?: AbortSignal },
): Promise<MobileAgentResult> {
  const startedAt = Date.now();

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildMobileAgentSystemPrompt() },
    { role: 'user', content: blackboard.goal },
  ];

  // Phase 7: stream coarse "agent is thinking" signal at turn start so the
  // frontend ChatProcessingIndicator pulses immediately. Emit fires WS
  // event on the existing `chat:processing:step` channel — same one web
  // already drives, so no frontend changes needed.
  emitMobileAgentThinking(
    blackboard.chatSessionId,
    'Reading your request…',
    55,
    { sessionId: blackboard.mobileSessionId, kind: 'turn_start' },
  );

  let round = 0;
  let toolCallsMade = 0;

  while (round < MAX_TOOL_ROUNDS) {
    round++;

    const response = await getChatCompletionWithMessages(messages, {
      model: chooseToolCapableModel(),
      temperature: 0.2,
      tools: MOBILE_AGENT_TOOLS,
      tool_choice: 'auto',
      abortSignal: opts?.abortSignal,
    });

    const toolCalls = (response.tool_calls ?? []) as ChatCompletionMessageToolCall[];

    // No tool calls → the reply is the final answer. We're done.
    //
    // Defensive: OpenAI can legitimately return `content: null` when the
    // model chose not to speak (even with no tool_calls it occasionally
    // happens on schema violations). `.trim()` on null throws, which
    // crashes the whole turn — coalesce to empty string first.
    if (toolCalls.length === 0) {
      const reply = (response.content ?? '').trim();
      if (!reply) {
        logger.warn('[MOBILE_AGENT_PIPELINE] Empty reply, no tool calls', {
          sessionId: blackboard.mobileSessionId,
          round,
        });
      }
      // Final "wrapping up" pulse so the UI shows the indicator approaching
      // 95% before the HTTP response lands. The WebSocket event arrives a
      // few ms before res.json — frontend hides the indicator the moment
      // the chat reply renders.
      emitMobileAgentThinking(
        blackboard.chatSessionId,
        'Composing reply…',
        95,
        { sessionId: blackboard.mobileSessionId, toolCallsMade, round },
      );
      return {
        reply: reply || fallbackEmptyReply(),
        toolCallsMade,
        observed: blackboard.getSnapshot() !== null,
        durationMs: Date.now() - startedAt,
      };
    }

    // Tool calls present. Append the assistant's tool-call message verbatim
    // (OpenAI requires it before the matching `tool` messages to preserve
    // the conversation contract).
    messages.push({
      role: 'assistant',
      content: response.content ?? '',
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    });

    // Dispatch each tool call sequentially. Parallelism is tempting but
    // overkill: tools mutate device state and runner-side state, and the
    // runner serialises per-session anyway.
    //
    // Each tool emits a paired (started → finished/failed) event onto
    // `chat:processing:step`. The frontend renders these as timeline
    // rows so the user sees "Reading screen… → Tapping element… → …" in
    // real time while waiting for the HTTP response.
    for (const tc of toolCalls) {
      toolCallsMade++;
      const progress = mobileToolProgress(round, MAX_TOOL_ROUNDS);
      emitMobileToolStep(blackboard.chatSessionId, tc.function.name, 'started', progress, {
        round,
        toolCallsMade,
      });

      const startedAt = Date.now();
      // executeTool catches its own errors and returns ToolResult, but a
      // try/finally is cheap insurance: an OOM / stack overflow / unexpected
      // throw would otherwise leave the "started" event unpaired and the
      // chat indicator pulsing forever. The finally branch ALWAYS emits a
      // matching finished/failed event before re-throwing.
      let result: Awaited<ReturnType<typeof executeTool>> | undefined;
      let unexpectedError: unknown;
      try {
        result = await executeTool(
          tc.function.name,
          tc.function.arguments,
          blackboard,
          opts,
        );
      } catch (err) {
        unexpectedError = err;
        logger.error('[MOBILE_AGENT_PIPELINE] executeTool threw unexpectedly', {
          sessionId: blackboard.mobileSessionId,
          tool: tc.function.name,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        const ok = !!result?.ok;
        emitMobileToolStep(
          blackboard.chatSessionId,
          tc.function.name,
          ok ? 'finished' : 'failed',
          progress,
          {
            round,
            toolCallsMade,
            durationMs: Date.now() - startedAt,
            // Trim to keep WS payload light — the frontend never needs the
            // full a11y tree in a progress event.
            preview: (result?.content ?? '').slice(0, 120),
            ...(unexpectedError
              ? {
                  uncaught: true,
                  error: unexpectedError instanceof Error
                    ? unexpectedError.message
                    : String(unexpectedError),
                }
              : {}),
          },
        );
      }

      // If executeTool threw, fail the whole turn — we cannot satisfy the
      // OpenAI contract (every tool_call must have a matching tool message)
      // without a result.content. Re-throw so the handler's catch surfaces
      // a friendly error to the user.
      if (unexpectedError) throw unexpectedError;
      const safeResult = result!;

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: safeResult.content,
      });
    }
    // Loop: next LLM round will see the tool results and either answer
    // directly or call another tool.
  }

  // Reached MAX_TOOL_ROUNDS without a text answer. Force a final text
  // pass WITHOUT tools so the LLM is compelled to speak. This is a safety
  // net — in practice phase 3 terminates on round 2.
  logger.warn('[MOBILE_AGENT_PIPELINE] Tool rounds exhausted, forcing final reply', {
    sessionId: blackboard.mobileSessionId,
    toolCallsMade,
  });
  const closing = await getChatCompletionWithMessages(messages, {
    model: AI_MODELS.fast,
    temperature: 0.2,
    abortSignal: opts?.abortSignal,
  });
  // Same null-safety as the in-loop reply — closing call may also return
  // null content.
  const closingReply = (closing.content ?? '').trim();
  return {
    reply: closingReply || fallbackEmptyReply(),
    toolCallsMade,
    observed: blackboard.getSnapshot() !== null,
    durationMs: Date.now() - startedAt,
  };
}

function fallbackEmptyReply(): string {
  return '⚠️ The agent produced an empty response. Please rephrase your request.';
}
