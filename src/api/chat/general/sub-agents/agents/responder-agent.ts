import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { raceWithTimeout } from '../tool-constants';
import { buildResponderPrompt, buildSimpleChatPrompt } from '../prompts/responder-prompt';
import type { ResponderResult, ToolExecutionRecord } from '../types';
import type { Blackboard } from '../blackboard';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESPONDER AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Formats tool results or plain chat into user-friendly response.
 * Uses gemini-2.5-flash-lite for cost efficiency — prose generation doesn't need gpt-5.4-mini.
 *
 * When a Blackboard is provided, reads full pipeline context (goal, plan summary,
 * reviewer guidance, insights) to produce more accurate and goal-aligned responses.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Build enriched context sections from the blackboard for the responder prompt.
 */
function buildBlackboardContext(blackboard?: Blackboard): string {
  if (!blackboard) return '';

  const bb = blackboard.snapshot();
  const sections: string[] = [];

  // Goal context
  sections.push(`USER'S ORIGINAL GOAL: "${bb.userGoal}"`);

  // Plan summary (if available)
  if (bb.plan) {
    const completed = bb.plan.steps.filter(s => s.status === 'completed').length;
    const failed = bb.plan.steps.filter(s => s.status === 'failed').length;
    const total = bb.plan.steps.length;
    sections.push(`PLAN: ${bb.plan.summary} (${completed}/${total} steps completed${failed > 0 ? `, ${failed} failed` : ''})`);
  }

  // Reviewer guidance (if available)
  if (bb.review?.responseGuidance) {
    sections.push(`RESPONSE GUIDANCE: ${bb.review.responseGuidance}`);
  }

  // Clarification needed (if reviewer flagged)
  if (bb.review?.verdict === 'needs_clarification' && bb.review.clarificationNeeded) {
    sections.push(`CLARIFICATION NEEDED: ${bb.review.clarificationNeeded}`);
  }

  // Insights accumulated during pipeline
  if (bb.insights.length > 0) {
    sections.push(`INSIGHTS: ${bb.insights.join('; ')}`);
  }

  return sections.join('\n');
}

/**
 * Format tool results into a user-friendly response.
 */
export async function formatResponse(
  userMessage: string,
  toolResults: ToolExecutionRecord[],
  executorContent: string,
  contextMessages: ChatCompletionMessageParam[],
  abortSignal?: AbortSignal,
  blackboard?: Blackboard
): Promise<ResponderResult> {
  const startMs = Date.now();

  // Build results summary for the responder
  const truncateLimit = SUB_AGENT_CONFIG.responderResultTruncateChars;
  const resultsSummary = toolResults.map(r => {
    const status = r.result.success ? 'SUCCESS' : 'FAILED';
    const dataStr = r.result.data
      ? JSON.stringify(r.result.data).substring(0, truncateLimit)
      : '(no data)';
    // ALWAYS include the message — it contains diagnostic hints for zero-result cases
    const msg = r.result.message ? `\nNote: ${r.result.message}` : '';
    return `[${status}] ${r.toolName}: ${dataStr}${msg}`;
  }).join('\n\n');

  // Build enriched context from blackboard (goal, plan, reviewer guidance)
  const blackboardContext = buildBlackboardContext(blackboard);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildResponderPrompt() },
    // Include conversation history for context (limited)
    ...extractRecentHistory(contextMessages, SUB_AGENT_CONFIG.responderHistoryLimit),
    {
      role: 'user',
      content: `${blackboardContext ? `${blackboardContext}\n\n` : ''}USER'S ORIGINAL MESSAGE: "${userMessage}"

TOOL RESULTS:
${resultsSummary}

${executorContent ? `EXECUTOR NOTE: ${executorContent}` : ''}

Format these results into a natural response for the user.`,
    },
  ];

  try {
    const aiPromise = getChatCompletionWithMessages(messages, {
      model: AI_TASK_MODELS.chatResponder,
      temperature: SUB_AGENT_CONFIG.responderTemperature,
      max_tokens: SUB_AGENT_CONFIG.responderMaxTokens,
      abortSignal,
    });

    const response = await raceWithTimeout(aiPromise, SUB_AGENT_CONFIG.responderTimeoutMs);

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
    const aiPromise = getChatCompletionWithMessages(messages, {
      model: AI_TASK_MODELS.chatResponder,
      temperature: SUB_AGENT_CONFIG.responderTemperature,
      max_tokens: SUB_AGENT_CONFIG.responderMaxTokens,
      abortSignal,
    });

    const response = await raceWithTimeout(aiPromise, SUB_AGENT_CONFIG.responderTimeoutMs);

    if (!response || !response.content) {
      logger.warn('[RESPONDER_AGENT] Simple chat timeout — throwing to trigger monolithic fallback', {
        durationMs: Date.now() - startMs,
      });
      throw new Error('Simple chat response timed out');
    }

    logger.info('[RESPONDER_AGENT] Simple chat response', {
      responseLength: response.content.length,
      durationMs: Date.now() - startMs,
    });

    return { content: response.content };
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
