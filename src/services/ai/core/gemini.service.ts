import { GoogleGenerativeAI, type Part } from '@google/generative-ai';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { AIUsageTracker, calculateGeminiCost } from '../tracking/ai-usage-tracker';
import { recordAILog } from '../logging/ai-action-logger';
import { persistLLMCall } from '../logging/llm-io-persistence';

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
  model?: 'gemini-2.5-flash' | 'gemini-2.5-pro' | 'gemini-2.5-flash-lite';
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  jsonMode?: boolean;
  /** V23: see `getChatCompletionWithGemini.signal` for rationale. */
  signal?: AbortSignal;
}): Promise<GeminiResponse> {
  const {
    prompt,
    model = 'gemini-2.5-flash',
    temperature = 0,
    maxTokens = 100,
    timeout = 5000,
    jsonMode = false,
    signal,
  } = params;

  const _aiLogStartedAt = Date.now();
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

    if (signal?.aborted) {
      throw new Error('Gemini request aborted before send');
    }

    // V23: forward signal to SDK for real cancellation; timeout stays as cap.
    const resultPromise = genModel.generateContent(prompt, signal ? { signal } : undefined);
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Gemini request timeout')), timeout);
      (timeoutId as any)?.unref?.();
    });
    let genResult;
    try {
      genResult = await Promise.race([resultPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

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
    const aiCostUSD = calculateGeminiCost(model, result.usage.inputTokens, result.usage.outputTokens);
    AIUsageTracker.record({
      provider: 'gemini',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      costUSD: aiCostUSD,
      timestamp: Date.now(),
    });

    recordAILog({
      status: 'succeeded',
      provider: 'gemini',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: aiCostUSD,
      durationMs: Date.now() - _aiLogStartedAt,
      detail: { prompt_excerpt: prompt, response_excerpt: text },
    });

    persistLLMCall({
      provider: 'gemini',
      model,
      status: 'succeeded',
      prompt,
      completion: text,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      durationMs: Date.now() - _aiLogStartedAt,
    });

    return result;
  } catch (error) {
    recordAILog({
      status: 'failed',
      provider: 'gemini',
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      durationMs: Date.now() - _aiLogStartedAt,
      error: error instanceof Error ? error.message : String(error),
      detail: { prompt_excerpt: prompt },
    });
    persistLLMCall({
      provider: 'gemini',
      model,
      status: 'failed',
      prompt,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - _aiLogStartedAt,
    });
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
  model?: 'gemini-2.5-flash' | 'gemini-2.5-pro' | 'gemini-2.5-flash-lite';
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  jsonMode?: boolean;
  /**
   * V23 (April 2026): real cancellation. Prior to this, callers wrapped the
   * call in `Promise.race([gemini, abortPromise])`, which only stopped
   * waiting — the underlying fetch to Google API kept running until natural
   * completion (observed: 19.8s requests after a 7s "abort"). The SDK's
   * `SingleRequestOptions.signal` actually aborts the HTTP request, freeing
   * the connection and letting the circuit breaker count the failure
   * accurately.
   *
   * NOTE per SDK docs: aborting a Gemini request is client-only — Google
   * still bills for the work it already started. We accept this; the cost
   * matters less than freeing the caller and the connection.
   */
  signal?: AbortSignal;
}): Promise<GeminiResponse> {
  const {
    messages,
    model = 'gemini-2.5-flash',
    temperature = 0,
    maxTokens = 1000,
    timeout = 30000,
    jsonMode = false,
    signal,
  } = params;

  const _aiLogStartedAt = Date.now();
  try {
    const client = getGeminiClient();
    // Extract system instruction and chat messages
    let systemInstruction = '';
    const chatHistory: Array<{ role: 'user' | 'model'; parts: [{ text: string }] }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += msg.content + '\n';
      } else if (msg.role === 'user') {
        chatHistory.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (msg.role === 'assistant') {
        chatHistory.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }

    const genModel = client.getGenerativeModel({
      model,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        ...(jsonMode && { responseMimeType: 'application/json' }),
      },
    });

    // Prepend system instruction as context in the first user message
    // (Gemini SDK doesn't reliably support systemInstruction in all versions)
    if (systemInstruction.trim() && chatHistory.length > 0 && chatHistory[0].role === 'user') {
      chatHistory[0] = {
        role: 'user',
        parts: [{ text: `${systemInstruction.trim()}\n\n${chatHistory[0].parts[0].text}` }],
      };
    } else if (systemInstruction.trim()) {
      chatHistory.unshift({ role: 'user', parts: [{ text: systemInstruction.trim() }] });
    }

    // Get last user message to send via sendMessage()
    const lastMessage = chatHistory[chatHistory.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
      throw new Error('Last message must be from user');
    }

    // Build history (all except last), ensuring starts with 'user' role
    let history = chatHistory.slice(0, -1);
    while (history.length > 0 && history[0].role !== 'user') {
      history = history.slice(1);
    }

    const chat = genModel.startChat({ history });

    // V23: forward AbortSignal to the SDK so cancellation reaches the network
    // layer, not just the await wrapper. The SDK's SingleRequestOptions.signal
    // closes the HTTP connection on abort. We KEEP the timeout promise as a
    // belt-and-suspenders guard for the case where signal isn't supplied
    // OR the SDK's abort path is broken in a future version.
    //
    // Fast-fail when signal is already aborted before the call — saves a
    // round-trip and a useless billed token count.
    if (signal?.aborted) {
      throw new Error('Gemini request aborted before send');
    }

    const sendOptions = signal ? { signal } : undefined;
    const resultPromise = chat.sendMessage(lastMessage.parts[0].text, sendOptions);

    // Timeout promise still races as a hard ceiling. When SDK signal works
    // (V23+), cancellation arrives via the abort path; this remains as a
    // last-resort cap if both signal AND SDK time out.
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Gemini request timeout')), timeout);
      (timeoutId as any)?.unref?.();
    });
    let genResult;
    try {
      genResult = await Promise.race([resultPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    const response = genResult.response;
    const text = response.text();

    // Surface non-STOP finish reasons as explicit errors instead of silently
    // returning empty text. Observed: MAX_TOKENS and SAFETY produce empty text
    // which downstream parsers mistake for "invalid response", masking the
    // real cause. Typical fix: raise maxOutputTokens or soften the prompt.
    const finishReason = response.candidates?.[0]?.finishReason;
    if (!text && finishReason && finishReason !== 'STOP') {
      throw new Error(`Gemini returned empty response (finishReason=${finishReason})`);
    }

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
    const aiCostUSD = calculateGeminiCost(model, result.usage.inputTokens, result.usage.outputTokens);
    AIUsageTracker.record({
      provider: 'gemini',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      costUSD: aiCostUSD,
      timestamp: Date.now(),
    });

    recordAILog({
      status: 'succeeded',
      provider: 'gemini',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: aiCostUSD,
      durationMs: Date.now() - _aiLogStartedAt,
      detail: { message_count: messages.length, response_excerpt: text },
    });

    persistLLMCall({
      provider: 'gemini',
      model,
      status: 'succeeded',
      prompt: messages.map((m) => `[${m.role}] ${m.content}`).join('\n'),
      completion: text,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      durationMs: Date.now() - _aiLogStartedAt,
    });

    return result;
  } catch (error) {
    recordAILog({
      status: 'failed',
      provider: 'gemini',
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      durationMs: Date.now() - _aiLogStartedAt,
      error: error instanceof Error ? error.message : String(error),
      detail: { message_count: messages.length },
    });
    persistLLMCall({
      provider: 'gemini',
      model,
      status: 'failed',
      prompt: messages.map((m) => `[${m.role}] ${m.content}`).join('\n'),
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - _aiLogStartedAt,
    });
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
  model?: 'gemini-2.5-flash' | 'gemini-2.5-pro' | 'gemini-2.5-flash-lite';
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  /** V23: see `getChatCompletionWithGemini.signal` for rationale. */
  signal?: AbortSignal;
}): Promise<GeminiResponse> {
  const {
    prompt,
    imageBase64,
    mimeType = 'image/png',
    model = 'gemini-2.5-flash',
    temperature = 0,
    maxTokens = 300,
    timeout = 8000,
    signal,
  } = params;

  if (!imageBase64 || imageBase64.length === 0) {
    throw new Error('imageBase64 is required for vision requests');
  }

  const _aiLogStartedAt = Date.now();
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

    if (signal?.aborted) {
      throw new Error('Gemini vision request aborted before send');
    }
    const resultPromise = genModel.generateContent(parts, signal ? { signal } : undefined);

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
    const aiCostUSD = calculateGeminiCost(model, result.usage.inputTokens, result.usage.outputTokens);
    AIUsageTracker.record({
      provider: 'gemini',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      costUSD: aiCostUSD,
      timestamp: Date.now(),
    });

    recordAILog({
      status: 'succeeded',
      provider: 'gemini',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: aiCostUSD,
      durationMs: Date.now() - _aiLogStartedAt,
      detail: { prompt_excerpt: prompt, response_excerpt: text, has_image: true },
    });

    logger.info('[GEMINI] Vision generation completed', {
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      imageSize: `${(imageBase64.length / 1024).toFixed(1)}KB`,
    });

    return result;
  } catch (error) {
    recordAILog({
      status: 'failed',
      provider: 'gemini',
      model,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      durationMs: Date.now() - _aiLogStartedAt,
      error: error instanceof Error ? error.message : String(error),
      detail: { prompt_excerpt: prompt, has_image: true },
    });
    logger.error('[GEMINI] Vision generation failed', {
      error: error instanceof Error ? error.message : String(error),
      model,
      promptLength: prompt.length,
      imageSize: `${(imageBase64.length / 1024).toFixed(1)}KB`,
    });
    throw error;
  }
}
