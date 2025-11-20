import { buildIntentPrompt, IntentParserContext } from '@/ai/prompts/index';
import { env } from '@/config/env';
import { detectUserApproval, extractUrlWithGPT } from '@/services/ai/ai-helpers.service';
import { detectLanguage, searchKB } from '@/services/kb/kb.service';
import { RulesCacheService } from '@/services/kb/rules-cache.service';
import { IntentResult, IntentType, KNOWN_INTENTS } from '@/types';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONSTANTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// FIX #2: Centralized validation constants
const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;
const VALID_SCOPES = ['full', 'page', 'element', 'flow', 'form', 'auth', 'navigation'] as const;
const VALID_INTENTS = ['platform_test', 'api_test', 'general_chat'] as const;

// Cache configuration
const CACHE_TTL = 60000; // 1 minute
const MAX_CACHE_SIZE = 500; // Maximum cache entries to prevent memory leak

// Timeout configuration
const RAG_TIMEOUT = 5000; // 5 seconds for KB search
const GPT_TIMEOUT = 10000; // 10 seconds for GPT parsing

// Metrics reset interval
const METRICS_RESET_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Intent cache for avoiding duplicate RAG calls
const intentCache = new Map<string, { result: IntentResult; timestamp: number }>();

// FIX #9: Periodic cache cleanup to prevent memory leak
// Clean up expired cache entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [key, value] of intentCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      intentCache.delete(key);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.info('[INTENT_CACHE] Cleaned up expired entries', {
      cleaned: cleanedCount,
      remaining: intentCache.size,
    });
  }
}, 300000); // 5 minutes

/**
 * Timeout helper for Promise.race
 */
const withTimeout = <T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMsg)), ms)
    ),
  ]);
};

/**
 * FIX #9: Safe cache setter with size limit
 * Prevents memory leak by enforcing MAX_CACHE_SIZE
 */
const setCacheEntry = (key: string, result: IntentResult): void => {
  // If cache is full, remove oldest entry (first entry in Map)
  if (intentCache.size >= MAX_CACHE_SIZE) {
    const firstKey = intentCache.keys().next().value;
    if (firstKey) {
      intentCache.delete(firstKey);
      logger.warn('[INTENT_CACHE] Cache size limit reached, removed oldest entry', {
        removedKey: firstKey.substring(0, 50),
        cacheSize: intentCache.size,
      });
    }
  }

  intentCache.set(key, { result, timestamp: Date.now() });
};

/**
 * Parse user's natural language message into structured intent
 * @param message - User's message
 * @param context - Additional context from RAG, traces, etc.
 * @param projectId - Optional project ID for RAG search
 * @returns Parsed intent result or null if parsing failed
 */
export async function parseUserIntent(
  message: string,
  context?: IntentParserContext,
  projectId?: string
): Promise<IntentResult | null> {
  try {
    // Step 1: Validate and prepare message
    const trimmedMessage = validateAndPrepareMessage(message);
    if (!trimmedMessage) return null;

    // Step 2: Check cache for existing results
    const cacheKey = buildCacheKey(trimmedMessage, projectId);
    const cachedResult = getCachedResult(cacheKey);
    if (cachedResult) return cachedResult;

    // Step 3: Get KB rules context (FAST/SLOW path)
    const { kbRulesContext, kbRulesUsed, userLanguage } = await getKBRulesContext(
      trimmedMessage,
      context,
      projectId
    );

    // Step 4: Parse intent with GPT
    const intentResult = await parseIntentWithGPT(trimmedMessage, kbRulesContext);
    if (!intentResult) {
      logger.warn('[INTENT_PARSER] Initial parse failed');
      return null;
    }

    // Step 5: Calculate confidence and decide next steps
    const confidence = calculateConfidence(intentResult, trimmedMessage);

    // Step 6: Handle high confidence results
    const highConfidenceResult = handleHighConfidenceResult(
      intentResult,
      confidence,
      kbRulesUsed,
      cacheKey,
      userLanguage
    );
    if (highConfidenceResult) return highConfidenceResult;

    // Step 7: Handle low confidence with RAG fallback (FIX #4: pass userLanguage)
    return await handleLowConfidenceWithRAG(
      trimmedMessage,
      context,
      projectId,
      intentResult,
      confidence,
      cacheKey,
      userLanguage
    );

  } catch (error) {
    logger.error('[INTENT_PARSER] Intent parsing failed', { error, message });
    return null;
  }
}

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER METHODS FOR parseUserIntent
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Validate and prepare user message
 */
function validateAndPrepareMessage(message: string): string | null {
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      logger.warn('[INTENT_PARSER] Invalid message', { message });
      return null;
    }

    const trimmedMessage = message.trim();

    logger.info('[INTENT_PARSER] Starting intent parsing', {
      message: trimmedMessage.substring(0, 50),
  });

  return trimmedMessage;
}

/**
 * Build cache key for intent result
 */
function buildCacheKey(message: string, projectId?: string): string {
  return `${message.toLowerCase()}|${projectId || 'global'}`;
}

/**
 * Get cached result if available and not expired
 */
function getCachedResult(cacheKey: string): IntentResult | null {
    const cached = intentCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      logger.info('[INTENT_PARSER] Using cached result', { cacheKey });
      return { ...cached.result };
    }

  return null;
}

/**
 * Get KB rules context using FAST path (cache) or SLOW path (searchKB)
 * FIX #4: Returns userLanguage to avoid re-detection
 */
async function getKBRulesContext(
  trimmedMessage: string,
  context?: IntentParserContext,
  projectId?: string
): Promise<{
  kbRulesContext: IntentParserContext;
  kbRulesUsed: boolean;
  userLanguage: 'en' | 'ru' | 'neutral';
}> {
    let kbRulesContext: IntentParserContext = context || {};
    let kbRulesUsed = false;

  // Detect user language from message (ONLY ONCE!)
  const userLanguage = await detectLanguage(trimmedMessage);

    logger.info('[INTENT_PARSER] Detected user language', {
      language: userLanguage,
      message: trimmedMessage.substring(0, 50),
    });

    try {
      // Try to get rules from cache first (FAST PATH - ~0ms)
    const cachedRules = await getCachedRulesWithFallback(userLanguage);

      if (cachedRules) {
        // Rules found in cache! No need for searchKB()
      kbRulesContext = buildRulesContext(context, cachedRules.content);
        kbRulesUsed = true;

        logger.info('[INTENT_PARSER] Using cached rules (FAST PATH)', {
          language: userLanguage,
        cacheLanguage: cachedRules.language,
        rulesLength: cachedRules.content.length,
          cacheHit: true,
        fallbackUsed: cachedRules.fallbackUsed,
        });
      } else {
        // Fallback to searchKB if cache miss (SLOW PATH - ~200-300ms)
        logger.warn('[INTENT_PARSER] Rules cache miss, falling back to searchKB', {
          language: userLanguage,
        });

        const kbRulesSearch = await withTimeout(
          searchKB(trimmedMessage, projectId, {
            matchCount: 3,
            matchThreshold: 0.5,
            language: userLanguage,
          }),
          RAG_TIMEOUT,
          'KB rules search timeout'
        );

        if (kbRulesSearch.chunks.length > 0) {
          const rulesContext = kbRulesSearch.chunks
            .filter(chunk => chunk.source_file?.includes('rules') || chunk.source_file?.includes('general'))
            .map(chunk => chunk.content)
            .join('\n\n');

          if (rulesContext) {
          kbRulesContext = buildRulesContext(context, rulesContext);
            kbRulesUsed = true;

            logger.info('[INTENT_PARSER] Found KB rules via searchKB (SLOW PATH)', {
              chunksCount: kbRulesSearch.chunks.length,
              sources: kbRulesSearch.sources.global,
              rulesContextLength: rulesContext.length,
              cacheHit: false,
            });
          }
        }
      }
    } catch (error) {
      logger.warn('[INTENT_PARSER] Failed to get rules, continuing without them', { error });
      // Continue without KB rules - not critical
    }

  return { kbRulesContext, kbRulesUsed, userLanguage };
}

/**
 * Build rules context with consistent formatting
 */
function buildRulesContext(
  baseContext?: IntentParserContext,
  rulesContent?: string
): IntentParserContext {
  if (!rulesContent) return baseContext || {};

  return {
    ...baseContext,
    documentation: [
      ...(baseContext?.documentation || []),
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 RESPONSE GUIDELINES FROM KNOWLEDGE BASE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${rulesContent}

IMPORTANT: Follow these guidelines when parsing user intent and generating responses.`,
    ],
  };
}

/**
 * Handle high confidence results (>= 0.7)
 */
function handleHighConfidenceResult(
  intentResult: IntentResult,
  confidence: number,
  kbRulesUsed: boolean,
  cacheKey: string,
  userLanguage: 'en' | 'ru' | 'neutral'
): IntentResult | null {
    logger.info('[INTENT_PARSER] Initial parse confidence', {
      confidence,
      intent: intentResult.intent,
      kbRulesUsed,
    });

    // If confidence is high enough AND we already used KB rules, return immediately
    if (confidence >= 0.7 && kbRulesUsed) {
      logger.info('[INTENT_PARSER] High confidence with KB rules, using standard parse');
      const finalResult = {
        ...intentResult,
        confidence,
        userLanguage, // Include language for downstream use
        metadata: {
          ...intentResult.metadata,
          usedRAG: true,
          kbRulesUsed: true,
        },
      };

      setCacheEntry(cacheKey, finalResult);
      return finalResult;
    }

    // If confidence is high but no KB rules were used, still return (fast path)
    if (confidence >= 0.7 && !kbRulesUsed) {
      logger.info('[INTENT_PARSER] High confidence, using standard parse (no KB rules found)');
      const finalResult = {
        ...intentResult,
        confidence,
        userLanguage, // Include language for downstream use
      };

      setCacheEntry(cacheKey, finalResult);
      return finalResult;
    }

  return null; // Low confidence, need RAG fallback
}

/**
 * Handle low confidence results with RAG fallback
 * FIX #4: Accept userLanguage to avoid re-detection
 */
async function handleLowConfidenceWithRAG(
  trimmedMessage: string,
  context?: IntentParserContext,
  projectId?: string,
  intentResult?: IntentResult,
  confidence?: number,
  cacheKey?: string,
  userLanguage?: 'en' | 'ru' | 'neutral'
): Promise<IntentResult | null> {
  if (!intentResult || confidence === undefined || !cacheKey) {
    return null;
  }

    logger.info('[INTENT_PARSER] Low confidence, using additional RAG fallback');

    try {
    // Search for additional context (FIX #4: use pre-detected language)
      const ragResults = await withTimeout(
        searchKB(trimmedMessage, projectId, {
          matchCount: 5,
          matchThreshold: 0.5, // Lower threshold for better recall
        language: userLanguage || 'neutral',
        }),
        RAG_TIMEOUT,
        'KB search timeout'
      );

      if (ragResults.chunks.length === 0) {
        logger.warn('[INTENT_PARSER] No RAG results, using initial parse');
      return createFallbackResult(intentResult, confidence, cacheKey);
    }

    // Build enhanced context with RAG results
    const enhancedContext = buildEnhancedContext(context, ragResults);

    // Re-parse with enhanced context
    const enhancedResult = await withTimeout(
      parseIntentWithGPT(trimmedMessage, enhancedContext),
      GPT_TIMEOUT,
      'GPT enhanced parsing timeout'
    );

    if (!enhancedResult) {
      logger.warn('[INTENT_PARSER] Enhanced parse failed, using initial');
      return createFallbackResult(intentResult, confidence, cacheKey);
    }

    return createEnhancedResult(
      enhancedResult,
      intentResult,
      confidence,
      ragResults,
      cacheKey,
      trimmedMessage,
      userLanguage
    );

  } catch (ragError) {
    logger.error('[INTENT_PARSER] RAG fallback failed', { ragError });
    return createFallbackResult(intentResult, confidence, cacheKey);
  }
}

/**
 * Build enhanced context with RAG results
 */
function buildEnhancedContext(
  baseContext?: IntentParserContext,
  ragResults?: any
): IntentParserContext {
  if (!ragResults?.chunks?.length) return baseContext || {};

      const ragContext = ragResults.chunks
    .map((chunk: any) => chunk.content)
        .join('\n\n');

  return {
    ...baseContext,
        documentation: [
      ...(baseContext?.documentation || []),
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 SIMILAR EXAMPLES FROM KNOWLEDGE BASE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${ragContext}

Use these examples to better understand the user's intent.`,
        ],
      };
}

/**
 * Create fallback result for failed enhanced parsing
 */
function createFallbackResult(
  intentResult: IntentResult,
  confidence: number,
  cacheKey: string
): IntentResult {
        const fallbackResult = {
          ...intentResult,
          confidence,
        };

        setCacheEntry(cacheKey, fallbackResult);
        return fallbackResult;
      }

/**
 * Create enhanced result with RAG metadata
 */
function createEnhancedResult(
  enhancedResult: IntentResult,
  originalResult: IntentResult,
  originalConfidence: number,
  ragResults: any,
  cacheKey: string,
  trimmedMessage: string,
  userLanguage?: 'en' | 'ru' | 'neutral'
): IntentResult {
      const enhancedConfidence = calculateConfidence(enhancedResult, trimmedMessage);

      logger.info('[INTENT_PARSER] RAG-enhanced parse complete', {
    originalConfidence,
        enhancedConfidence,
        ragChunksUsed: ragResults.chunks.length,
    originalIntent: originalResult.intent,
        enhancedIntent: enhancedResult.intent,
    intentChanged: originalResult.intent !== enhancedResult.intent,
      });

      const finalResult = {
        ...enhancedResult,
        confidence: enhancedConfidence,
        userLanguage, // Include language for downstream use
        metadata: {
          ...enhancedResult.metadata,
          usedRAG: true,
      originalConfidence,
      originalIntent: originalResult.intent,
      originalScope: originalResult.scope,
      originalTarget: originalResult.target,
      intentChanged: originalResult.intent !== enhancedResult.intent,
          ragSources: ragResults.sources,
          ragChunksCount: ragResults.chunks.length,
        },
      };

      setCacheEntry(cacheKey, finalResult);
      return finalResult;
}

/**
 * Internal function to parse intent with GPT
 * Separated for reusability in RAG fallback
 */
async function parseIntentWithGPT(
  message: string,
  context?: IntentParserContext
): Promise<IntentResult | null> {
  try {
    // Step 1: Prepare prompt and log context
    const prompt = buildIntentPrompt(message, context);
    logContextUsage(context);

    // Step 2: Setup model configuration
    const { model, supportsJsonMode } = getModelConfiguration();

    // Step 3: Smart history parsing for approval messages (async now!)
    const historyData = await extractUrlFromChatHistory(message, context);

    // Step 4: Build messages array for GPT
    const messages = buildGPTMessages(message, prompt, context, historyData);

    // Step 5: Make OpenAI API call
    const response = await makeOpenAICall(model, messages, supportsJsonMode);
    if (!response) return null;

    // Step 6: Parse and validate response
    const parsed = await parseGPTResponse(response, message);
    if (!parsed) return null;

    // Step 7: Finalize and return result
    return finalizeIntentResult(parsed, message);

  } catch (error) {
    return handleParsingError(error, message, context);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER METHODS FOR parseIntentWithGPT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Log context usage for debugging
 */
function logContextUsage(context?: IntentParserContext): void {
    if (context) {
      logger.info('Intent parsing with enriched context', {
        hasDocumentation: !!context.documentation && context.documentation.length > 0,
        hasSelectors: !!context.knownSelectors && Object.keys(context.knownSelectors).length > 0,
        hasTraces: !!context.tracesContext,
      });
  }
    }

/**
 * Get model configuration and JSON mode support
 */
function getModelConfiguration(): { model: string; supportsJsonMode: boolean } {
    const model = env.OPENAI_MODEL || 'gpt-4o-mini';

    // JSON mode supported by: gpt-4-turbo, gpt-4o, gpt-4o-mini, o1, o3
    const supportsJsonMode = model.includes('gpt-4') || model.includes('gpt-3.5') || model.includes('o1') || model.includes('o3');

  return { model, supportsJsonMode };
}

/**
 * Extract URL and method from chat history for approval messages
 * FIX #1: Parallel GPT calls for 2x speed improvement (~200ms saved)
 */
async function extractUrlFromChatHistory(
  message: string,
  context?: IntentParserContext
): Promise<{ extractedUrl: string | null; extractedMethod: string | null }> {
  try {
    // Early return: No chat history available
    if (!context?.chatHistory || context.chatHistory.length === 0) {
      logger.info('[INTENT_PARSER] No chat history available for URL extraction');
      return { extractedUrl: null, extractedMethod: null };
    }

    // Filter ONLY user messages from history
    const userMessages = context.chatHistory
      .filter(msg => msg.role === 'user')
      .slice(-10); // Last 10 USER messages

    if (userMessages.length === 0) {
      logger.info('[INTENT_PARSER] No user messages in history');
      return { extractedUrl: null, extractedMethod: null };
    }

    // OPTIMIZATION: Skip extraction for absolute first message (no context to extract from)
    // Safe: Only skips when userMessages.length === 1 (first user message)
    // Covers approval scenarios: approval always comes AFTER test plan (at least 2+ messages)
    if (userMessages.length === 1 && context.chatHistory.length <= 2) {
      logger.info('[INTENT_PARSER] ⚡ Fast path: First user message, no previous context to extract');
      return { extractedUrl: null, extractedMethod: null };
    }

    // OPTIMIZATION: AI-powered fast pre-filtering
    // Use cheap detection to skip expensive URL extraction when obviously not approval
    // This saves ~200ms + cost for greetings/questions while staying universal
    const approvalResult = await detectUserApproval(message);

    // Early exit: If clearly NOT approval (greeting, question, discussion)
    // Skip expensive URL extraction (saves ~200ms + $0.0004)
    if (approvalResult.approved !== true || approvalResult.confidence < 0.7) {
      logger.info('[INTENT_PARSER] ⚡ Fast path: Message is not approval, skipping URL extraction', {
        message: message.substring(0, 30),
        approved: approvalResult.approved,
        confidence: approvalResult.confidence,
        reasoning: approvalResult.reasoning,
      });
      return { extractedUrl: null, extractedMethod: null };
    }

    // Only extract URL if approval detected with high confidence
    logger.info('[INTENT_PARSER] Approval detected, extracting URL from history', {
      message: message.substring(0, 30),
      confidence: approvalResult.confidence,
    });

    const extractionResult = await extractUrlWithGPT(userMessages, message);

    // Check if URL was extracted
    if (!extractionResult.url) {
      logger.warn('[INTENT_PARSER] No URL found in recent history despite approval', {
        message,
        userMessagesCount: userMessages.length,
        extractionConfidence: extractionResult.confidence,
      });
      return { extractedUrl: null, extractedMethod: null };
    }

    // Success: Approval detected AND URL extracted
    logger.info('[INTENT_PARSER] ✅ Successfully extracted URL from history!', {
      url: extractionResult.url,
      method: extractionResult.method,
      approvalConfidence: approvalResult.confidence,
      extractionConfidence: extractionResult.confidence,
      reasoning: extractionResult.reasoning,
    });

    return {
      extractedUrl: extractionResult.url,
      extractedMethod: extractionResult.method,
    };

  } catch (error) {
    logger.error('[INTENT_PARSER] Error extracting URL from history', {
      error: error instanceof Error ? error.message : String(error),
      message,
    });
    return { extractedUrl: null, extractedMethod: null };
  }
}

/**
 * Build messages array for GPT API call
 */
function buildGPTMessages(
  message: string,
  prompt: string,
  context?: IntentParserContext,
  historyData?: { extractedUrl: string | null; extractedMethod: string | null }
): any[] {
    const messages: any[] = [
      {
        role: 'system',
      content: buildSystemPrompt(message, historyData),
      },
    ];

  // Add chat history for context
    if (context?.chatHistory && context.chatHistory.length > 0) {
      messages.push(...context.chatHistory);
      logger.info('[INTENT_PARSER] Using chat history for context', {
        historyLength: context.chatHistory.length,
      });
    }

    // Add current message
    messages.push({ role: 'user', content: prompt });

  return messages;
}

/**
 * Build system prompt with history context
 * FIX #5: Remove duplicate examples, cleaner prompt
 */
function buildSystemPrompt(
  message: string,
  historyData?: { extractedUrl: string | null; extractedMethod: string | null }
): string {
  const basePrompt = `You are an intent parsing assistant for QAIT platform.

CRITICAL INSTRUCTIONS:
1. Always return ONLY valid JSON (no extra text)
2. If user message is short (like "yes", "go", "execute"), LOOK at chat history to extract context
3. If chat history contains API URL and user says "yes"/"go" → extract that URL and use intent "api_test"
4. If chat history contains website URL and user says "yes"/"go" → use intent "platform_test"
5. Parse user's current message BUT remember context from previous messages

Always return valid JSON matching the expected format.`;

  // FIX #5: Only add URL context if we actually found one
  if (historyData?.extractedUrl) {
    // Check if URL looks like API endpoint (contains /api/ or is API-like)
    // If not, it's likely a website URL for platform_test
    const isApiUrl = historyData.extractedUrl.includes('/api/') ||
                     historyData.extractedUrl.match(/^https?:\/\/api\./i) ||
                     historyData.extractedMethod; // If method specified, likely API

    const suggestedIntent = isApiUrl ? 'api_test' : 'platform_test';

    return `${basePrompt}

⚠️ IMPORTANT: URL FOUND IN HISTORY!
URL: ${historyData.extractedUrl}
Method: ${historyData.extractedMethod || 'Not specified'}
User current message: "${message}"

Since URL is already extracted, analyze the URL to determine intent:
- If URL contains "/api/" or starts with "api." → likely "api_test"
- If URL is a website (like https://example.com) → likely "platform_test"
- If HTTP method is specified → likely "api_test"
- Otherwise, use context from chat history to determine intent

Suggested intent: "${suggestedIntent}" (but verify with chat history context!)`;
  }

  // FIX #5: If no URL found, don't mention extraction at all
  return basePrompt;
}

/**
 * Make OpenAI API call with proper error handling
 */
async function makeOpenAICall(
  model: string,
  messages: any[],
  supportsJsonMode: boolean
): Promise<string | null> {
    const requestParams: any = {
      model,
      messages,
      temperature: 0.1, // Low temperature for consistent parsing
    };

    // Add JSON mode if supported
    if (supportsJsonMode) {
      requestParams.response_format = { type: 'json_object' };
    }

  try {
    const response = await openai.chat.completions.create(requestParams);
    const text = response.choices[0]?.message?.content?.trim();

    if (!text) {
      logger.warn('Empty intent parsing response');
      return null;
    }

    // Log raw GPT response for debugging
    logger.info('[INTENT_PARSER] GPT raw response', {
      responseLength: text.length,
      responsePreview: text.substring(0, 200),
    });

    return text;
  } catch (openaiError: any) {
    logger.error('[INTENT_PARSER] OpenAI API call failed', {
      message: openaiError instanceof Error ? openaiError.message : String(openaiError),
      model,
      status: openaiError?.status,
      code: openaiError?.code,
      type: openaiError?.type,
      error: openaiError?.error?.message || openaiError?.error,
      stack: openaiError instanceof Error ? openaiError.stack : undefined,
    });
    throw openaiError;
  }
}

/**
 * Parse GPT response and handle JSON extraction
 * IMPROVED: Multiple extraction strategies with fallbacks
 */
async function parseGPTResponse(responseText: string, message: string): Promise<IntentResult | null> {
  const extractionStrategies = [
    { name: 'direct', fn: () => extractDirectJSON(responseText) },
    { name: 'markdown', fn: () => extractMarkdownJSON(responseText) },
    { name: 'text', fn: () => extractJSONFromText(responseText) },
    { name: 'quote-fix', fn: () => extractWithQuoteFix(responseText) },
  ];

  // Try each extraction strategy
  for (const strategy of extractionStrategies) {
    try {
      const parsed = strategy.fn();
      if (parsed) {
        logger.info('[INTENT_PARSER] JSON extracted successfully', {
          strategy: strategy.name,
          intent: parsed.intent,
          hasUrl: !!(parsed as any).page || !!(parsed as any).apiUrl,
        });

        // Validate the parsed result
        const validated = validateIntentResult(parsed);
        if (validated) {
          return validated;
        }
      }
    } catch (error) {
      // Continue to next strategy
      logger.debug('[INTENT_PARSER] Strategy failed', {
        strategy: strategy.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // All strategies failed
  logger.error('[INTENT_PARSER] All JSON extraction strategies failed', {
    textPreview: responseText.substring(0, 300),
    textLength: responseText.length,
  });

      return null;
    }

/**
 * Strategy 1: Extract direct JSON (no extra text)
 */
function extractDirectJSON(text: string): IntentResult | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Strategy 2: Extract JSON from markdown code blocks
 * Improved: Non-greedy matching for nested objects
 */
function extractMarkdownJSON(text: string): IntentResult | null {
  // Try with explicit json tag
  let match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // Continue
    }
  }

  // Try without explicit json tag
  match = text.match(/```\s*([\s\S]*?)\s*```/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // Continue
    }
  }

  return null;
}

/**
 * Strategy 3: Extract JSON object from text (without markdown)
 * Handles cases where GPT adds explanation before/after JSON
 */
function extractJSONFromText(text: string): IntentResult | null {
  // Find JSON object pattern (balanced braces)
  const jsonPattern = /\{(?:[^{}]|(\{(?:[^{}]|(\{[^{}]*\}))*\}))*\}/;
  const match = text.match(jsonPattern);

  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Strategy 4: Fix common issues and try parsing
 * Fixes: single quotes → double quotes
 */
function extractWithQuoteFix(text: string): IntentResult | null {
  try {
    // Replace single quotes with double quotes (carefully)
    // Only replace quotes around property names and string values
    const fixed = text
      .replace(/:\s*'([^']*)'/g, ': "$1"')  // Fix string values
      .replace(/'([^']+)':/g, '"$1":');     // Fix property names

    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

/**
 * Validate parsed intent result structure
 * FIX #2: Use centralized constants for validation
 */
function validateIntentResult(parsed: any): IntentResult | null {
  // Check if parsed is an object
  if (!parsed || typeof parsed !== 'object') {
    logger.warn('[INTENT_PARSER] Parsed result is not an object');
    return null;
  }

  // Validate required field: intent
  if (!parsed.intent || typeof parsed.intent !== 'string') {
    logger.warn('[INTENT_PARSER] Missing or invalid intent field', { parsed });
    return null;
  }

  // FIX #2: Validate intent value using centralized constant
  if (!VALID_INTENTS.includes(parsed.intent as any)) {
    logger.warn('[INTENT_PARSER] Invalid intent value', {
      intent: parsed.intent,
      validIntents: VALID_INTENTS,
    });
    // Don't return null - maybe it's a custom intent
  }

  // Validate intent-specific fields
  if (parsed.intent === 'api_test') {
    // apiUrl should be string if present
    if (parsed.apiUrl !== undefined && typeof parsed.apiUrl !== 'string') {
      logger.warn('[INTENT_PARSER] Invalid apiUrl type', { apiUrl: parsed.apiUrl });
      parsed.apiUrl = null;
    }

    // FIX #2: apiMethod validation using centralized constant
    if (parsed.apiMethod !== undefined) {
      if (typeof parsed.apiMethod === 'string' && !VALID_HTTP_METHODS.includes(parsed.apiMethod.toUpperCase() as any)) {
        logger.warn('[INTENT_PARSER] Invalid HTTP method', {
          method: parsed.apiMethod,
          validMethods: VALID_HTTP_METHODS,
        });
      }
    }
  }

  if (parsed.intent === 'platform_test') {
    // page should be string if present
    if (parsed.page !== undefined && typeof parsed.page !== 'string') {
      logger.warn('[INTENT_PARSER] Invalid page type', { page: parsed.page });
      parsed.page = null;
    }
  }

  logger.debug('[INTENT_PARSER] Intent result validated successfully', {
    intent: parsed.intent,
    hasApiUrl: !!parsed.apiUrl,
    hasPage: !!parsed.page,
  });

  return parsed as IntentResult;
}

/**
 * Finalize intent result with metadata
 * IMPROVED: Normalizes data, calculates missing fields, adds comprehensive metadata
 */
function finalizeIntentResult(parsed: IntentResult, message: string): IntentResult {
  // Step 1: Normalize intent string (trim whitespace)
  if (parsed.intent) {
    parsed.intent = parsed.intent.trim() as IntentType;
  }

  // Step 2: Always update rawText to ensure consistency
      parsed.rawText = message;

  // Step 3: Calculate confidence if missing
  if (parsed.confidence === undefined || parsed.confidence === null) {
    parsed.confidence = calculateConfidence(parsed, message);
    logger.debug('[INTENT_PARSER] Calculated missing confidence', {
      confidence: parsed.confidence,
      intent: parsed.intent,
    });
  }

  // Step 4: Normalize and clean fields based on intent type
  if (parsed.intent === 'api_test') {
    // Clean and normalize apiMethod
    if (parsed.apiMethod) {
      parsed.apiMethod = parsed.apiMethod.trim().toUpperCase();
    }

    // Clean apiUrl and detect relative paths
    if (parsed.apiUrl) {
      parsed.apiUrl = parsed.apiUrl.trim();

      // Detect if it's a relative path (doesn't start with http)
      if (!parsed.apiUrl.startsWith('http://') && !parsed.apiUrl.startsWith('https://')) {
        parsed.isRelativePath = true;
        logger.debug('[INTENT_PARSER] Detected relative API path', {
          apiUrl: parsed.apiUrl,
        });
      } else {
        parsed.isRelativePath = false;
      }
    }

    // Convert empty strings to undefined for consistency
    if (parsed.apiUrl === '') parsed.apiUrl = undefined;
    if (parsed.apiMethod === '') parsed.apiMethod = undefined;
    if (parsed.apiBody === '') parsed.apiBody = undefined;
  }

  if (parsed.intent === 'platform_test') {
    // Clean page URL
    if (parsed.page) {
      parsed.page = parsed.page.trim();
    }

    // Convert empty strings to undefined or null based on type
    if (parsed.page === '') parsed.page = null;
    if (parsed.target === '') parsed.target = null;

    // FIX #2: Normalize scope using centralized constant
    if (parsed.scope) {
      const trimmedScope = parsed.scope.trim().toLowerCase();
      if (VALID_SCOPES.includes(trimmedScope as any)) {
        parsed.scope = trimmedScope as any;
      } else {
        logger.debug('[INTENT_PARSER] Unknown scope, keeping as-is', {
          scope: trimmedScope,
          validScopes: VALID_SCOPES,
        });
      }
    }
  }

  // Step 5: Add/update metadata with timestamps and processing info
  parsed.metadata = {
    ...parsed.metadata,
    parsedAt: new Date().toISOString(),
    model: env.OPENAI_MODEL || 'gpt-4o-mini',
    messageLength: message.length,
  };

  // Step 6: Validate known intents
    if (!KNOWN_INTENTS.includes(parsed.intent as any)) {
    logger.warn('[INTENT_PARSER] Unknown intent detected', {
      intent: parsed.intent,
      knownIntents: KNOWN_INTENTS,
    });
  }

  // Step 7: Final validation and logging
  logger.info('[INTENT_PARSER] Intent finalized successfully', {
    intent: parsed.intent,
    confidence: parsed.confidence,
    hasApiUrl: !!parsed.apiUrl,
    hasPage: !!parsed.page,
    isRelativePath: parsed.isRelativePath,
    messageLength: message.length,
  });

    return parsed;
}

/**
 * Handle parsing errors with comprehensive detailed logging
 * IMPROVED: Detects error patterns, logs context, tracks metrics
 */
function handleParsingError(
  error: unknown,
  message: string,
  context?: IntentParserContext
): null {
  // Extract error details
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  const errorName = error instanceof Error ? error.name : 'UnknownError';

  // Extract OpenAI-specific error details
  const openaiError = error as any;
  const openaiStatus = openaiError?.status;
  const openaiCode = openaiError?.code;
  const openaiType = openaiError?.type;

  // Categorize error type for better analysis
  const errorCategory = categorizeError(errorMessage, errorName, openaiStatus, openaiCode);

  // Build comprehensive error context
  const errorContext = {
    // Error details
    errorMessage,
    errorName,
    errorCategory,
    errorStack,
    // OpenAI-specific fields
    openaiStatus,
    openaiCode,
    openaiType,

    // Message context
    message: message,
    messageLength: message.length,
    messagePreview: message.substring(0, 200),
    messageType: detectMessageType(message),

    // Chat history context
    hasContext: !!context,
    hasChatHistory: !!(context?.chatHistory && context.chatHistory.length > 0),
    chatHistoryLength: context?.chatHistory?.length || 0,
    lastUserMessages: context?.chatHistory
      ?.filter(msg => msg.role === 'user')
      .slice(-3)
      .map(msg => msg.content?.substring(0, 50)) || [],

    // Additional context
    hasDocumentation: !!(context?.documentation && context.documentation.length > 0),
    hasKnownSelectors: !!(context?.knownSelectors && Object.keys(context.knownSelectors).length > 0),
    hasTracesContext: !!context?.tracesContext,

    // Timestamp
    timestamp: new Date().toISOString(),
  };

  // Log with appropriate level based on error category
  if (errorCategory === 'critical' || errorCategory === 'openai_api_error') {
    // For OpenAI errors, show critical info upfront
    const statusInfo = openaiStatus ? ` [HTTP ${openaiStatus}]` : '';
    const codeInfo = openaiCode ? ` [Code: ${openaiCode}]` : '';
    logger.error(`[INTENT_PARSER] ❌ OpenAI API Error${statusInfo}${codeInfo}: ${errorMessage}`, errorContext);
  } else if (errorCategory === 'timeout') {
    logger.warn('[INTENT_PARSER] ⏱️ TIMEOUT - Intent parsing timed out', errorContext);
  } else if (errorCategory === 'json_parse_error') {
    logger.warn('[INTENT_PARSER] 📝 JSON PARSE ERROR - Failed to parse GPT response', errorContext);
  } else {
    logger.warn(`[INTENT_PARSER] ⚠️ Intent parsing failed (will fallback to general_chat): ${message.substring(0, 50)}`, errorContext);
  }

  // Track error metrics for monitoring
  incrementErrorMetrics(errorCategory);

  // Log specific diagnostics based on our known bug patterns
  logKnownBugPatterns(message, context, errorMessage);

    return null;
}

/**
 * Categorize error type for better tracking and analysis
 */
function categorizeError(errorMessage: string, errorName: string, status?: number, code?: string): string {
  const lowerError = errorMessage.toLowerCase();

  // OpenAI API errors (check status codes and error codes)
  if (
    status || // Any HTTP status code indicates API error
    code || // OpenAI error codes like 'insufficient_quota', 'invalid_api_key'
    lowerError.includes('openai') ||
    lowerError.includes('rate limit') ||
    lowerError.includes('api key') ||
    lowerError.includes('quota') ||
    lowerError.includes('insufficient_quota')
  ) {
    return 'openai_api_error';
  }

  // Timeout errors
  if (lowerError.includes('timeout') || lowerError.includes('timed out')) {
    return 'timeout';
  }

  // JSON parsing errors
  if (lowerError.includes('json') || lowerError.includes('parse') || errorName === 'SyntaxError') {
    return 'json_parse_error';
  }

  // Network errors
  if (lowerError.includes('network') || lowerError.includes('econnrefused') || lowerError.includes('enotfound')) {
    return 'network_error';
  }

  // Validation errors
  if (lowerError.includes('validation') || lowerError.includes('invalid')) {
    return 'validation_error';
  }

  // Critical errors (unexpected)
  if (lowerError.includes('critical') || lowerError.includes('fatal')) {
    return 'critical';
  }

  return 'unknown';
}

/**
 * Detect message type for better error context
 * FIX #6: Remove unused variable
 */
function detectMessageType(message: string): string {
  // Very short messages (potential approval)
  if (message.length < 10) {
    return 'very_short';
  }

  // Short messages (potential approval)
  if (message.length < 20) {
    return 'short';
  }

  // Has URL
  if (message.match(/https?:\/\//)) {
    return 'contains_url';
  }

  // Question
  if (message.includes('?')) {
    return 'question';
  }

  // Long message
  if (message.length > 200) {
    return 'long';
  }

  return 'normal';
}

/**
 * Track error metrics for monitoring
 * FIX #7: Add automatic reset to prevent memory leak
 */
interface ErrorMetrics {
  total: number;
  byCategory: Map<string, number>;
  lastReset: number;
}

const errorMetrics: ErrorMetrics = {
  total: 0,
  byCategory: new Map(),
  lastReset: Date.now(),
};

function incrementErrorMetrics(category: string): void {
  errorMetrics.total++;
  errorMetrics.byCategory.set(category, (errorMetrics.byCategory.get(category) || 0) + 1);

  // FIX #7: Reset metrics after 24 hours to prevent memory leak
  if (Date.now() - errorMetrics.lastReset > METRICS_RESET_INTERVAL) {
    logger.info('[INTENT_PARSER] 🔄 Resetting error metrics (24h passed)', {
      totalErrors: errorMetrics.total,
      uptime: Math.round((Date.now() - errorMetrics.lastReset) / 1000 / 60 / 60), // hours
      topCategories: Array.from(errorMetrics.byCategory.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
    });

    errorMetrics.total = 0;
    errorMetrics.byCategory.clear();
    errorMetrics.lastReset = Date.now();
  }

  // Log metrics summary every 50 errors
  if (errorMetrics.total % 50 === 0) {
    const topErrors = Array.from(errorMetrics.byCategory.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    logger.info('[INTENT_PARSER] 📊 Error metrics summary', {
      totalErrors: errorMetrics.total,
      timeSinceLastReset: Math.round((Date.now() - errorMetrics.lastReset) / 1000 / 60), // minutes
      topErrorCategories: topErrors,
    });
  }
}

/**
 * Log diagnostics for known bug patterns
 */
function logKnownBugPatterns(
  message: string,
  context?: IntentParserContext,
  errorMessage?: string
): void {
  // Pattern 1: Short approval message without URL (our main bug!)
  const approvalKeywords = ['да', 'yes', 'go', 'ok', 'ок', 'давай', 'run', 'execute', 'start'];
  const isApprovalLike = approvalKeywords.some(keyword => message.toLowerCase().includes(keyword));

  if (isApprovalLike && message.length < 20) {
    logger.warn('[INTENT_PARSER] 🔍 PATTERN DETECTED: Approval-like short message', {
      message,
      hasHistory: !!(context?.chatHistory && context.chatHistory.length > 0),
      historyLength: context?.chatHistory?.length || 0,
      suggestion: 'This might be an approval message. Check if URL exists in chat history.',
    });
  }

  // Pattern 2: Message with URL but parsing failed
  if (message.match(/https?:\/\//)) {
    logger.warn('[INTENT_PARSER] 🔍 PATTERN DETECTED: Message contains URL but parsing failed', {
      messagePreview: message.substring(0, 100),
      urlFound: message.match(/https?:\/\/[^\s]+/)?.[0],
      suggestion: 'URL is present but GPT failed to parse it. Check prompt or extraction logic.',
    });
  }

  // Pattern 3: Empty or very short message
  if (message.trim().length < 3) {
    logger.warn('[INTENT_PARSER] 🔍 PATTERN DETECTED: Empty or too short message', {
      message,
      messageLength: message.length,
      suggestion: 'Message too short to parse meaningfully.',
    });
  }

  // Pattern 4: JSON parse error (GPT returned invalid JSON)
  if (errorMessage?.toLowerCase().includes('json') || errorMessage?.toLowerCase().includes('parse')) {
    logger.error('[INTENT_PARSER] 🔍 PATTERN DETECTED: JSON parsing failed', {
      errorMessage,
      messagePreview: message.substring(0, 100),
      suggestion: 'GPT returned invalid JSON. Check if JSON mode is enabled or response format.',
    });
  }

  // Pattern 5: OpenAI API error (rate limit, network, etc)
  if (errorMessage?.toLowerCase().includes('openai') || errorMessage?.toLowerCase().includes('api')) {
    logger.error('[INTENT_PARSER] 🔍 PATTERN DETECTED: OpenAI API error', {
      errorMessage,
      suggestion: 'OpenAI API call failed. Check API key, rate limits, or network connectivity.',
    });
  }
}

/**
 * Calculate confidence score for an intent result
 * FIX #2: Use centralized constants for validation
 *
 * @param intentResult - The parsed intent result
 * @param message - Original user message
 * @returns Confidence score between 0 and 1
 */
export function calculateConfidence(intentResult: IntentResult, message: string): number {
  // Validate inputs
  if (!message || typeof message !== 'string' || !intentResult) {
    return 0;
  }

  let confidence = 0.5; // Base confidence

  // Platform test confidence boosters
  if (intentResult.intent === 'platform_test') {
    // Validate URL quality
    if (intentResult.page) {
      const isValidUrl = /^https?:\/\/.+/.test(intentResult.page);
      confidence += isValidUrl ? 0.2 : 0.1;
    }

    // FIX #2: Validate scope using centralized constant
    if (intentResult.scope) {
      if (VALID_SCOPES.includes(intentResult.scope as any)) {
        confidence += 0.15; // Known scope
      } else {
        confidence += 0.05; // Unknown scope (might be custom)
      }
    }

    // Validate target has meaningful content
    if (intentResult.target && intentResult.target.length > 2) {
      confidence += 0.15;
    }
  }

  // API test confidence boosters
  if (intentResult.intent === 'api_test') {
    // FIX #2: Validate HTTP method using centralized constant
    if (intentResult.apiMethod) {
      const isValidMethod = VALID_HTTP_METHODS.includes(intentResult.apiMethod.toUpperCase() as any);
      confidence += isValidMethod ? 0.2 : 0.1;
    }

    // Validate API URL has content
    if (intentResult.apiUrl && intentResult.apiUrl.length > 3) {
      confidence += 0.2;
    }
  }

  // General chat confidence boosters
  if (intentResult.intent === 'general_chat') {
    const lowerMessage = message.toLowerCase();

    // Check if message is a question
    if (message.includes('?')) confidence += 0.2;

    // Check if message has no URL (less likely to be testing request)
    if (!message.match(/https?:\/\//)) confidence += 0.1;

    // Check for common greeting/help words
    const helpWords = ['what', 'how', 'help', 'explain', 'tell', 'show', 'hi', 'hello', 'thanks'];
    if (helpWords.some(word => lowerMessage.includes(word))) {
      confidence += 0.1;
    }
  }

  // Cap at 1.0
  return Math.min(confidence, 1.0);
}

/**
 * Get cached rules with smart fallback logic
 * FIX #3: Optimize fallback to avoid duplicate getRules calls
 */
async function getCachedRulesWithFallback(
  userLanguage: 'en' | 'ru' | 'neutral'
): Promise<{ content: string; language: 'en' | 'ru'; fallbackUsed: boolean } | null> {
  try {
    // Step 1: Try exact language match (if not neutral)
    if (userLanguage !== 'neutral') {
      const exactRules = RulesCacheService.getRules(userLanguage);
      if (exactRules) {
        return {
          content: exactRules,
          language: userLanguage,
          fallbackUsed: false,
        };
      }
    }

    // FIX #3: Only try OTHER languages (not the one we just tried)
    // Step 2: Try English fallback (if we didn't just try it)
    if (userLanguage !== 'en') {
      const enRules = RulesCacheService.getRules('en');
      if (enRules) {
        return {
          content: enRules,
          language: 'en',
          fallbackUsed: true,
        };
      }
    }

    // Step 3: Try Russian fallback (if we didn't just try it)
    if (userLanguage !== 'ru') {
      const ruRules = RulesCacheService.getRules('ru');
      if (ruRules) {
        return {
          content: ruRules,
          language: 'ru',
          fallbackUsed: true,
        };
      }
    }

    // Step 4: No rules found in cache
    logger.warn('[INTENT_PARSER] No cached rules found for any language', {
      requestedLanguage: userLanguage,
      cacheStatus: {
        en: !!RulesCacheService.getRules('en'),
        ru: !!RulesCacheService.getRules('ru'),
      },
    });

    return null;
  } catch (error) {
    logger.error('[INTENT_PARSER] Error getting cached rules', {
      error: error instanceof Error ? error.message : String(error),
      userLanguage,
    });
    return null;
  }
}
