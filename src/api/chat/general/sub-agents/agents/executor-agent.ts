import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { buildExecutorPrompt } from '../prompts/executor-prompt';
import type { ExecutorResult, PipelineContext, ToolExecutionRecord } from '../types';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXECUTOR AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Focused tool-calling loop. Sees ONLY the filtered subset of tools.
 * Routes through existing SkillRegistry.executeTool() and executeMemoryTool().
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const TOOL_TIMEOUT_MS = 15000;
const MEMORY_TOOL_NAMES = ['remember_fact', 'search_memory', 'forget_fact'];

/**
 * Execute tool calls in a focused loop with filtered tool subset.
 */
export async function executeTools(
  userMessage: string,
  contextMessages: ChatCompletionMessageParam[],
  filteredTools: ChatCompletionTool[],
  context: PipelineContext,
  plan?: string,
  abortSignal?: AbortSignal
): Promise<ExecutorResult> {
  const startMs = Date.now();
  const toolResults: ToolExecutionRecord[] = [];
  let assistantContent = '';

  // Build executor messages
  const executorPrompt = buildExecutorPrompt(plan, context.projectId);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: executorPrompt },
    // Include relevant context messages (system prompts with memory/KB/history)
    ...contextMessages,
    { role: 'user', content: userMessage },
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
      model: 'gpt-4o',
      temperature: 0.3,
      max_tokens: 1500,
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

      logger.info('[EXECUTOR_AGENT] Executing tool', { toolName, args: JSON.stringify(toolArgs) });

      try {
        let toolResult: any;

        // Timeout wrapper
        const withTimeout = <T>(promise: Promise<T>): Promise<T> => {
          return Promise.race([
            promise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Tool '${toolName}' timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS)
            ),
          ]);
        };

        // Route to correct executor
        if (MEMORY_TOOL_NAMES.includes(toolName)) {
          const { executeMemoryTool } = await import('@/services/ai/memory/memory-tools');
          toolResult = await withTimeout(
            executeMemoryTool(toolName, toolArgs, context.workspaceId, context.userId)
          );
        } else {
          const { SkillRegistry } = await import('@/services/skills');
          const skillContext = {
            userId: context.userId,
            workspaceId: context.workspaceId,
            chatSessionId: context.chatSessionId,
            projectId: context.projectId,
          };
          toolResult = await withTimeout(
            SkillRegistry.executeTool(toolName, toolArgs, skillContext)
          );
        }

        // Push result to messages
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        } as any);

        toolResults.push({
          toolName,
          args: toolArgs,
          result: toolResult,
          durationMs: Date.now() - toolStartMs,
        });

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

        const errorResult = {
          success: false,
          message: `Tool execution failed: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
        };
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(errorResult),
        } as any);

        toolResults.push({
          toolName,
          args: toolArgs,
          result: { success: false, message: errorResult.message },
          durationMs: Date.now() - toolStartMs,
        });
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
