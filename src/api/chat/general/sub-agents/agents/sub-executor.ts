import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { executeTool } from '@/services/skills/tool-executor';
import { ToolCallTracker } from '@/services/skills/hooks/loop-detection.hook';
// Note: MEMORY_TOOL_NAMES removed — memory tools now go through SkillRegistry
import type { ExecutorResult, PipelineContext, ToolExecutionRecord, TrackedPlanStep } from '../types';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUB-EXECUTOR AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lightweight single-step executor spawned for parallel plan execution.
 * Slimmed-down version of the main executor with:
 * - Configurable tool rounds (default 2 vs main executor's 3)
 * - Uses gpt-4o-mini (vs gpt-4o)
 * - Focused prompt: one step only
 * - Smaller token budget
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Build a focused prompt for a single plan step.
 */
function buildSubExecutorPrompt(step: TrackedPlanStep, userGoal?: string, projectId?: string): string {
  let prompt = `You are executing a single step of a larger plan. Be focused and efficient.

YOUR STEP: Step ${step.stepNumber} — ${step.description}
EXPECTED TOOL: ${step.expectedTool || `any tool from ${step.category} category`}
USER'S OVERALL GOAL: ${userGoal || 'fulfill the user request'}

RULES:
- Execute ONLY this step — do not try to complete the entire plan
- Call the right tool with correct arguments based on the tool schema
- For READ operations: execute immediately
- For WRITE operations: call with confirm=false first
- Do NOT write explanations — just execute the tool

ERROR HANDLING:
- If the expected tool is not available, try the closest alternative from available tools
- If tool arguments are unclear from context, use reasonable defaults rather than guessing
- If the tool fails, do NOT retry with the same arguments — report the error and stop`;

  if (projectId) {
    prompt += `\n- ALWAYS use project_id="${projectId}" for QA tools. Never ask the user for it.`;
  }

  return prompt;
}

/**
 * Execute a single plan step using a lightweight executor.
 * Used by SubAgentSpawner for parallel execution.
 */
export async function executeToolsForStep(
  step: TrackedPlanStep,
  userMessage: string,
  contextMessages: ChatCompletionMessageParam[],
  stepTools: ChatCompletionTool[],
  context: PipelineContext,
  abortSignal?: AbortSignal,
  userGoal?: string
): Promise<ExecutorResult> {
  const startMs = Date.now();
  const toolResults: ToolExecutionRecord[] = [];
  const tracker = new ToolCallTracker(SUB_AGENT_CONFIG.loopDetection);
  let assistantContent = '';

  const prompt = buildSubExecutorPrompt(step, userGoal, context.projectId);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: prompt },
    ...contextMessages,
    { role: 'user', content: userMessage },
  ];

  let toolRound = 0;

  while (toolRound < SUB_AGENT_CONFIG.maxSubExecutorRounds) {
    toolRound++;

    if (abortSignal?.aborted) {
      logger.info('[SUB_EXECUTOR] Request aborted', { step: step.stepNumber, round: toolRound });
      break;
    }

    logger.info('[SUB_EXECUTOR] Tool round', {
      step: step.stepNumber,
      round: toolRound,
      toolsAvailable: stepTools.length,
    });

    const response = await getChatCompletionWithMessages(messages, {
      model: AI_TASK_MODELS.chatSubExecutor,
      temperature: SUB_AGENT_CONFIG.subExecutorTemperature,
      max_tokens: SUB_AGENT_CONFIG.subExecutorMaxTokens,
      tools: stepTools.length > 0 ? stepTools : undefined,
      tool_choice: stepTools.length > 0 ? 'auto' : undefined,
      abortSignal,
    });

    const toolCalls = response.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      assistantContent = response.content || '';
      break;
    }

    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: toolCalls,
    } as any);

    if (response.content) {
      assistantContent = response.content;
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const toolStartMs = Date.now();

      // Parse arguments safely (LLM output parsing stays here)
      let toolArgs: Record<string, any>;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        logger.warn('[SUB_EXECUTOR] Failed to parse tool arguments', {
          step: step.stepNumber,
          toolName,
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

      logger.info('[SUB_EXECUTOR] Executing tool', { step: step.stepNumber, toolName });

      // Execute through centralized pipeline
      const skillContext = {
        userId: context.userId,
        workspaceId: context.workspaceId,
        chatSessionId: context.chatSessionId,
        projectId: context.projectId,
        previewSessionId: context.previewSessionId,
      };

      const callResult = await executeTool({
        toolName,
        toolCallId: toolCall.id,
        args: toolArgs,
        skillContext,
        abortSignal,
        tracker,
      });

      messages.push(...callResult.messages);
      toolResults.push(callResult.record);

      logger.info('[SUB_EXECUTOR] Tool executed', {
        step: step.stepNumber,
        toolName,
        success: callResult.toolResult.success,
        durationMs: callResult.record.durationMs,
      });
    }
  }

  const result: ExecutorResult = {
    success: toolResults.length === 0 || toolResults.some(r => r.result.success),
    toolResults,
    assistantContent,
    toolRounds: toolRound,
  };

  logger.info('[SUB_EXECUTOR] Step execution complete', {
    step: step.stepNumber,
    success: result.success,
    toolRounds: result.toolRounds,
    toolsExecuted: toolResults.map(r => r.toolName),
    durationMs: Date.now() - startMs,
  });

  return result;
}
