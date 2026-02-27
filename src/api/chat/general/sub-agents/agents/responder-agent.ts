import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { buildResponderPrompt, buildSimpleChatPrompt } from '../prompts/responder-prompt';
import type { ResponderResult, ToolExecutionRecord } from '../types';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESPONDER AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Formats tool results or plain chat into user-friendly response.
 * Uses gpt-4o-mini for cost efficiency — prose generation doesn't need gpt-4o.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Format tool results into a user-friendly response.
 */
export async function formatResponse(
  userMessage: string,
  toolResults: ToolExecutionRecord[],
  executorContent: string,
  contextMessages: ChatCompletionMessageParam[],
  abortSignal?: AbortSignal
): Promise<ResponderResult> {
  const startMs = Date.now();

  // Build results summary for the responder
  const resultsSummary = toolResults.map(r => {
    const status = r.result.success ? 'SUCCESS' : 'FAILED';
    const data = r.result.data
      ? JSON.stringify(r.result.data).substring(0, 2000)
      : r.result.message;
    return `[${status}] ${r.toolName}: ${data}`;
  }).join('\n\n');

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildResponderPrompt() },
    // Include conversation history for context (limited)
    ...extractRecentHistory(contextMessages, 5),
    {
      role: 'user',
      content: `USER'S ORIGINAL MESSAGE: "${userMessage}"

TOOL RESULTS:
${resultsSummary}

${executorContent ? `EXECUTOR NOTE: ${executorContent}` : ''}

Format these results into a natural response for the user.`,
    },
  ];

  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), SUB_AGENT_CONFIG.agentTimeoutMs);
    });

    const aiPromise = getChatCompletionWithMessages(messages, {
      model: AI_TASK_MODELS.chatResponder,
      temperature: 0.5,
      max_tokens: 1500,
      abortSignal,
    });

    const response = await Promise.race([aiPromise, timeoutPromise]);

    if (!response || !response.content) {
      // Fallback: use executor's content or raw results
      logger.warn('[RESPONDER_AGENT] Timeout, using fallback content');
      return {
        content: executorContent || resultsSummary || 'I completed the requested operations.',
      };
    }

    logger.info('[RESPONDER_AGENT] Response formatted', {
      responseLength: response.content.length,
      durationMs: Date.now() - startMs,
    });

    return { content: response.content };
  } catch (error) {
    logger.error('[RESPONDER_AGENT] Failed to format response', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Fallback: return executor content or raw data
    return {
      content: executorContent || resultsSummary || 'I completed the requested operations but had trouble formatting the response.',
    };
  }
}

/**
 * Generate a simple chat response without tools.
 */
export async function generateSimpleResponse(
  userMessage: string,
  contextMessages: ChatCompletionMessageParam[],
  skillDescriptions: string,
  abortSignal?: AbortSignal,
  userContent?: string | ChatCompletionMessageParam['content']
): Promise<ResponderResult> {
  const startMs = Date.now();

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSimpleChatPrompt(skillDescriptions) },
    ...contextMessages,
    // Use multimodal content if available (includes images), otherwise plain text
    { role: 'user', content: (userContent ?? userMessage) as any },
  ];

  try {
    const response = await getChatCompletionWithMessages(messages, {
      model: AI_TASK_MODELS.chatResponder,
      temperature: 0.5,
      max_tokens: 1500,
      abortSignal,
    });

    logger.info('[RESPONDER_AGENT] Simple chat response', {
      responseLength: response.content?.length || 0,
      durationMs: Date.now() - startMs,
    });

    return { content: response.content || 'Sorry, I could not generate a response.' };
  } catch (error) {
    logger.error('[RESPONDER_AGENT] Simple chat failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Extract recent user/assistant messages from context (skip system messages).
 */
function extractRecentHistory(
  messages: ChatCompletionMessageParam[],
  limit: number
): ChatCompletionMessageParam[] {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-limit);
}
