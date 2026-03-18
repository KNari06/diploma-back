/**
 * Universal AI Provider
 * Unified interface for OpenAI, Gemini, and future providers
 *
 * Usage:
 * - Fast tasks (keyword extraction, classification): use 'fast' provider (Gemini 2.5 Flash-Lite)
 * - Complex tasks (analysis, code generation): use 'smart' provider (GPT-4.1 or Gemini Pro)
 *
 * Configuration via env:
 * - AI_PROVIDER_FAST = 'gemini' | 'openai' (default: gemini)
 * - AI_PROVIDER_SMART = 'openai' | 'gemini' (default: openai)
 */

import { env } from '@/config/environment/env';
import { AI_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from './openai.service';
import { generateTextWithGemini, getChatCompletionWithGemini } from './gemini.service';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type AIProvider = 'openai' | 'gemini';
export type AITask = 'fast' | 'smart';

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string;
    provider: AIProvider;
  };
}

export interface GenerateTextOptions {
  /** Which provider to use (overrides default for task type) */
  provider?: AIProvider;
  /** Task type: 'fast' (Gemini 2.5 Flash-Lite) or 'smart' (GPT-4.1/Gemini Pro) */
  task?: AITask;
  /** Model override (provider-specific) */
  model?: string;
  /** Temperature (0 = deterministic, 1 = creative) */
  temperature?: number;
  /** Max output tokens */
  maxTokens?: number;
  /** Request timeout (ms) */
  timeout?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get configured provider for a task type
 */
function getProviderForTask(task: AITask, override?: AIProvider): AIProvider {
  if (override) return override;

  if (task === 'fast') {
    return (env.AI_PROVIDER_FAST as AIProvider) || 'gemini';
  } else {
    return (env.AI_PROVIDER_SMART as AIProvider) || 'openai';
  }
}

/**
 * Get default model for provider and task
 */
function getDefaultModel(provider: AIProvider, task: AITask): string {
  if (provider === 'gemini') {
    return task === 'fast' ? 'gemini-2.5-flash-lite' : 'gemini-2.5-pro';
  } else {
    return task === 'fast' ? AI_MODELS.fast : AI_MODELS.smart;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMPLE TEXT GENERATION (Prompt → Text)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate text from a simple prompt
 * Best for: keyword extraction, classification, simple transformations
 *
 * @example
 * const keywords = await generateText({
 *   prompt: "Extract keywords from: 'Click on login button'",
 *   task: 'fast', // Uses Gemini Flash by default
 *   temperature: 0,
 * });
 */
export async function generateText(params: {
  prompt: string;
} & GenerateTextOptions): Promise<AIResponse> {
  const {
    prompt,
    provider: providerOverride,
    task = 'fast',
    model: modelOverride,
    temperature = 0,
    maxTokens = 100,
    timeout = 5000,
  } = params;

  const provider = getProviderForTask(task, providerOverride);
  const model = modelOverride || getDefaultModel(provider, task);

  logger.debug('[AI_PROVIDER] Generating text', {
    provider,
    model,
    task,
    promptLength: prompt.length,
  });

  try {
    if (provider === 'gemini') {
      const response = await generateTextWithGemini({
        prompt,
        model: model as any,
        temperature,
        maxTokens,
        timeout,
      });

      return {
        ...response,
        usage: {
          ...response.usage,
          provider: 'gemini',
        },
      };
    } else {
      // OpenAI doesn't have a direct "prompt → text" API, so use chat completion
      const response = await getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          model,
          temperature,
          max_tokens: maxTokens,
        }
      );

      return {
        ...response,
        usage: {
          ...response.usage,
          provider: 'openai',
        },
      };
    }
  } catch (error) {
    logger.error('[AI_PROVIDER] Text generation failed', {
      provider,
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHAT COMPLETION (Messages Array → Response)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate chat completion from messages array
 * Best for: multi-turn conversations, complex analysis, structured outputs
 *
 * @example
 * const response = await generateChatCompletion({
 *   messages: [
 *     { role: 'system', content: 'You are a test automation expert' },
 *     { role: 'user', content: 'How do I test a login form?' },
 *   ],
 *   task: 'smart', // Uses GPT-4.1 by default
 * });
 */
export async function generateChatCompletion(params: {
  messages: AIMessage[];
} & GenerateTextOptions): Promise<AIResponse> {
  const {
    messages,
    provider: providerOverride,
    task = 'smart',
    model: modelOverride,
    temperature = 0.5,
    maxTokens = 1000,
    timeout = 30000,
  } = params;

  const provider = getProviderForTask(task, providerOverride);
  const model = modelOverride || getDefaultModel(provider, task);

  logger.debug('[AI_PROVIDER] Generating chat completion', {
    provider,
    model,
    task,
    messageCount: messages.length,
  });

  try {
    if (provider === 'gemini') {
      const response = await getChatCompletionWithGemini({
        messages,
        model: model as any,
        temperature,
        maxTokens,
        timeout,
      });

      return {
        ...response,
        usage: {
          ...response.usage,
          provider: 'gemini',
        },
      };
    } else {
      const response = await getChatCompletionWithMessages(
        messages as any,
        {
          model,
          temperature,
          max_tokens: maxTokens,
        }
      );

      return {
        ...response,
        usage: {
          ...response.usage,
          provider: 'openai',
        },
      };
    }
  } catch (error) {
    logger.error('[AI_PROVIDER] Chat completion failed', {
      provider,
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a provider is available (has API key configured)
 */
export function isProviderAvailable(provider: AIProvider): boolean {
  if (provider === 'gemini') {
    return !!env.GEMINI_API_KEY;
  } else {
    return !!env.OPENAI_API_KEY;
  }
}

/**
 * Get list of available providers
 */
export function getAvailableProviders(): AIProvider[] {
  const providers: AIProvider[] = [];
  if (isProviderAvailable('openai')) providers.push('openai');
  if (isProviderAvailable('gemini')) providers.push('gemini');
  return providers;
}
