import { buildChatSystemPrompt } from '@/ai/prompts/index';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * ✅ FIX: Configure OpenAI client with timeout and retry settings
 * - timeout: 60s (prevents hanging requests)
 * - maxRetries: 2 (retry failed requests)
 * - Must be less than server.timeout (180s) to allow proper error handling
 */
const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 60000, // 60 seconds
  maxRetries: 2, // Retry up to 2 times on failure
});

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
    // Validate input
    if (!messages || messages.length === 0) {
      throw new Error('Messages array cannot be empty');
    }

    const model = options?.model || env.OPENAI_MODEL || 'gpt-4o-mini';

    const response = await openai.chat.completions.create({
      model,
      messages,
      max_tokens: options?.max_tokens || env.OPENAI_MAX_TOKENS || 1000,
      temperature: options?.temperature ?? 0.5,
      ...(options?.response_format && { response_format: options.response_format }),
    });

    // Validate response structure
    if (!response.choices || response.choices.length === 0) {
      logger.error('[OPENAI] No choices in response', { model, messageCount: messages.length });
      throw new Error('No response choices from OpenAI');
    }

    const reply = response.choices[0]?.message?.content;
    if (!reply) {
      logger.error('[OPENAI] Empty content in response', {
        model,
        messageCount: messages.length,
        finishReason: response.choices[0]?.finish_reason,
      });
      throw new Error('Empty response content from OpenAI');
    }

    const usage = response.usage;
    if (!usage) {
      logger.warn('[OPENAI] No usage data in response', { model });
    }

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
  } catch (error: unknown) {
    // Handle abort signal errors (client closed connection, timeout, etc.)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error as any)?.code;
    const errorStatus = (error as any)?.status;
    const errorType = (error as any)?.type;

    if (errorMessage.includes('aborted') || errorMessage.includes('signal')) {
      logger.warn('[OPENAI] Request aborted', {
        message: errorMessage,
        code: errorCode,
        type: errorType,
      });
      throw new Error('Request was cancelled. Please try again.');
    }

    // Handle timeout errors
    if (errorMessage.includes('timeout') || errorCode === 'ETIMEDOUT') {
      logger.warn('[OPENAI] Request timeout', {
        message: errorMessage,
        code: errorCode,
      });
      throw new Error('Request took too long. Please try again.');
    }

    // Re-throw validation errors as-is
    if (error instanceof Error && (
      error.message.includes('cannot be empty') ||
      error.message.includes('No response choices') ||
      error.message.includes('Empty response content')
    )) {
      throw error;
    }

    logger.error('[OPENAI] Chat completion with messages error:', {
      message: errorMessage,
      code: errorCode,
      status: errorStatus,
      type: errorType,
      stack: error instanceof Error ? error.stack : undefined,
    });
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
  } catch (error: any) {
    // Handle abort signal errors (client closed connection, timeout, etc.)
    if (error?.message?.includes('aborted') || error?.message?.includes('signal')) {
      logger.warn('[OPENAI] Request aborted', {
        message: error.message,
        code: error.code,
        type: error.type,
      });
      throw new Error('Request was cancelled. Please try again.');
    }

    // Handle timeout errors
    if (error?.message?.includes('timeout') || error?.code === 'ETIMEDOUT') {
      logger.warn('[OPENAI] Request timeout', {
        message: error.message,
        code: error.code,
      });
      throw new Error('Request took too long. Please try again.');
    }

    logger.error('[OPENAI] Chat completion error:', {
      message: error instanceof Error ? error.message : String(error),
      code: error?.code,
      status: error?.status,
      type: error?.type,
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new Error('AI chat failed');
  }
}
