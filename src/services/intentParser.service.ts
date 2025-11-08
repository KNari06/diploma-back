import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { buildIntentPrompt, IntentParserContext } from '@/ai/prompts/intentParserPrompt';
import { IntentResult, KNOWN_INTENTS } from '@/types';
import { searchKB, KBSearchResult } from '@/services/kb.service';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// Intent cache for avoiding duplicate RAG calls (TTL: 1 minute)
const intentCache = new Map<string, { result: IntentResult; timestamp: number }>();
const CACHE_TTL = 60000; // 1 minute
const MAX_CACHE_SIZE = 500; // Maximum cache entries to prevent memory leak
const RAG_TIMEOUT = 5000; // 5 seconds for KB search
const GPT_TIMEOUT = 10000; // 10 seconds for GPT parsing

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
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // FIX #1: Validate message
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      logger.warn('[INTENT_PARSER] Invalid message', { message });
      return null;
    }

    const trimmedMessage = message.trim();

    logger.info('[INTENT_PARSER] Starting intent parsing', {
      message: trimmedMessage.substring(0, 50),
      hasContext: !!context,
      projectId,
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // FIX #3: Check cache to avoid duplicate RAG calls
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const cacheKey = `${trimmedMessage.toLowerCase()}|${projectId || 'global'}`;
    const cached = intentCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      logger.info('[INTENT_PARSER] Using cached result', { cacheKey });
      return { ...cached.result };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 1: Try standard parsing (fast path)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    const intentResult = await parseIntentWithGPT(trimmedMessage, context);

    if (!intentResult) {
      logger.warn('[INTENT_PARSER] Initial parse failed');
      return null;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 2: Calculate confidence - do we need RAG fallback?
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    const confidence = calculateConfidence(intentResult, trimmedMessage);

    logger.info('[INTENT_PARSER] Initial parse confidence', {
      confidence,
      intent: intentResult.intent,
    });

    // If confidence is high enough, return immediately (fast path)
    if (confidence >= 0.7) {
      logger.info('[INTENT_PARSER] High confidence, using standard parse');
      const finalResult = {
        ...intentResult,
        confidence,
      };

      // Cache the result
      setCacheEntry(cacheKey, finalResult);

      return finalResult;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 3: Low confidence - use RAG fallback
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    logger.info('[INTENT_PARSER] Low confidence, using RAG fallback');

    try {
      // FIX #5: Add timeout for KB search to prevent hanging
      const ragResults = await withTimeout(
        searchKB(trimmedMessage, projectId, {
          matchCount: 5,
          matchThreshold: 0.5, // Lower threshold for better recall
        }),
        RAG_TIMEOUT,
        'KB search timeout'
      );

      if (ragResults.chunks.length === 0) {
        logger.warn('[INTENT_PARSER] No RAG results, using initial parse');
        const fallbackResult = {
          ...intentResult,
          confidence,
        };

        // Cache fallback result
        setCacheEntry(cacheKey, fallbackResult);

        return fallbackResult;
      }

      // Build enhanced context with RAG results
      const ragContext = ragResults.chunks
        .map((chunk) => chunk.content)
        .join('\n\n');

      const enhancedContext: IntentParserContext = {
        ...context,
        documentation: [
          ...(context?.documentation || []),
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 SIMILAR EXAMPLES FROM KNOWLEDGE BASE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${ragContext}

Use these examples to better understand the user's intent.`,
        ],
      };

      // FIX #5: Add timeout for GPT re-parsing
      const enhancedResult = await withTimeout(
        parseIntentWithGPT(trimmedMessage, enhancedContext),
        GPT_TIMEOUT,
        'GPT enhanced parsing timeout'
      );

      if (!enhancedResult) {
        logger.warn('[INTENT_PARSER] Enhanced parse failed, using initial');
        const fallbackResult = {
          ...intentResult,
          confidence,
        };

        // Cache fallback result
        setCacheEntry(cacheKey, fallbackResult);

        return fallbackResult;
      }

      const enhancedConfidence = calculateConfidence(enhancedResult, trimmedMessage);

      logger.info('[INTENT_PARSER] RAG-enhanced parse complete', {
        originalConfidence: confidence,
        enhancedConfidence,
        ragChunksUsed: ragResults.chunks.length,
        originalIntent: intentResult.intent,
        enhancedIntent: enhancedResult.intent,
        intentChanged: intentResult.intent !== enhancedResult.intent,
      });

      // FIX #6: Save originalIntent and other metadata
      const finalResult = {
        ...enhancedResult,
        confidence: enhancedConfidence,
        metadata: {
          ...enhancedResult.metadata,
          usedRAG: true,
          originalConfidence: confidence,
          originalIntent: intentResult.intent,
          originalScope: intentResult.scope,
          originalTarget: intentResult.target,
          intentChanged: intentResult.intent !== enhancedResult.intent,
          ragSources: ragResults.sources,
          ragChunksCount: ragResults.chunks.length,
        },
      };

      // Cache enhanced result
      setCacheEntry(cacheKey, finalResult);

      return finalResult;
    } catch (ragError) {
      logger.error('[INTENT_PARSER] RAG fallback failed', { ragError });
      // Return initial parse if RAG fails
      const fallbackResult = {
        ...intentResult,
        confidence,
      };

      // Cache fallback result even on error
      setCacheEntry(cacheKey, fallbackResult);

      return fallbackResult;
    }
  } catch (error) {
    logger.error('[INTENT_PARSER] Intent parsing failed', { error, message });
    return null;
  }
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
    const prompt = buildIntentPrompt(message, context);

    // Log context usage
    if (context) {
      logger.info('Intent parsing with enriched context', {
        hasDocumentation: !!context.documentation && context.documentation.length > 0,
        hasSelectors: !!context.knownSelectors && Object.keys(context.knownSelectors).length > 0,
        hasTraces: !!context.tracesContext,
      });
    }

    const model = env.OPENAI_MODEL || 'gpt-4o-mini';

    // JSON mode supported by: gpt-4-turbo, gpt-4o, gpt-4o-mini, o1, o3
    const supportsJsonMode = model.includes('gpt-4') || model.includes('gpt-3.5') || model.includes('o1') || model.includes('o3');

    const requestParams: any = {
      model,
      messages: [
        {
          role: 'system',
          content: 'Ты помощник для парсинга намерений пользователя. Всегда возвращай только валидный JSON без дополнительного текста.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, // Low temperature for consistent parsing
    };

    // Add JSON mode if supported
    if (supportsJsonMode) {
      requestParams.response_format = { type: 'json_object' };
    }

    const response = await openai.chat.completions.create(requestParams);

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      logger.warn('Empty intent parsing response');
      return null;
    }

    // Try to parse JSON (handle cases where response format is not enforced)
    let parsed: IntentResult;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1]);
      } else {
        throw parseError;
      }
    }

    // Validate required fields
    if (!parsed.intent) {
      logger.warn('Invalid intent result: missing intent', { parsed });
      return null;
    }

    // Store original message for reference
    if (!parsed.rawText) {
      parsed.rawText = message;
    }

    // FIX #7: Use KNOWN_INTENTS constant from types
    if (!KNOWN_INTENTS.includes(parsed.intent as any)) {
      logger.info('Custom intent detected', { intent: parsed.intent });
    }

    logger.info('Intent parsed successfully', { intent: parsed.intent, messageLength: message.length });

    return parsed;
  } catch (error) {
    logger.error('Intent parsing with GPT failed', { error, message });
    return null;
  }
}

/**
 * Calculate confidence score for an intent result
 * Higher confidence = more certain about the intent
 *
 * FIX #2 & #4: Validate field quality, not just presence
 *
 * @param intentResult - The parsed intent result
 * @param message - Original user message
 * @returns Confidence score between 0 and 1
 */
export function calculateConfidence(intentResult: IntentResult, message: string): number {
  // FIX #4: Validate inputs
  if (!message || typeof message !== 'string' || !intentResult) {
    return 0;
  }

  let confidence = 0.5; // Base confidence

  // Platform test confidence boosters
  if (intentResult.intent === 'platform_test') {
    // FIX #2: Validate URL quality
    if (intentResult.page) {
      const isValidUrl = /^https?:\/\/.+/.test(intentResult.page);
      confidence += isValidUrl ? 0.2 : 0.1; // Lower boost for invalid URL
    }

    // FIX #2: Validate scope against known values
    const validScopes = ['full', 'page', 'element', 'flow', 'form', 'auth', 'navigation'];
    if (intentResult.scope) {
      if (validScopes.includes(intentResult.scope)) {
        confidence += 0.15; // Known scope
      } else {
        confidence += 0.05; // Unknown scope (might be custom)
      }
    }

    // FIX #2: Validate target has meaningful content
    if (intentResult.target && intentResult.target.length > 2) {
      confidence += 0.15;
    }
  }

  // API test confidence boosters
  if (intentResult.intent === 'api_test') {
    // FIX #2: Validate HTTP method
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    if (intentResult.apiMethod) {
      const isValidMethod = validMethods.includes(intentResult.apiMethod.toUpperCase());
      confidence += isValidMethod ? 0.2 : 0.1; // Lower boost for invalid method
    }

    // FIX #2: Validate API URL has content
    if (intentResult.apiUrl && intentResult.apiUrl.length > 3) {
      confidence += 0.2;
    }
  }

  // General chat confidence boosters
  if (intentResult.intent === 'general_chat') {
    // FIX #4: Safe string operations with null check
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
