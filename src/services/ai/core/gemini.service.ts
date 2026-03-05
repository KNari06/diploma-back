import { GoogleGenerativeAI, type Part } from '@google/generative-ai';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { AIUsageTracker, calculateGeminiCost } from '../tracking/ai-usage-tracker';

/**
 * Gemini AI Service
 * Fast, multilingual text generation using Google Gemini 2.5 Flash
 */

let genAI: GoogleGenerativeAI | null = null;

/**
 * Initialize Gemini client lazily
 */
function getGeminiClient(): GoogleGenerativeAI {
  if (!genAI) {
    if (!env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured in environment');
    }
    genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }
  return genAI;
}

/**
 * Gemini response with usage tracking
 */
export interface GeminiResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string;
  };
}

/**
 * Generate text with Gemini (simple prompt → text)
 * Best for: keyword extraction, classification, simple Q&A
 */
export async function generateTextWithGemini(params: {
  prompt: string;
  model?: 'gemini-2.5-flash' | 'gemini-2.5-pro' | 'gemini-2.0-flash-exp' | 'gemini-2.5-flash-lite';
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  jsonMode?: boolean;
}): Promise<GeminiResponse> {
  const {
    prompt,
    model = 'gemini-2.5-flash',
    temperature = 0,
    maxTokens = 100,
    timeout = 5000,
    jsonMode = false,
  } = params;

  try {
    const client = getGeminiClient();
    const genModel = client.getGenerativeModel({
      model,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        ...(jsonMode && { responseMimeType: 'application/json' }),
      },
    });

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini request timeout')), timeout);
    });

    // Race between generation and timeout
    const resultPromise = genModel.generateContent(prompt);
    const genResult = await Promise.race([resultPromise, timeoutPromise]);

    const response = genResult.response;
    const text = response.text();

    // Extract token usage (Gemini provides this in response metadata)
    const usage = response.usageMetadata || {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    };

    const result: GeminiResponse = {
      content: text,
      usage: {
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0,
        model,
      },
    };

    // Track AI usage for billing/analytics
    AIUsageTracker.record({
      provider: 'gemini',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      costUSD: calculateGeminiCost(model, result.usage.inputTokens, result.usage.outputTokens),
      timestamp: Date.now(),
    });

    return result;
  } catch (error) {
    logger.error('[GEMINI] Text generation failed', {
      error: error instanceof Error ? error.message : String(error),
      model,
      promptLength: prompt.length,
    });
    throw error;
  }
}

/**
 * Generate chat completion with Gemini (messages array)
 * Compatible with OpenAI-style messages
 */
export async function getChatCompletionWithGemini(params: {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  model?: 'gemini-2.5-flash' | 'gemini-2.5-pro' | 'gemini-2.0-flash-exp' | 'gemini-2.5-flash-lite';
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  jsonMode?: boolean;
}): Promise<GeminiResponse> {
  const {
    messages,
    model = 'gemini-2.5-flash',
    temperature = 0,
    maxTokens = 1000,
    timeout = 10000,
    jsonMode = false,
  } = params;

  try {
    const client = getGeminiClient();
    const genModel = client.getGenerativeModel({
      model,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        ...(jsonMode && { responseMimeType: 'application/json' }),
      },
    });

    // Convert OpenAI-style messages to Gemini format
    // Gemini uses: system instruction + chat history
    let systemInstruction = '';
    const chatHistory: Array<{ role: 'user' | 'model'; parts: [{ text: string }] }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += msg.content + '\n';
      } else if (msg.role === 'user') {
        chatHistory.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === 'assistant') {
        chatHistory.push({
          role: 'model',
          parts: [{ text: msg.content }],
        });
      }
    }

    // Start chat with history
    const chat = genModel.startChat({
      history: chatHistory.slice(0, -1), // All except last message
      systemInstruction,
    });

    // Get last user message
    const lastMessage = chatHistory[chatHistory.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
      throw new Error('Last message must be from user');
    }

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini request timeout')), timeout);
    });

    // Send last message and get response
    const resultPromise = chat.sendMessage(lastMessage.parts[0].text);
    const genResult = await Promise.race([resultPromise, timeoutPromise]);

    const response = genResult.response;
    const text = response.text();

    const usage = response.usageMetadata || {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    };

    const result: GeminiResponse = {
      content: text,
      usage: {
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0,
        model,
      },
    };

    // Track AI usage for billing/analytics
    AIUsageTracker.record({
      provider: 'gemini',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      costUSD: calculateGeminiCost(model, result.usage.inputTokens, result.usage.outputTokens),
      timestamp: Date.now(),
    });

    return result;
  } catch (error) {
    logger.error('[GEMINI] Chat completion failed', {
      error: error instanceof Error ? error.message : String(error),
      model,
      messageCount: messages.length,
    });
    throw error;
  }
}

/**
 * Generate text with Gemini Vision (multimodal: image + text → text)
 * Sends a screenshot (base64) alongside a text prompt for visual element analysis.
 *
 * Best for: element identification by visual appearance, screenshot-based disambiguation,
 * visual verification of healed selectors.
 */
export async function generateTextWithGeminiVision(params: {
  prompt: string;
  imageBase64: string;
  mimeType?: 'image/png' | 'image/jpeg';
  model?: 'gemini-2.5-flash' | 'gemini-2.5-pro' | 'gemini-2.0-flash-exp' | 'gemini-2.5-flash-lite';
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}): Promise<GeminiResponse> {
  const {
    prompt,
    imageBase64,
    mimeType = 'image/png',
    model = 'gemini-2.0-flash-exp',
    temperature = 0,
    maxTokens = 300,
    timeout = 8000,
  } = params;

  if (!imageBase64 || imageBase64.length === 0) {
    throw new Error('imageBase64 is required for vision requests');
  }

  try {
    const client = getGeminiClient();
    const genModel = client.getGenerativeModel({
      model,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    });

    // Build multimodal content: image + text
    const parts: Part[] = [
      {
        inlineData: {
          mimeType,
          data: imageBase64,
        },
      },
      {
        text: prompt,
      },
    ];

    // Create timeout promise (unref to avoid keeping event loop alive)
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Gemini vision request timeout')), timeout);
      (timeoutId as any)?.unref?.();
    });

    const resultPromise = genModel.generateContent(parts);

    let genResult;
    try {
      genResult = await Promise.race([resultPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    const response = genResult.response;
    const text = response.text();

    const usage = response.usageMetadata || {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    };

    const result: GeminiResponse = {
      content: text,
      usage: {
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0,
        model,
      },
    };

    // Track AI usage for billing/analytics
    AIUsageTracker.record({
      provider: 'gemini',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      costUSD: calculateGeminiCost(model, result.usage.inputTokens, result.usage.outputTokens),
      timestamp: Date.now(),
    });

    logger.info('[GEMINI] Vision generation completed', {
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      imageSize: `${(imageBase64.length / 1024).toFixed(1)}KB`,
    });

    return result;
  } catch (error) {
    logger.error('[GEMINI] Vision generation failed', {
      error: error instanceof Error ? error.message : String(error),
      model,
      promptLength: prompt.length,
      imageSize: `${(imageBase64.length / 1024).toFixed(1)}KB`,
    });
    throw error;
  }
}
