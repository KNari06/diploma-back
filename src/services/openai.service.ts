import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { buildChatSystemPrompt } from '@/ai/prompts/index';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/**
 * Get chat completion with custom messages array
 * @param messages - Array of chat messages
 * @param options - Optional configuration
 * @returns AI response
 */
export async function getChatCompletionWithMessages(
  messages: ChatCompletionMessageParam[],
  options?: {
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: 'json_object' };
    model?: string; // Allow custom model (e.g., gpt-3.5-turbo)
  }
): Promise<string> {
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

    logger.info('Chat completion with messages successful', {
      messageCount: messages.length,
      replyLength: reply.length,
    });

    return reply;
  } catch (error) {
    logger.error('Chat completion with messages error:', error);
    throw new Error('AI chat failed');
  }
}

/**
 * Get chat completion from OpenAI
 * @param prompt - User message
 * @param context - Optional context for RAG (future feature)
 * @returns AI response
 */
export async function getChatCompletion(prompt: string, context?: string): Promise<string> {
  try {
    // Use centralized prompt (in English, but AI will respond in user's language)
    const systemPrompt = buildChatSystemPrompt();

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add context if provided (for future RAG integration)
    if (context) {
      messages.push({
        role: 'system',
        content: `Контекст: ${context}`,
      });
    }

    messages.push({ role: 'user', content: prompt });

    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      max_tokens: env.OPENAI_MAX_TOKENS || 1000,
      temperature: 0.5, // Softer, more balanced responses
    });

    const reply = response.choices[0]?.message?.content || '🤖 Не понял запрос.';

    logger.info('Chat completion successful', { promptLength: prompt.length, replyLength: reply.length });

    return reply;
  } catch (error) {
    logger.error('Chat completion error:', error);
    throw new Error('AI chat failed');
  }
}
