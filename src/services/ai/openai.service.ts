import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { buildChatSystemPrompt } from '@/ai/prompts/index';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface OpenAIResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string;
  };
}

/**
 * Get chat completion with custom messages array (with token tracking)
 * @param messages - Array of chat messages
 * @param options - Optional configuration
 * @returns AI response with token usage
 */
export async function getChatCompletionWithMessages(
  messages: ChatCompletionMessageParam[],
  options?: {
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: 'json_object' };
    model?: string; // Allow custom model (e.g., gpt-3.5-turbo)
  }
): Promise<OpenAIResponse> {
  try {
    const model = options?.model || env.OPENAI_MODEL || 'gpt-4o-mini';

    const response = await openai.chat.completions.create({
      model,
      messages,
      max_tokens: options?.max_tokens || env.OPENAI_MAX_TOKENS || 1000,
      temperature: options?.temperature ?? 0.5,
      ...(options?.response_format && { response_format: options.response_format }),
    });

    const reply = response.choices[0]?.message?.content || '';
    const usage = response.usage;

    logger.info('[OPENAI] Chat completion with messages successful', {
      model,
      messageCount: messages.length,
      replyLength: reply.length,
      inputTokens: usage?.prompt_tokens || 0,
      outputTokens: usage?.completion_tokens || 0,
      totalTokens: usage?.total_tokens || 0,
    });

    return {
      content: reply,
      usage: {
        inputTokens: usage?.prompt_tokens || 0,
        outputTokens: usage?.completion_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
        model,
      },
    };
  } catch (error) {
    logger.error('[OPENAI] Chat completion with messages error:', error);
    throw new Error('AI chat failed');
  }
}

/**
 * Get chat completion from OpenAI (with token tracking)
 * @param prompt - User message
 * @param context - Optional context for RAG
 * @returns AI response with token usage
 */
export async function getChatCompletion(
  prompt: string,
  context?: string
): Promise<OpenAIResponse> {
  try {
    // Use centralized prompt (in English, but AI will respond in user's language)
    const systemPrompt = buildChatSystemPrompt();

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add context if provided (for RAG integration)
    if (context) {
      messages.push({
        role: 'system',
        content: `Context: ${context}`,
      });
    }

    messages.push({ role: 'user', content: prompt });

    const model = env.OPENAI_MODEL || 'gpt-4o-mini';

    const response = await openai.chat.completions.create({
      model,
      messages,
      max_tokens: env.OPENAI_MAX_TOKENS || 1000,
      temperature: 0.5, // Softer, more balanced responses
    });

    const reply = response.choices[0]?.message?.content || '🤖 Could not understand the request.';
    const usage = response.usage;

    logger.info('[OPENAI] Chat completion successful', {
      model,
      promptLength: prompt.length,
      replyLength: reply.length,
      inputTokens: usage?.prompt_tokens || 0,
      outputTokens: usage?.completion_tokens || 0,
      totalTokens: usage?.total_tokens || 0,
    });

    return {
      content: reply,
      usage: {
        inputTokens: usage?.prompt_tokens || 0,
        outputTokens: usage?.completion_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
        model,
      },
    };
  } catch (error) {
    logger.error('[OPENAI] Chat completion error:', error);
    throw new Error('AI chat failed');
  }
}
