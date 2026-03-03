import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { raceWithTimeout } from '../tool-constants';
import { buildRouterPrompt } from '../prompts/router-prompt';
import { getToolGroupSummary, getValidCategories } from '../tool-groups';
import type { RouterResult, ToolCategory } from '../types';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROUTER AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * LLM-only classifier: determines what the user needs and which tool categories.
 * All classification goes through the LLM — no deterministic shortcuts.
 * Categories are dynamic — read from SkillRegistry via getValidCategories().
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

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
    const aiPromise = getChatCompletionWithMessages(
      [{ role: 'user', content: prompt }],
      {
        model: AI_TASK_MODELS.chatRouter,
        temperature: SUB_AGENT_CONFIG.routerTemperature,
        max_tokens: SUB_AGENT_CONFIG.routerMaxTokens,
        response_format: { type: 'json_object' },
        abortSignal,
      }
    );

    const response = await raceWithTimeout(aiPromise, SUB_AGENT_CONFIG.agentTimeoutMs);

    if (!response || !response.content) {
      logger.warn('[ROUTER_AGENT] Timeout or empty response, defaulting to single_tool');
      const availableCategories = getValidCategories(availableToolNames);
      const defaultCategory = availableCategories.find(c => c.endsWith('_read')) || availableCategories[0] || 'memory';
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

    // Dynamic validation: only accept categories that have actually available tools
    const validCategories = getValidCategories(availableToolNames);
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
      clarificationQuestion: typeof parsed.clarificationQuestion === 'string'
        ? parsed.clarificationQuestion
        : undefined,
    };

    // Add memory to categories if needed
    if (result.requiresMemory && !result.toolCategories.includes('memory')) {
      result.toolCategories.push('memory');
    }

    // Ensure single_tool/multi_tool paths have at least one category
    if (result.classification !== 'simple_chat' && result.toolCategories.length === 0) {
      const availableCategories = getValidCategories(availableToolNames);
      const defaultCategory = availableCategories.find(c => c.endsWith('_read')) || availableCategories[0] || 'memory';
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
    const fallbackCategories = getValidCategories(availableToolNames);
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
