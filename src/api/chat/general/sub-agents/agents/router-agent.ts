import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { buildRouterPrompt } from '../prompts/router-prompt';
import { getToolGroupSummary, getValidCategories } from '../tool-groups';
import type { RouterResult, ToolCategory } from '../types';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROUTER AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fast classifier: determines what the user needs and which tool categories.
 * Uses deterministic fast-path rules first, falls back to gpt-4o-mini.
 * Categories are dynamic — read from SkillRegistry via getValidCategories().
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Deterministic fast-path: classify obvious patterns without LLM call.
 * Returns null if LLM is needed.
 *
 * @param lastAssistantMsg - last assistant message content (to detect pending confirmations)
 */
function fastPathClassify(message: string, lastAssistantMsg?: string): RouterResult | null {
  const msg = message.toLowerCase().trim();

  // Greetings and very short messages
  if (msg.length < 30 && /^(hi|hello|hey|привет|салем|what can you|help|how are|thanks|thank|спасибо|рахмет)/.test(msg)) {
    return {
      classification: 'simple_chat',
      confidence: 0.95,
      toolCategories: [],
      reasoning: 'greeting/short message',
      requiresMemory: false,
    };
  }

  // Approvals and rejections — BUT only if last assistant message was NOT a confirmation request.
  // If the assistant asked "Confirm?", the approval needs to trigger a tool call, not simple_chat.
  if (msg.length < 20 && /^(yes|no|ok|go|да|нет|давай|cancel|ок|жарайды|иә|жоқ)/.test(msg)) {
    const lastMsg = lastAssistantMsg?.toLowerCase() || '';
    const isPendingConfirmation = /confirm|подтверд|создать\?|выполнить\?|отправить\?|удалить\?|запустить\?/.test(lastMsg);

    if (isPendingConfirmation) {
      // Don't fast-path — let LLM router decide which tool category needs confirm:true
      return null;
    }

    return {
      classification: 'simple_chat',
      confidence: 0.9,
      toolCategories: [],
      reasoning: 'approval/rejection',
      requiresMemory: false,
    };
  }

  // "What can you do?" style questions
  if (/what (can|do) you|что (ты )?(умеешь|можешь)|capabilities|features/.test(msg)) {
    return {
      classification: 'simple_chat',
      confidence: 0.95,
      toolCategories: [],
      reasoning: 'capabilities question',
      requiresMemory: false,
    };
  }

  return null;
}

/**
 * Classify user message and determine required tool categories.
 */
export async function classifyRequest(
  userMessage: string,
  recentMessages: Array<{ role: string; content: string }>,
  availableTools: ChatCompletionTool[],
  abortSignal?: AbortSignal
): Promise<RouterResult> {
  const startMs = Date.now();

  // Get last assistant message for confirmation detection
  const lastAssistantMsg = [...recentMessages].reverse().find(m => m.role === 'assistant')?.content;

  // Try deterministic fast-path first
  const fastResult = fastPathClassify(userMessage, lastAssistantMsg);
  if (fastResult) {
    logger.info('[ROUTER_AGENT] Fast-path classification', {
      classification: fastResult.classification,
      reasoning: fastResult.reasoning,
      durationMs: Date.now() - startMs,
    });
    return fastResult;
  }

  // Build available tool names set for summary
  const availableToolNames = new Set(availableTools.map(t => t.function.name));
  const toolGroupSummary = getToolGroupSummary(availableToolNames);

  // Compress recent history to last 3 messages
  const recentHistory = recentMessages
    .slice(-3)
    .map(m => `${m.role}: ${m.content.substring(0, 150)}`)
    .join('\n');

  const prompt = buildRouterPrompt(userMessage, recentHistory, toolGroupSummary);

  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), SUB_AGENT_CONFIG.agentTimeoutMs);
    });

    const aiPromise = getChatCompletionWithMessages(
      [{ role: 'user', content: prompt }],
      {
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        abortSignal,
      }
    );

    const response = await Promise.race([aiPromise, timeoutPromise]);

    if (!response || !response.content) {
      logger.warn('[ROUTER_AGENT] Timeout or empty response, defaulting to single_tool');
      const defaultCategory = getValidCategories().find(c => c.endsWith('_read')) || getValidCategories()[0] || 'memory';
      return {
        classification: 'single_tool',
        confidence: 0.5,
        toolCategories: [defaultCategory],
        reasoning: 'router timeout — default fallback',
        requiresMemory: false,
      };
    }

    // Parse JSON response
    const cleanContent = response.content.replace(/```json\s*|```\s*/g, '').trim();
    const parsed = JSON.parse(cleanContent);

    // Validate and sanitize
    const classification = ['simple_chat', 'single_tool', 'multi_tool'].includes(parsed.classification)
      ? parsed.classification
      : 'single_tool';

    // Dynamic validation: accept any category that exists in the registry
    const validCategories = getValidCategories();
    const toolCategories = (parsed.toolCategories || []).filter(
      (cat: string) => validCategories.includes(cat)
    ) as ToolCategory[];

    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.7;

    const result: RouterResult = {
      classification,
      confidence,
      toolCategories,
      reasoning: parsed.reasoning || 'no reasoning',
      requiresMemory: !!parsed.requiresMemory,
    };

    // Add memory to categories if needed
    if (result.requiresMemory && !result.toolCategories.includes('memory')) {
      result.toolCategories.push('memory');
    }

    // Ensure single_tool/multi_tool paths have at least one category
    if (result.classification !== 'simple_chat' && result.toolCategories.length === 0) {
      const defaultCategory = validCategories.find(c => c.endsWith('_read')) || validCategories[0] || 'memory';
      result.toolCategories = [defaultCategory];
      result.reasoning += ` (added default ${defaultCategory})`;
    }

    logger.info('[ROUTER_AGENT] LLM classification', {
      classification: result.classification,
      confidence: result.confidence,
      toolCategories: result.toolCategories,
      reasoning: result.reasoning,
      durationMs: Date.now() - startMs,
    });

    return result;
  } catch (error) {
    logger.error('[ROUTER_AGENT] Classification failed', {
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startMs,
    });

    // Safe fallback: treat as single_tool with first available read category
    const fallbackCategories = getValidCategories();
    const fallbackCategory = fallbackCategories.find(c => c.endsWith('_read')) || fallbackCategories[0] || 'memory';
    return {
      classification: 'single_tool',
      confidence: 0.5,
      toolCategories: [fallbackCategory],
      reasoning: `router error: ${error instanceof Error ? error.message : String(error)}`,
      requiresMemory: false,
    };
  }
}
