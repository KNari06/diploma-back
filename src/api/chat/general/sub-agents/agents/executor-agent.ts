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

import { MEMORY_TOOL_NAMES, withToolTimeoutAndAbort } from '../tool-constants';

/** Compute dynamic progress for a tool within the executor's 70-88% range. */
function computeToolProgress(completedTools: number, estimatedTotal: number): number {
  const range = PROGRESS.PIPELINE_TOOL_CEILING - PROGRESS.PIPELINE_TOOL_BASE;
  const total = Math.max(estimatedTotal, 1);
  const fraction = Math.min(completedTools / total, 1);
  return Math.round(PROGRESS.PIPELINE_TOOL_BASE + fraction * range);
}

/** Convert qa_get_analytics_summary → "get analytics summary" */
function humanizeToolName(toolName: string): string {
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
  const executorPrompt = buildExecutorPrompt(promptPlan, context.projectId, context.mode, userGoal);
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

    // Execute each tool call
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const toolStartMs = Date.now();

      // Parse arguments safely
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

      // Emit thinking step: which tool is being called
      emitProcessingStep(
        context.chatSessionId,
        'agent_executing_tool',
        `Using ${humanizeToolName(toolName)}...`,
        computeToolProgress(toolResults.length, filteredTools.length),
        { toolName, round: toolRound }
      );

      logger.info('[EXECUTOR_AGENT] Executing tool', { toolName, args: JSON.stringify(toolArgs) });

      try {
        let toolResult: any;

        // Route to correct executor (with per-tool timeout + abort signal)
        if (MEMORY_TOOL_NAMES.includes(toolName)) {
          const { executeMemoryTool } = await import('@/services/ai/memory/memory-tools');
          toolResult = await withToolTimeoutAndAbort(
            executeMemoryTool(toolName, toolArgs, context.workspaceId, context.userId),
            toolName,
            abortSignal,
          );
        } else {
          const { SkillRegistry } = await import('@/services/skills');
          const skillContext = {
            userId: context.userId,
            workspaceId: context.workspaceId,
            chatSessionId: context.chatSessionId,
            projectId: context.projectId,
            previewSessionId: context.previewSessionId,
          };
          toolResult = await withToolTimeoutAndAbort(
            SkillRegistry.executeTool(toolName, toolArgs, skillContext),
            toolName,
            abortSignal,
          );
        }

        // Push tool result as text (OpenAI requires tool messages to be plain text)
        const toolResultForMessage = toolName === 'qa_screenshot' && toolResult.success && toolResult.data?.screenshot
          ? { success: true, message: toolResult.message, url: toolResult.data.url }
          : toolResult;
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResultForMessage),
        } as any);

        // For screenshots, inject a user message with the image so the model can see it
        if (toolName === 'qa_screenshot' && toolResult.success && toolResult.data?.screenshot) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: 'Here is the screenshot I just captured from the live preview. Analyze it and describe what you see.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${toolResult.data.screenshot}`, detail: 'low' } },
            ],
          } as any);
        }

        const record: ToolExecutionRecord = {
          toolName,
          args: toolArgs,
          result: toolResult,
          durationMs: Date.now() - toolStartMs,
        };
        toolResults.push(record);

        // Update blackboard step status if available
        if (blackboard) {
          const matchedStep = findMatchingStep(blackboard.getPlan()?.steps, toolName);
          if (matchedStep) {
            blackboard.updateStepStatus(
              matchedStep.stepNumber,
              toolResult.success ? 'completed' : 'failed',
              [record],
              toolResult.success ? undefined : (toolResult.message || 'Tool execution failed'),
            );
          }
        }

        // Emit thinking step: tool result
        emitProcessingStep(
          context.chatSessionId,
          'agent_executing_tool',
          toolResult.success
            ? `${humanizeToolName(toolName)} done`
            : `${humanizeToolName(toolName)} had an issue`,
          computeToolProgress(toolResults.length, filteredTools.length),
          { toolName, success: toolResult.success, durationMs: Date.now() - toolStartMs }
        );

        logger.info('[EXECUTOR_AGENT] Tool executed', {
          toolName,
          success: toolResult.success,
          durationMs: Date.now() - toolStartMs,
        });
      } catch (toolError) {
        logger.error('[EXECUTOR_AGENT] Tool execution error', {
          toolName,
          error: toolError instanceof Error ? toolError.message : String(toolError),
        });

        const errorMessage = `Tool execution failed: ${toolError instanceof Error ? toolError.message : String(toolError)}`;
        const errorResult = {
          success: false,
          message: errorMessage,
        };
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(errorResult),
        } as any);

        const errorRecord: ToolExecutionRecord = {
          toolName,
          args: toolArgs,
          result: { success: false, message: errorResult.message },
          durationMs: Date.now() - toolStartMs,
        };
        toolResults.push(errorRecord);

        // Update blackboard step status for failures
        if (blackboard) {
          const matchedStep = findMatchingStep(blackboard.getPlan()?.steps, toolName);
          if (matchedStep) {
            blackboard.updateStepStatus(matchedStep.stepNumber, 'failed', [errorRecord], errorMessage);
          }
        }

        // Emit thinking step: tool error
        emitProcessingStep(
          context.chatSessionId,
          'agent_executing_tool',
          `${humanizeToolName(toolName)} failed`,
          computeToolProgress(toolResults.length, filteredTools.length),
          { toolName, success: false }
        );
      }
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
