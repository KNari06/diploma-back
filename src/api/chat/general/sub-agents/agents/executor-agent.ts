import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { buildExecutorPrompt } from '../prompts/executor-prompt';
import type { ExecutorResult, PipelineContext, ToolExecutionRecord, TrackedPlanStep } from '../types';
import type { Blackboard } from '../blackboard';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { emitProcessingStep } from '@/api/chat/shared/utils';
import { PROGRESS } from '@/api/chat/shared/constants';
import { executeTool } from '@/services/skills/tool-executor';
import { ToolCallTracker } from '@/services/skills/hooks/loop-detection.hook';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXECUTOR AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Focused tool-calling loop. Sees ONLY the filtered subset of tools.
 * Routes through existing SkillRegistry.executeTool() and executeMemoryTool().
 *
 * When a Blackboard is provided, reads structured plan steps and updates
 * step status as execution progresses. This enables cross-agent context
 * sharing and plan tracking.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Note: MEMORY_TOOL_NAMES removed — memory tools now go through SkillRegistry

/**
 * Compute dynamic progress for a tool within the executor's 70-88% range.
 * Exported so the monolithic-loop fallback in `general/handler.ts` reports
 * progress on the same scale as the sub-agent path — keeps the timeline
 * visually consistent when the pipeline degrades to the legacy loop.
 */
export function computeToolProgress(completedTools: number, estimatedTotal: number): number {
  const range = PROGRESS.PIPELINE_TOOL_CEILING - PROGRESS.PIPELINE_TOOL_BASE;
  const total = Math.max(estimatedTotal, 1);
  const fraction = Math.min(completedTools / total, 1);
  return Math.round(PROGRESS.PIPELINE_TOOL_BASE + fraction * range);
}

/**
 * Convert qa_get_analytics_summary → "get analytics summary".
 * Exported for the monolithic loop (see computeToolProgress).
 */
export function humanizeToolName(toolName: string): string {
  if (!toolName) return 'tool';
  return toolName.replace(/^qa_/, '').replace(/_/g, ' ') || toolName;
}

/**
 * Try to match a tool execution to a plan step.
 * Matches by expectedTool first, then by category prefix.
 */
function findMatchingStep(
  steps: TrackedPlanStep[] | undefined,
  toolName: string
): TrackedPlanStep | undefined {
  if (!steps) return undefined;

  // 1. Exact match on expectedTool (highest confidence)
  const exactMatch = steps.find(
    s => s.status === 'in_progress' && s.expectedTool === toolName
  );
  if (exactMatch) return exactMatch;

  // 2. Match by category prefix (e.g., tool "qa_list_test_cases" → category "qa_read")
  const categoryMatch = steps.find(
    s => s.status === 'in_progress' && toolName.startsWith(s.category.replace(/_read$|_write$/, ''))
  );
  if (categoryMatch) return categoryMatch;

  // 3. Any in_progress step (fallback for single-step execution)
  return steps.find(s => s.status === 'in_progress');
}

/**
 * Tools whose args carry an authored step set, mapped to the trace `source`.
 * `qa_author_test_iteratively` is intentionally absent — it takes a `goal`, not
 * a `steps` array (its steps are produced inside the tool result, a separate
 * capture left for a follow-up).
 */
const STEP_TRACE_SOURCE: Record<string, 'saved' | 'updated' | 'run'> = {
  qa_create_test_case: 'saved',
  qa_update_test_case_steps: 'updated',
  qa_run_draft_steps: 'run',
};

/** Cap the traced step detail so a pathological array can't bloat the JSONL line. */
const MAX_TRACED_STEPS = 200;

/**
 * Map a step-producing tool call to a `writeSteps` trace payload, or null if the
 * tool doesn't author steps / carries none. Steps are reduced to the
 * `{type, description}` contract — `value`/`assertionText` are dropped so no
 * interpolated value reaches the trace — while `stepCount` stays the true count.
 */
function buildStepTrace(
  toolName: string,
  toolArgs: Record<string, any>,
): { source: 'saved' | 'updated' | 'run'; stepCount: number; steps: Array<{ type?: string; description?: string }>; startUrl?: string } | null {
  const source = STEP_TRACE_SOURCE[toolName];
  if (!source) return null;
  const rawSteps = toolArgs?.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;
  const steps = rawSteps.slice(0, MAX_TRACED_STEPS).map((s: any) => ({
    type: typeof s?.type === 'string' ? s.type : undefined,
    description: typeof s?.description === 'string' ? s.description : undefined,
  }));
  const startUrl = typeof toolArgs?.start_url === 'string' ? toolArgs.start_url : undefined;
  return { source, stepCount: rawSteps.length, steps, startUrl };
}

/**
 * Execute tool calls in a focused loop with filtered tool subset.
 *
 * Supports two modes:
 * - Legacy: pass `plan` as string (backward-compatible)
 * - Blackboard: pass `blackboard` for structured plan tracking and step updates
 */
export async function executeTools(
  userMessage: string,
  contextMessages: ChatCompletionMessageParam[],
  filteredTools: ChatCompletionTool[],
  context: PipelineContext,
  plan?: string,
  abortSignal?: AbortSignal,
  userContent?: string | ChatCompletionMessageParam['content'],
  blackboard?: Blackboard
): Promise<ExecutorResult> {
  const startMs = Date.now();
  const toolResults: ToolExecutionRecord[] = [];
  let assistantContent = '';

  // Create loop detection tracker for this execution
  const tracker = new ToolCallTracker(SUB_AGENT_CONFIG.loopDetection);

  // Determine plan source: blackboard (structured) or legacy text
  let promptPlan: string | TrackedPlanStep[] | undefined;
  let userGoal: string | undefined;

  if (blackboard) {
    const bbPlan = blackboard.getPlan();
    if (bbPlan) {
      promptPlan = bbPlan.steps;
      // Mark all pending steps as in_progress
      bbPlan.steps
        .filter(s => s.status === 'pending')
        .forEach(s => blackboard.updateStepStatus(s.stepNumber, 'in_progress'));
    }
    userGoal = blackboard.getGoal();
  } else if (plan) {
    promptPlan = plan;
  }

  // Build executor messages
  const executorPrompt = buildExecutorPrompt(
    promptPlan,
    context.projectId,
    context.mode,
    userGoal,
    context.projectName,
    context.testCaseId,
    context.testCaseName,
  );
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: executorPrompt },
    // Include relevant context messages (system prompts with memory/KB/history)
    ...contextMessages,
    // Use multimodal content if available (includes images), otherwise plain text
    { role: 'user', content: (userContent ?? userMessage) as any },
  ];

  let toolRound = 0;

  while (toolRound < SUB_AGENT_CONFIG.maxToolRounds) {
    toolRound++;

    // Check if request was cancelled between rounds
    if (abortSignal?.aborted) {
      logger.info('[EXECUTOR_AGENT] Request aborted between rounds', { round: toolRound });
      break;
    }

    logger.info('[EXECUTOR_AGENT] Tool round', {
      round: toolRound,
      messagesCount: messages.length,
      toolsAvailable: filteredTools.length,
    });

    // Call OpenAI with filtered tools
    const response = await getChatCompletionWithMessages(messages, {
      model: AI_TASK_MODELS.chatExecutor,
      temperature: SUB_AGENT_CONFIG.executorTemperature,
      max_tokens: SUB_AGENT_CONFIG.executorMaxTokens,
      tools: filteredTools.length > 0 ? filteredTools : undefined,
      tool_choice: filteredTools.length > 0 ? 'auto' : undefined,
      abortSignal,
    });

    const toolCalls = response.tool_calls;

    // No tool calls — executor is done
    if (!toolCalls || toolCalls.length === 0) {
      assistantContent = response.content || '';
      break;
    }

    // Push assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: toolCalls,
    } as any);

    if (response.content) {
      assistantContent = response.content;
    }

    // Execute each tool call via centralized ToolExecutor
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const toolStartMs = Date.now();

      // Parse arguments safely (LLM output parsing stays here — not a tool concern)
      let toolArgs: Record<string, any>;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        logger.warn('[EXECUTOR_AGENT] Failed to parse tool arguments', {
          toolName,
          raw: toolCall.function.arguments?.substring(0, 200),
        });
        const errorResult = { success: false, message: 'Invalid arguments: failed to parse JSON' };
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(errorResult),
        } as any);
        toolResults.push({
          toolName,
          args: {},
          result: { success: false, message: errorResult.message },
          durationMs: Date.now() - toolStartMs,
        });
        continue;
      }

      // Emit pre-execution progress (UI concern — stays in executor).
      // Last arg `context.testCaseId` triggers dual-broadcast to
      // `chat:tc:<tcid>` for the per-test-case chat surface; undefined
      // on the legacy global path leaves emit behavior unchanged.
      emitProcessingStep(
        context.chatSessionId,
        'agent_executing_tool',
        `Using ${humanizeToolName(toolName)}...`,
        computeToolProgress(toolResults.length, filteredTools.length),
        { toolName, round: toolRound },
        context.testCaseId,
      );

      // Execute tool through centralized pipeline (routing, hooks, timeout, screenshot handling)
      const skillContext = {
        userId: context.userId,
        workspaceId: context.workspaceId,
        chatSessionId: context.chatSessionId,
        projectId: context.projectId,
        previewSessionId: context.previewSessionId,
        mode: context.mode,
      };

      const callResult = await executeTool({
        toolName,
        toolCallId: toolCall.id,
        args: toolArgs,
        skillContext,
        abortSignal,
        tracker,
      });

      // Push messages (tool_result + possible screenshot image)
      messages.push(...callResult.messages);
      toolResults.push(callResult.record);

      // Trace the tool call into test_logs/chat_test/ (test-case scope only).
      if (context.testCaseId && context.chatSessionId) {
        try {
          const { ChatTestTraceService } = require('@/services/chat/chat-test-trace.service');
          const trace = ChatTestTraceService.getOrCreate(
            context.chatSessionId,
            context.userId,
            context.testCaseId,
          );
          trace.writeToolCall({
            toolName,
            args: toolArgs as Record<string, unknown>,
            success: callResult.toolResult.success,
            resultSummary: callResult.toolResult.message,
            durationMs: callResult.record.durationMs,
          });
          // Capture the authored step set — the primary signal for measuring
          // authoring quality — whenever this tool carried one.
          const stepTrace = buildStepTrace(toolName, toolArgs);
          if (stepTrace) trace.writeSteps(stepTrace);
        } catch { /* trace must never break tool execution */ }
      }

      // Update blackboard step status (executor-specific concern)
      if (blackboard) {
        const matchedStep = findMatchingStep(blackboard.getPlan()?.steps, toolName);
        if (matchedStep) {
          blackboard.updateStepStatus(
            matchedStep.stepNumber,
            callResult.toolResult.success ? 'completed' : 'failed',
            [callResult.record],
            callResult.toolResult.success ? undefined : (callResult.toolResult.message || 'Tool execution failed'),
          );
        }
      }

      // Emit post-execution progress
      emitProcessingStep(
        context.chatSessionId,
        'agent_executing_tool',
        callResult.toolResult.success
          ? `${humanizeToolName(toolName)} done`
          : `${humanizeToolName(toolName)} had an issue`,
        computeToolProgress(toolResults.length, filteredTools.length),
        { toolName, success: callResult.toolResult.success, durationMs: callResult.record.durationMs },
        context.testCaseId,
      );
    }
  }

  const result: ExecutorResult = {
    success: toolResults.length === 0 || toolResults.some(r => r.result.success),
    toolResults,
    assistantContent,
    toolRounds: toolRound,
  };

  logger.info('[EXECUTOR_AGENT] Execution complete', {
    success: result.success,
    toolRounds: result.toolRounds,
    toolsExecuted: toolResults.map(r => r.toolName),
    durationMs: Date.now() - startMs,
  });

  return result;
}
