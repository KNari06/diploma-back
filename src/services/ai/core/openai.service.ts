import { buildChatSystemPrompt } from '@/ai/prompts/index';
import { env } from '@/config/environment/env';
import { AI_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { OpenAI } from 'openai';
import { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import { AIUsageTracker, calculateOpenAICost } from '../tracking/ai-usage-tracker';
import { recordAILog } from '../logging/ai-action-logger';
import { persistLLMCall } from '../logging/llm-io-persistence';

/**
 * ✅ FIX: Configure OpenAI client with timeout and retry settings
 * - timeout: 60s (prevents hanging requests)
 * - maxRetries: 2 (retry failed requests)
 * - Must be less than server.timeout (180s) to allow proper error handling
 *
 * ⚠️ PROD INCIDENT FIX (ERR_STREAM_PREMATURE_CLOSE):
 * The openai SDK v4 prefers a hoisted `node-fetch@2` (a transitive dep) over the
 * runtime's native fetch. On prod (Node 22, behind the container network)
 * node-fetch@2's gzip stream (Gunzip) tears down mid-response — EVERY OpenAI
 * call (chat + embeddings) failed with `ERR_STREAM_PREMATURE_CLOSE`, so chat
 * returned the generic fallback on every message. Forcing the SDK to use Node
 * 22's native fetch (undici) — which handles compressed-stream teardown
 * correctly — sidesteps node-fetch entirely. `globalThis.fetch` exists on Node
 * 18+; we guard so a hypothetical older runtime still falls back to the SDK's
 * default. Native undici also keeps connections alive more reliably.
 */
const _nativeFetch: typeof fetch | undefined =
  typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

const _rawOpenai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 60000, // 60 seconds
  maxRetries: 2, // Retry up to 2 times on failure
  ...(_nativeFetch ? { fetch: _nativeFetch } : {}),
});

/**
 * V13: Singleton OpenAI client with API-compat proxy.
 *
 * Intercepts `chat.completions.create` to automatically normalize
 * deprecated or renamed parameters so that callers across the codebase
 * don't need to track OpenAI API changes individually.
 *
 * Current normalizations:
 *   • `max_tokens` → `max_completion_tokens` (required for gpt-5.x models)
 *
 * Any future breaking parameter rename gets added here ONCE and all
 * callers — both through the wrapper and direct SDK calls — are fixed.
 */
function createOpenAIProxy(client: OpenAI): OpenAI {
  const originalCreate = client.chat.completions.create.bind(client.chat.completions);

  client.chat.completions.create = ((params: any, ...rest: any[]) => {
    // Normalize max_tokens → max_completion_tokens
    if (params && 'max_tokens' in params && !('max_completion_tokens' in params)) {
      params.max_completion_tokens = params.max_tokens;
      delete params.max_tokens;
    }
    return originalCreate(params, ...rest);
  }) as typeof client.chat.completions.create;

  return client;
}

const openai = createOpenAIProxy(_rawOpenai);

/**
 * Get the shared, proxy-wrapped OpenAI client.
 * All files that need direct SDK access should import this instead of
 * creating their own `new OpenAI()` instance.
 */
export function getSharedOpenAIClient(): OpenAI {
  return openai;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * V21: Invalid-model graceful fallback
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Some deployments use a custom model alias (e.g. `gpt-5.4-mini`) that the
 * configured `OPENAI_API_KEY` may not have access to on every environment.
 * On such environments OpenAI returns:
 *
 *   400 invalid_request_error — "invalid model ID"
 *
 * The previous behaviour: every preview lint request fails → element-resolver
 * circuit breaker opens after 3 fails → ALL preview linting drops to the
 * rule-based fallback (catastrophic accuracy regression on dev.qait.dev,
 * confirmed in logs).
 *
 * The fix: when we see a 400 invalid-model error, transparently retry the
 * SAME request once with a known-good fallback model (`gpt-4.1-mini` — a
 * long-lived, widely-available OpenAI model, chosen precisely BECAUSE it is not
 * whatever the env currently points at: a fallback that tracked the configured
 * model would fall back onto the same broken value). The
 * retry result is returned to the caller as if the
 * primary model had succeeded — the circuit breaker never triggers, accuracy
 * is preserved, and prod (where the primary model works) is unaffected
 * because the fallback never activates there.
 *
 * To avoid wasting latency retrying the same broken model on every call, we
 * remember which model IDs returned invalid-model in this process and skip
 * straight to the fallback for them. The set is in-memory per process — it
 * resets on restart, which is the right behaviour if the model becomes
 * available again later.
 */
/**
 * DO NOT set this to the configured model (`AI_MODELS.smart` / `.fast`).
 *
 * The retry below is guarded by `effectiveModel !== FALLBACK_MODEL` so it can
 * never loop. Point this at the configured model and that guard is permanently
 * false: the fallback stops firing entirely, tests stay green, and prod quietly
 * loses the safety net that keeps the element-resolver circuit breaker shut.
 *
 * It also has to be a model present in `AI_PRICING` / `MODEL_PRICING`, or a
 * fallback request is costed at the wrong rate — which rules out simply picking
 * another nano/mini id. gpt-4.1-mini satisfies both: distinct from the
 * configured model, and priced.
 */
const FALLBACK_MODEL = 'gpt-4.1-mini';
const knownInvalidModels = new Set<string>();

/**
 * Detects an OpenAI "invalid model ID" 400 response. Matches both the SDK's
 * structured error shape and the raw error message to be resilient against
 * SDK upgrades that change error wrapping.
 *
 * IMPORTANT: every match condition requires the word "model" to appear in the
 * message. This prevents false positives like "User does not exist" or
 * "Assistant {id} does not exist" — both of which can also return 400 from the
 * OpenAI API but have nothing to do with model availability and must NOT
 * trigger the model fallback path.
 */
function isInvalidModelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: number; type?: string; message?: string };
  if (e.status !== 400) return false;
  const msg = (e.message || '').toLowerCase();
  if (!msg.includes('model')) return false; // hard guard: never fire without "model"
  return (
    msg.includes('invalid model') ||
    msg.includes('model not found') ||
    msg.includes('model_not_found') ||
    msg.includes('does not exist') ||
    (e.type === 'invalid_request_error' && msg.includes('invalid'))
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface OpenAIResponse {
  content: string;
  tool_calls?: ChatCompletionMessageToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string;
    /**
     * Subset of inputTokens OpenAI served from its automatic prompt cache
     * (`usage.prompt_tokens_details.cached_tokens`). Present only for OpenAI
     * responses; undefined for providers that don't report it (e.g. Gemini).
     */
    cachedInputTokens?: number;
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
    model?: string;
    abortSignal?: AbortSignal;
    tools?: ChatCompletionTool[];
    tool_choice?: 'auto' | 'none' | 'required';
    // Reasoning effort for gpt-5.x / o-series models.
    // 'low' drastically reduces hidden chain-of-thought tokens → faster, cheaper,
    // more predictable latency on short classification-style tasks
    // (e.g. element disambiguation). Ignored for non-reasoning models.
    reasoning_effort?: 'low' | 'medium' | 'high';
  }
): Promise<OpenAIResponse> {
  const _aiLogStartedAt = Date.now();
  try {
    // Validate input
    if (!messages || messages.length === 0) {
      throw new Error('Messages array cannot be empty');
    }

    const model = options?.model || AI_MODELS.fast;

    if (options?.abortSignal?.aborted) {
      throw new Error('Request was cancelled. Please try again.');
    }

    const abortPromise = options?.abortSignal
      ? new Promise<never>((_, reject) => {
          options.abortSignal!.addEventListener(
            'abort',
            () => reject(new Error('Request was cancelled. Please try again.')),
            { once: true }
          );
        })
      : null;

    // Auto-route Gemini models to Gemini SDK.
    // Note: Gemini SDK has its own internal `timeout` (default 30s) but does NOT
    // accept an AbortSignal. We race the Gemini call against our external
    // abortPromise so callers' AbortController timeouts actually fire for Gemini
    // too (element-resolver needs this — without it a hung Gemini call would
    // block the caller for 30s instead of the intended 7s).
    if (model.startsWith('gemini-')) {
      const { getChatCompletionWithGemini } = await import('./gemini.service');
      const geminiMessages = messages.map(m => ({
        role: (m.role === 'tool' ? 'user' : m.role) as 'user' | 'assistant' | 'system',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
      // V23: pass the AbortSignal directly to the SDK. The Promise.race
      // wrapper still runs (catches the case where signal abort fails to
      // propagate through Google's fetch), but real cancellation now goes
      // through the SDK and closes the underlying HTTP connection.
      const geminiPromise = getChatCompletionWithGemini({
        messages: geminiMessages,
        model: model as any,
        temperature: options?.temperature,
        maxTokens: options?.max_tokens,
        jsonMode: !!options?.response_format,
        timeout: (options as any)?.timeout,
        signal: options?.abortSignal,
      });
      const response = abortPromise
        ? await Promise.race([geminiPromise, abortPromise])
        : await geminiPromise;
      return { content: response.content, usage: response.usage };
    }

    const maxTokensValue = options?.max_tokens || env.OPENAI_MAX_TOKENS || 1000;

    // V21: If we've already learned the requested model is invalid in this
    // process, skip straight to the fallback to save a round-trip.
    const effectiveModel = knownInvalidModels.has(model) ? FALLBACK_MODEL : model;
    if (effectiveModel !== model) {
      logger.debug('[OPENAI] Skipping known-invalid model, using fallback', {
        requestedModel: model,
        fallbackModel: effectiveModel,
      });
    }

    // Helper that issues a single chat.completions.create call. Pulled out so
    // the invalid-model fallback below can re-issue with a different model
    // without duplicating the parameter list.
    // reasoning_effort is only sent for reasoning-capable models (gpt-5.x, o-series).
    // Older chat models reject it as unknown param, so we gate it by model name.
    // When we do send reasoning_effort, the endpoint enforces reasoning-model rules,
    // which reject custom temperature (only default=1 allowed). We drop temperature
    // ONLY in that case; without reasoning_effort the existing temperature behaviour
    // stays untouched for the other 140+ call sites.
    const isReasoningModel = (m: string) => /^(gpt-5|o\d)/i.test(m);
    const issueRequest = (modelToUse: string) => {
      const sendReasoningEffort = !!options?.reasoning_effort && isReasoningModel(modelToUse);
      return openai.chat.completions.create({
        model: modelToUse,
        messages,
        max_completion_tokens: maxTokensValue,
        ...(sendReasoningEffort ? {} : { temperature: options?.temperature ?? 0.5 }),
        ...(options?.response_format && { response_format: options.response_format }),
        ...(options?.tools && { tools: options.tools }),
        ...(options?.tool_choice && { tool_choice: options.tool_choice }),
        ...(sendReasoningEffort ? { reasoning_effort: options!.reasoning_effort } : {}),
      });
    };

    let response;
    // V21: Track which model was ACTUALLY used in the successful call. Logs,
    // cost tracking and the response.usage.model field downstream all use
    // this variable (not the originally-requested `model`) so accounting and
    // observability stay accurate after a fallback.
    let actualModel = effectiveModel;
    try {
      const requestPromise = issueRequest(effectiveModel);
      response = abortPromise
        ? await Promise.race([requestPromise, abortPromise])
        : await requestPromise;
    } catch (firstError: unknown) {
      // V21: Invalid-model graceful fallback. If the configured model isn't
      // available on this OPENAI_API_KEY (e.g. dev key vs prod key with
      // different beta access), retry once on FALLBACK_MODEL so the caller
      // gets a real result instead of bricking the element-resolver circuit
      // breaker. We only attempt this when the failed call wasn't already on
      // FALLBACK_MODEL — otherwise we'd loop.
      if (isInvalidModelError(firstError) && effectiveModel !== FALLBACK_MODEL) {
        knownInvalidModels.add(effectiveModel);
        logger.warn('[OPENAI] Model rejected as invalid — retrying on fallback', {
          rejectedModel: effectiveModel,
          fallbackModel: FALLBACK_MODEL,
          message: (firstError as { message?: string })?.message,
        });
        const retryPromise = issueRequest(FALLBACK_MODEL);
        response = abortPromise
          ? await Promise.race([retryPromise, abortPromise])
          : await retryPromise;
        actualModel = FALLBACK_MODEL;
      } else {
        throw firstError;
      }
    }

    // Validate response structure
    if (!response.choices || response.choices.length === 0) {
      logger.error('[OPENAI] No choices in response', { model: actualModel, messageCount: messages.length });
      throw new Error('No response choices from OpenAI');
    }

    const message = response.choices[0]?.message;
    const reply = message?.content || '';
    const toolCalls = message?.tool_calls;

    // When tools are used, content can be null (tool_calls present instead)
    if (!reply && !toolCalls?.length) {
      logger.error('[OPENAI] Empty content in response (no tool calls either)', {
        model: actualModel,
        messageCount: messages.length,
        finishReason: response.choices[0]?.finish_reason,
      });
      throw new Error('Empty response content from OpenAI');
    }

    const usage = response.usage;
    if (!usage) {
      logger.warn('[OPENAI] No usage data in response', { model: actualModel });
    }

    // OpenAI automatic prompt caching: the portion of the input prompt served
    // from cache (identical ≥1024-token prefix seen recently). Billed cheaper.
    const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens || 0;

    logger.info('[OPENAI] Chat completion with messages successful', {
      model: actualModel,
      requestedModel: model !== actualModel ? model : undefined,
      messageCount: messages.length,
      replyLength: reply.length,
      hasToolCalls: !!toolCalls?.length,
      toolCallCount: toolCalls?.length || 0,
      inputTokens: usage?.prompt_tokens || 0,
      cachedInputTokens,
      outputTokens: usage?.completion_tokens || 0,
      totalTokens: usage?.total_tokens || 0,
    });

    const result: OpenAIResponse = {
      content: reply,
      tool_calls: toolCalls,
      usage: {
        inputTokens: usage?.prompt_tokens || 0,
        outputTokens: usage?.completion_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
        model: actualModel,
        cachedInputTokens,
      },
    };

    // Track AI usage for billing/analytics — bill against the model that
    // actually served the request, not the one originally requested.
    const aiCostUSD = calculateOpenAICost(actualModel, result.usage.inputTokens, result.usage.outputTokens, cachedInputTokens);
    AIUsageTracker.record({
      provider: 'openai',
      model: actualModel,
      inputTokens: result.usage.inputTokens,
      cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      costUSD: aiCostUSD,
      timestamp: Date.now(),
    });

    recordAILog({
      status: 'succeeded',
      provider: 'openai',
      model: actualModel,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: aiCostUSD,
      durationMs: Date.now() - _aiLogStartedAt,
      detail: {
        message_count: messages.length,
        reply_length: reply.length,
        tool_call_count: toolCalls?.length ?? 0,
        cached_input_tokens: cachedInputTokens,
        requested_model: model !== actualModel ? model : undefined,
        response_excerpt: reply,
      },
    });

    // Full redacted prompt+completion store (opt-in, off by default).
    persistLLMCall({
      provider: 'openai',
      model: actualModel,
      status: 'succeeded',
      prompt: messages,
      completion: reply,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      durationMs: Date.now() - _aiLogStartedAt,
    });

    return result;
  } catch (error: unknown) {
    // Handle abort signal errors (client closed connection, timeout, etc.)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error as any)?.code;
    const errorStatus = (error as any)?.status;
    const errorType = (error as any)?.type;

    recordAILog({
      status: 'failed',
      provider: 'openai',
      model: options?.model || AI_MODELS.fast,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      durationMs: Date.now() - _aiLogStartedAt,
      error: errorMessage,
      detail: { code: errorCode, status: errorStatus, type: errorType, message_count: messages?.length ?? 0 },
    });

    // Persist the failed call too — a hallucination/timeout on a specific
    // prompt is exactly what we want to inspect later.
    persistLLMCall({
      provider: 'openai',
      model: options?.model || AI_MODELS.fast,
      status: 'failed',
      prompt: messages,
      errorMessage,
      durationMs: Date.now() - _aiLogStartedAt,
    });

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
    // Preserve HTTP status/code for callers to make retry decisions
    const enrichedError = new Error(`AI chat failed: ${errorMessage}`);
    (enrichedError as any).status = errorStatus;
    (enrichedError as any).code = errorCode;
    throw enrichedError;
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
  const _aiLogStartedAt = Date.now();
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

    const model = AI_MODELS.fast;

    const response = await openai.chat.completions.create({
      model,
      messages,
      max_completion_tokens: env.OPENAI_MAX_TOKENS || 1000,
      temperature: 0.5,
    });

    const reply = response.choices[0]?.message?.content || '🤖 Could not understand the request.';
    const usage = response.usage;
    const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens || 0;

    logger.info('[OPENAI] Chat completion successful', {
      model,
      promptLength: prompt.length,
      replyLength: reply.length,
      inputTokens: usage?.prompt_tokens || 0,
      cachedInputTokens,
      outputTokens: usage?.completion_tokens || 0,
      totalTokens: usage?.total_tokens || 0,
    });

    const result: OpenAIResponse = {
      content: reply,
      usage: {
        inputTokens: usage?.prompt_tokens || 0,
        outputTokens: usage?.completion_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
        model,
        cachedInputTokens,
      },
    };

    // Track AI usage for billing/analytics
    const aiCostUSD = calculateOpenAICost(model, result.usage.inputTokens, result.usage.outputTokens, cachedInputTokens);
    AIUsageTracker.record({
      provider: 'openai',
      model,
      inputTokens: result.usage.inputTokens,
      cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      costUSD: aiCostUSD,
      timestamp: Date.now(),
    });

    recordAILog({
      status: 'succeeded',
      provider: 'openai',
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: aiCostUSD,
      durationMs: Date.now() - _aiLogStartedAt,
      detail: {
        prompt_excerpt: prompt,
        response_excerpt: reply,
      },
    });

    return result;
  } catch (error: any) {
    recordAILog({
      status: 'failed',
      provider: 'openai',
      model: AI_MODELS.fast,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      durationMs: Date.now() - _aiLogStartedAt,
      error: error instanceof Error ? error.message : String(error),
      detail: { prompt_excerpt: prompt },
    });

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
