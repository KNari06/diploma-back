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
import {
  formatMobileSnapshotForChat,
  type MobileSnapshot,
} from '@/services/chat/mobile-context.service';
import type { MobileIntentStep } from '@/services/mobile/mobile-runner.types';
import { formatMobileProjectContextForChat } from '@/services/chat/mobile-project-context.service';

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
  /**
   * Structured draft steps authored by `mobile_run_draft_steps` this turn,
   * surfaced so the handler can lift them onto the HTTP reply metadata. The
   * chat UI renders them as editable step widgets (draftMeta.executed tells
   * it whether they already ran or await a UI-confirm run). Absent on turns
   * that didn't author a draft. If the tool is called more than once, the
   * LAST authored draft wins (matches the in-memory draft cache, which the
   * last call also overwrote).
   */
  draftSteps?: MobileIntentStep[];
  draftMeta?: MobileDraftStepsMeta;
}

/** Shape of `draftMeta` carried on both the tool result and the reply. */
export interface MobileDraftStepsMeta {
  /** Stable per-draft id; the chat card uses it to namespace step ids so two
   *  drafts (or a remounted one) never collide in editorSteps/status/save. */
  draftId: string;
  chatSessionId: string;
  mobileSessionId: string;
  platform: string;
  suggestedName?: string;
  executed: boolean;
  /**
   * Placeholder schema for the sanitized {{param_*}} values in the draft. The
   * chat card forwards it on Save so the saved test case resolves those values
   * on regression replay. Absent when no value was parameterised.
   */
  parametersSchema?: Record<string, unknown>;
}

export interface RunMobileAgentPipelineOpts {
  abortSignal?: AbortSignal;
  /**
   * Phase B2-B4 eager-inject: pre-fetched runner snapshot. When present,
   * the pipeline pushes it into the system prompt as a second system
   * message BEFORE the first LLM call — same pattern web uses with
   * `getPageContext` in `general/handler.ts`. The LLM sees device-fresh
   * foreground + a11y tree without needing the observe_mobile_page tool
   * roundtrip.
   *
   * Null/undefined = legacy PULL behaviour (LLM must call
   * observe_mobile_page if it wants to see the screen). The tool stays
   * available either way; this only controls whether the pre-fetch
   * fires.
   */
  snapshot?: MobileSnapshot | null;
  /**
   * When the mobile editor is scoped to a SAVED test case, a formatted summary
   * of its existing steps. Injected as a system block so the agent EXTENDS the
   * open flow ("add a logout after login") instead of re-authoring it from
   * scratch (duplicate). Null/undefined = no open test case (workspace scope).
   */
  openTestCaseBlock?: string | null;
  /**
   * APP MAP — a formatted summary of the project's OTHER saved mobile tests
   * (known flows/screens of the app under test). Injected as a system block so
   * the agent grounds multi-screen authoring in real, already-tested screens
   * instead of inventing steps for screens it never observed. Null when the
   * project has no other mobile tests or the read failed (best-effort).
   */
  appKnowledgeBlock?: string | null;
  /**
   * The durable per-app SCREEN MAP from prior explorations (screens + flows +
   * reachability), as a compact brief. Complements appKnowledgeBlock (saved
   * tests): this is the learned app structure, so the agent can reason about
   * screens it hasn't observed this turn without re-crawling. Null when the app
   * hasn't been explored / no key / read failed (best-effort).
   */
  appSkeletonBlock?: string | null;
  /**
   * Prior conversation turns (oldest→newest), already role-mapped for OpenAI
   * and secret-redacted by the handler. Threaded between the system blocks and
   * the current user goal so the agent has memory across turns ("now do the
   * same on signup", "no, the other button", "undo the last step"). Empty when
   * there's no prior history or the load failed (best-effort).
   */
  history?: ChatCompletionMessageParam[];
}

export async function runMobileAgentPipeline(
  blackboard: MobileBlackboard,
  opts?: RunMobileAgentPipelineOpts,
): Promise<MobileAgentResult> {
  const startedAt = Date.now();

  // Eager-inject situational context as extra system messages AFTER the
  // static base prompt (prompt-cache: index 0 never changes per turn):
  //   1. Project context (project + app under test + open-test-case steps,
  //      resolved by the handler). Stable across a session's turns, so it
  //      sits before the per-turn snapshot for better cache locality.
  //   2. Device snapshot ("here's what's on the screen right now").
  const projectContext = blackboard.getProjectContext();
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildMobileAgentSystemPrompt() },
    // Eager project context (app-under-test, resolved before the first LLM
    // call) BEFORE the device snapshot — stable across the turn (cache-local).
    ...(projectContext
      ? [{ role: 'system' as const, content: formatMobileProjectContextForChat(projectContext) }]
      : []),
    // Open-test-case steps (when the editor is scoped to a saved test) BEFORE
    // the device snapshot: the agent should know the existing flow to extend it,
    // not duplicate it. Stable across the turn (good for prompt cache).
    ...(opts?.openTestCaseBlock
      ? [{ role: 'system' as const, content: opts.openTestCaseBlock }]
      : []),
    // APP MAP (project's other saved mobile tests) — grounds authoring for
    // screens the agent hasn't observed this turn. Stable across the turn
    // (cache-local), before the per-turn snapshot.
    ...(opts?.appKnowledgeBlock
      ? [{ role: 'system' as const, content: opts.appKnowledgeBlock }]
      : []),
    // APP SKELETON (screen map from prior explorations) — lets the agent reason
    // about the app's structure before crawling. Stable across the turn, so it
    // sits with the other app-context blocks, before the per-turn snapshot.
    ...(opts?.appSkeletonBlock
      ? [{ role: 'system' as const, content: opts.appSkeletonBlock }]
      : []),
    ...(opts?.snapshot
      ? [{ role: 'system' as const, content: formatMobileSnapshotForChat(opts.snapshot) }]
      : []),
    // Prior turns (oldest→newest) BEFORE the current goal so the agent resolves
    // references to earlier turns. The snapshot/open-test-case system blocks
    // stay ABOVE history (situational context first), history is the running
    // dialogue, and the current goal is last.
    ...(opts?.history ?? []),
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
  // Captured from mobile_run_draft_steps' result data whenever it authors a
  // draft this turn. Lifted onto the reply so the chat renders editable steps.
  let draftSteps: MobileIntentStep[] | undefined;
  let draftMeta: MobileDraftStepsMeta | undefined;

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
        ...(draftSteps && draftMeta ? { draftSteps, draftMeta } : {}),
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

      // Phase B5: `take_screenshot` returns the captured PNG as base64 in
      // `data.screenshotBase64`, but the OpenAI tool-message protocol only
      // accepts text content. To actually let the LLM see the pixels, we
      // emit a follow-up `user` message with a multimodal content array
      // (text + image_url). Vision-capable models (gpt-4o, gpt-4.1) read
      // both parts; non-vision models silently ignore the image part and
      // still get the text breadcrumb.
      //
      // Failure paths (budget exceeded, runner returned no screenshot,
      // network error) leave `data` either undefined or without
      // `screenshotBase64`, so this branch never fires on the unhappy
      // path — the `tool` message above already explained what happened.
      // Capture authored draft steps (mobile_run_draft_steps). Present on both
      // the author-only (confirm=false) and executed (confirm=true) paths. Last
      // authoring call wins — mirrors the in-memory draft cache it overwrote.
      const draftData = safeResult.data as
        | { draftSteps?: MobileIntentStep[]; draftMeta?: MobileDraftStepsMeta }
        | undefined;
      if (draftData?.draftSteps && draftData.draftMeta) {
        draftSteps = draftData.draftSteps;
        draftMeta = draftData.draftMeta;
      }

      const screenshotData = safeResult.data as { screenshotBase64?: string; capturedAt?: string } | undefined;
      if (safeResult.ok && screenshotData?.screenshotBase64) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[Screenshot attached from take_screenshot at ${screenshotData.capturedAt ?? 'now'}]`,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${screenshotData.screenshotBase64}`,
                // "low" detail keeps cost predictable — ~85 tokens vs
                // ~1500-3000 for "high". The screenshot tool exists for
                // quick visual sanity checks, not pixel-perfect inspection;
                // bumping to "high" would defeat the per-turn budget guard.
                detail: 'low',
              },
            },
          ],
        });
      }
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
    ...(draftSteps && draftMeta ? { draftSteps, draftMeta } : {}),
  };
}

function fallbackEmptyReply(): string {
  return '⚠️ The agent produced an empty response. Please rephrase your request.';
}
