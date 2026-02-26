import { AI_MODELS } from '@/config/ai/ai-models.config';
import { buildIntentPrompt, IntentParserContext } from '@/ai/prompts/index';
import { env } from '@/config/environment/env';
import { extractUrlWithGPT } from '@/services/ai/helpers/ai-helpers.service';
import { searchKB } from '@/services/kb/kb.service';
import { RulesCacheService } from '@/services/kb/rules-cache.service';
import { IntentResult, IntentType, VALID_SCOPES } from '@/types';
import { logger } from '@/utils/core/logger';
import { OpenAI } from 'openai';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONSTANTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// FIX #2: Centralized validation constants
const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;
// ✅ VALID_SCOPES now imported from @/types
// ✅ VALID_INTENTS removed - now dynamically validated via handler-registry (getAvailableIntents())

// Cache configuration
// TODO: Cache temporarily disabled
// const CACHE_TTL = 60000; // 1 minute
// const MAX_CACHE_SIZE = 500; // Maximum cache entries to prevent memory leak

// Timeout configuration
const KB_RULES_TIMEOUT = 5000; // 5 seconds for KB rules search

/**
 * Helper: wrap a promise with a timeout
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
  );
  return Promise.race([promise, timeoutPromise]);
}

// Metrics reset interval
const METRICS_RESET_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Confidence and validation thresholds
const MIN_CONFIDENCE_FOR_ACTION = 0.7; // Minimum confidence to proceed without clarification
const MIN_CLARIFICATION_CONFIDENCE_CAP = 0.65; // Max confidence for needs_clarification intent
const MIN_CONFIDENCE_FOR_CLARIFICATION = 0.6; // Threshold below which to request clarification

// Message length thresholds
const VERY_SHORT_MESSAGE_LENGTH = 5; // Messages < 5 chars (approvals, unclear)
const DETAILED_MESSAGE_LENGTH = 50; // Messages > 50 chars (detailed, more confident)
const MIN_API_URL_LENGTH = 7; // Minimum valid URL length ("http://x")

// Intent cache for avoiding duplicate RAG calls
// TODO: Cache temporarily disabled - will be re-enabled later if needed
// const intentCache = new Map<string, { result: IntentResult; timestamp: number }>();

// FIX #9: Periodic cache cleanup to prevent memory leak
// Clean up expired cache entries every 5 minutes
// TODO: Cache temporarily disabled
// setInterval(() => {
//   const now = Date.now();
//   let cleanedCount = 0;
//
//   for (const [key, value] of intentCache.entries()) {
//     if (now - value.timestamp > CACHE_TTL) {
//       intentCache.delete(key);
//       cleanedCount++;
//     }
//   }
//
//   if (cleanedCount > 0) {
//     logger.info('[INTENT_CACHE] Cleaned up expired entries', {
//       cleaned: cleanedCount,
//       remaining: intentCache.size,
//     });
//   }
// }, 300000); // 5 minutes



/**
 * Simple language detection (heuristic)
 * Detects Russian vs English based on Cyrillic characters
 * TODO: Re-enable AI-based detection when KB service is re-enabled
 */
function detectLanguageSimple(message: string): 'en' | 'ru' | 'neutral' {
  if (!message || typeof message !== 'string' || message.trim().length < 2) {
    return 'neutral';
  }

  // Check for Cyrillic characters (Russian)
  const cyrillicPattern = /[А-Яа-яЁё]/;
  const hasCyrillic = cyrillicPattern.test(message);

  // Count Cyrillic vs Latin characters
  const cyrillicCount = (message.match(/[А-Яа-яЁё]/g) || []).length;
  const latinCount = (message.match(/[A-Za-z]/g) || []).length;

  // If Cyrillic characters present and more than Latin, assume Russian
  if (hasCyrillic && cyrillicCount > latinCount / 2) {
    return 'ru';
  }

  // If mostly Latin characters, assume English
  if (latinCount > 3 && cyrillicCount === 0) {
    return 'en';
  }

  // Default to neutral if unclear
  return 'neutral';
}

/**
 * FIX #9: Safe cache setter with size limit
 * Prevents memory leak by enforcing MAX_CACHE_SIZE
 * TODO: Cache temporarily disabled
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// const setCacheEntry = (
//   // eslint-disable-next-line @typescript-eslint/no-unused-vars
//   _key: string,
//   // eslint-disable-next-line @typescript-eslint/no-unused-vars
//   _result: IntentResult
// ): void => {
  // Cache disabled - no-op
  // TODO: Re-enable when needed
  // if (intentCache.size >= MAX_CACHE_SIZE) {
  //   const firstKey = intentCache.keys().next().value;
  //   if (firstKey) {
  //     intentCache.delete(firstKey);
  //     logger.warn('[INTENT_CACHE] Cache size limit reached, removed oldest entry', {
  //       removedKey: firstKey.substring(0, 50),
  //       cacheSize: intentCache.size,
  //     });
  //   }
  // }
  // intentCache.set(key, { result, timestamp: Date.now() });
// };

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
  projectId?: string,
  availableIntents?: string[] // NEW: Dynamic list of available intents
): Promise<IntentResult | null> {
  try {
    // Step 1: Validate and prepare message
    const trimmedMessage = validateAndPrepareMessage(message);
    if (!trimmedMessage) return null;

    // Step 2: Check cache for existing results
    // TODO: Cache temporarily disabled
    // const cacheKey = buildCacheKey(trimmedMessage, projectId, availableIntents);
    // const cachedResult = getCachedResult(cacheKey);
    // if (cachedResult) return cachedResult;

    // Step 3: Get KB rules context (FAST/SLOW path)
    const userLanguage = detectLanguageSimple(trimmedMessage);
    const { kbRulesContext } = await getKBRulesContext(
      trimmedMessage,
      userLanguage,
      context,
      projectId
    );

    // Step 4: Parse intent with GPT
    const intentResult = await parseIntentWithGPT(trimmedMessage, kbRulesContext, availableIntents);
    if (!intentResult) {
      logger.warn('[INTENT_PARSER] Initial parse failed');
      return null;
    }

    // Step 5: Calculate confidence and decide next steps
    const confidence = calculateConfidence(intentResult, trimmedMessage);

    // Step 6: Check if intent is complete (has required fields)
    // This check happens BEFORE confidence handling to ensure incomplete intents
    // always trigger needs_clarification, regardless of confidence
    const isComplete = isIntentCompleteness(intentResult);
    if (!isComplete) {
      logger.warn('[INTENT_PARSER] Intent is incomplete, requesting clarification', {
        intent: intentResult.intent,
        confidence,
      });
      // Force needs_clarification for incomplete intents
      return createFallbackResult(intentResult, Math.min(confidence, 0.65), userLanguage);
    }

    // Step 7: Handle high confidence results
    const highConfidenceResult = handleHighConfidenceResult(
      intentResult,
      confidence,
      userLanguage
    );
    if (highConfidenceResult) return highConfidenceResult;

    // Step 8: Handle low confidence (< 0.7)
    // KB rules are already included in context from Step 3.
    // Additional RAG-enhanced re-parsing could be added here if needed.
    logger.info('[INTENT_PARSER] Low confidence, returning fallback result', {
      confidence,
      intent: intentResult.intent,
    });
    return createFallbackResult(intentResult, confidence, userLanguage);

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

// /**
//  * Build cache key for intent result
//  * Includes availableIntents to prevent cache collision when intent set changes
//  * TODO: Cache temporarily disabled
//  */
// // eslint-disable-next-line @typescript-eslint/no-unused-vars
// function buildCacheKey(message: string, projectId?: string, availableIntents?: string[]): string {
//   const intentsKey = availableIntents?.sort().join(',') || 'default';
//   return `${message.toLowerCase()}|${projectId || 'global'}|${intentsKey}`;
// }

/**
 * Get cached result if available and not expired
 * TODO: Cache temporarily disabled
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// function getCachedResult(
//   // eslint-disable-next-line @typescript-eslint/no-unused-vars
//   _cacheKey: string
// ): IntentResult | null {
//   // Cache disabled - always return null
//   // TODO: Re-enable when needed
//   // const cached = intentCache.get(cacheKey);
//   // if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
//   //   logger.info('[INTENT_PARSER] Using cached result', { cacheKey });
//   //   return { ...cached.result };
//   // }
//   return null;
// }

/**
 * Get KB rules context using FAST path (cache) or SLOW path (searchKB)
 * Uses pre-detected language to avoid expensive AI language detection call.
 */
async function getKBRulesContext(
  trimmedMessage: string,
  userLanguage: 'en' | 'ru' | 'neutral',
  context?: IntentParserContext,
  projectId?: string
): Promise<{
  kbRulesContext: IntentParserContext;
  kbRulesUsed: boolean;
}> {
  let kbRulesContext: IntentParserContext = context || {};
  let kbRulesUsed = false;

  try {
    // Try to get rules from cache first (FAST PATH - ~0ms)
    const cachedRules = getCachedRulesWithFallback(userLanguage);

    if (cachedRules) {
      // Rules found in cache! No need for searchKB()
      kbRulesContext = buildRulesContext(context, cachedRules.content);
      kbRulesUsed = true;

      logger.info('[INTENT_PARSER] Using cached rules (FAST PATH)', {
        language: userLanguage,
        cacheLanguage: cachedRules.language,
        rulesLength: cachedRules.content.length,
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
        KB_RULES_TIMEOUT,
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
            rulesContextLength: rulesContext.length,
          });
        }
      }
    }
  } catch (error) {
    logger.warn('[INTENT_PARSER] Failed to get rules, continuing without them', { error });
    // Continue without KB rules - not critical
  }

  return { kbRulesContext, kbRulesUsed };
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
 * Returns result if confidence is sufficient, null otherwise
 */
function handleHighConfidenceResult(
  intentResult: IntentResult,
  confidence: number,
  userLanguage: 'en' | 'ru' | 'neutral'
): IntentResult | null {
    logger.info('[INTENT_PARSER] Initial parse confidence', {
      confidence,
      intent: intentResult.intent,
    });

    // If confidence is high enough, return immediately (fast path)
    if (confidence >= MIN_CONFIDENCE_FOR_ACTION) {
      logger.info('[INTENT_PARSER] High confidence, using standard parse');
      const finalResult = {
        ...intentResult,
        confidence,
        userLanguage, // Include language for downstream use
      };

      // TODO: Cache temporarily disabled
      // setCacheEntry(cacheKey, finalResult);
      return finalResult;
    }

  return null; // Low confidence, will create fallback result
}

// TODO: KB Search temporarily disabled - will be re-enabled later
// /**
//  * Handle low confidence results with RAG fallback
//  * FIX #4: Accept userLanguage to avoid re-detection
//  */
// async function handleLowConfidenceWithRAG(
//   trimmedMessage: string,
//   context?: IntentParserContext,
//   projectId?: string,
//   intentResult?: IntentResult,
//   confidence?: number,
//   cacheKey?: string,
//   userLanguage?: 'en' | 'ru' | 'neutral'
// ): Promise<IntentResult | null> {
//   if (!intentResult || confidence === undefined || !cacheKey) {
//     return null;
//   }
//
//     logger.info('[INTENT_PARSER] Low confidence, using additional RAG fallback');
//
//     try {
//     // Search for additional context (FIX #4: use pre-detected language)
//     const ragResults = await withTimeout(
//       searchKB(trimmedMessage, projectId, {
//         matchCount: 5,
//         matchThreshold: 0.5, // Lower threshold for better recall
//         language: userLanguage || 'neutral',
//       }),
//       RAG_TIMEOUT,
//       'KB search timeout'
//     );
//
//       if (ragResults.chunks.length === 0) {
//         logger.warn('[INTENT_PARSER] No RAG results, using initial parse');
//       return createFallbackResult(intentResult, confidence, cacheKey);
//     }
//
//     // Build enhanced context with RAG results
//     const enhancedContext = buildEnhancedContext(context, ragResults);
//
//     // Re-parse with enhanced context
//     const enhancedResult = await withTimeout(
//       parseIntentWithGPT(trimmedMessage, enhancedContext),
//       GPT_TIMEOUT,
//       'GPT enhanced parsing timeout'
//     );
//
//     if (!enhancedResult) {
//       logger.warn('[INTENT_PARSER] Enhanced parse failed, using initial');
//       return createFallbackResult(intentResult, confidence, cacheKey);
//     }
//
//     return createEnhancedResult(
//       enhancedResult,
//       intentResult,
//       confidence,
//       ragResults,
//       cacheKey,
//       trimmedMessage,
//       userLanguage
//     );
//
//   } catch (ragError) {
//     logger.error('[INTENT_PARSER] RAG fallback failed', { ragError });
//     return createFallbackResult(intentResult, confidence, cacheKey);
//   }
// }

/**
 * Check if intent has all required fields
 * Returns false if intent is incomplete (should trigger needs_clarification)
 */
function isIntentCompleteness(intentResult: IntentResult): boolean {
  // Check api_test requirements
  if (intentResult.intent === 'api_test') {
    // api_test requires apiUrl (can be relative path, but must exist)
    if (!intentResult.apiUrl || intentResult.apiUrl.trim().length === 0) {
      logger.debug('[INTENT_PARSER] api_test incomplete: missing apiUrl');
      return false;
    }
    // apiMethod is optional (can be inferred)
  }

  // Check platform_test requirements
  if (intentResult.intent === 'platform_test') {
    // platform_test requires page URL
    if (!intentResult.page || intentResult.page.trim().length === 0) {
      logger.debug('[INTENT_PARSER] platform_test incomplete: missing page');
      return false;
    }
  }

  // Check save_test requirements
  if (intentResult.intent === 'save_test') {
    // save_test requires sourceTestId
    if (!intentResult.sourceTestId) {
      logger.debug('[INTENT_PARSER] save_test incomplete: missing sourceTestId');
      return false;
    }
  }

  // Check run_regression requirements
  if (intentResult.intent === 'run_regression') {
    // run_regression requires savedTestCaseId
    if (!intentResult.savedTestCaseId) {
      logger.debug('[INTENT_PARSER] run_regression incomplete: missing savedTestCaseId');
      return false;
    }
  }

  // general_chat and needs_clarification don't require specific fields
  return true;
}

/**
 * Build enhanced context with RAG results
 */
// TODO: KB Search temporarily disabled - will be re-enabled later
// function buildEnhancedContext(
//   baseContext?: IntentParserContext,
//   ragResults?: any
// ): IntentParserContext {
//   if (!ragResults?.chunks?.length) return baseContext || {};
//
//       const ragContext = ragResults.chunks
//     .map((chunk: any) => chunk.content)
//         .join('\n\n');
//
//   return {
//     ...baseContext,
//         documentation: [
//       ...(baseContext?.documentation || []),
//           `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📚 SIMILAR EXAMPLES FROM KNOWLEDGE BASE:
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// ${ragContext}
//
// Use these examples to better understand the user's intent.`,
//         ],
//       };
// }

/**
 * Create fallback result for incomplete or low confidence intents
 * Note: AI model should decide when to use needs_clarification in most cases
 * This is a safety net for edge cases
 */
function createFallbackResult(
  intentResult: IntentResult,
  confidence: number,
  userLanguage: 'en' | 'ru' | 'neutral' = 'neutral'
): IntentResult {
  // If AI explicitly returned needs_clarification, respect its decision
  if (intentResult.intent === 'needs_clarification') {
    // Ensure all required fields are present
    const clarificationQuestion = intentResult.clarificationQuestion ||
      getFallbackClarificationQuestion(intentResult);

    const clarificationResult: IntentResult = {
      intent: 'needs_clarification',
      confidence: Math.min(confidence, MIN_CLARIFICATION_CONFIDENCE_CAP),
      clarificationQuestion,
      possibleIntents: intentResult.possibleIntents || getPossibleIntents(intentResult),
      clarificationReason: intentResult.clarificationReason || 'AI requested clarification',
      rawText: intentResult.rawText,
      userLanguage,
      metadata: {
        ...intentResult.metadata,
        originalIntent: intentResult.intent,
        originalConfidence: confidence,
      },
    };

    // TODO: Cache temporarily disabled
    // setCacheEntry(cacheKey, clarificationResult);
    return clarificationResult;
  }

  // For very low confidence (< 0.6) on actionable intents, consider asking for clarification
  // But only if the intent is truly unclear, not just low confidence
  const hasRequiredActionFields =
    (intentResult.intent === 'api_test' &&
      typeof intentResult.apiUrl === 'string' &&
      intentResult.apiUrl.trim().length > 0) ||
    (intentResult.intent === 'platform_test' &&
      typeof intentResult.page === 'string' &&
      intentResult.page.trim().length > 0);

  if (confidence < MIN_CONFIDENCE_FOR_CLARIFICATION &&
      (intentResult.intent === 'api_test' || intentResult.intent === 'platform_test') &&
      !hasRequiredActionFields) {
    logger.info('[INTENT_PARSER] Very low confidence on actionable intent, requesting clarification', {
      originalIntent: intentResult.intent,
      confidence,
    });

    const clarificationQuestion = getFallbackClarificationQuestion(intentResult);

    const clarificationResult: IntentResult = {
      intent: 'needs_clarification',
      confidence,
      clarificationQuestion,
      possibleIntents: getPossibleIntents(intentResult),
      clarificationReason: `Confidence score (${confidence.toFixed(2)}) is very low. Need more information to determine intent.`,
      rawText: intentResult.rawText,
      userLanguage,
      metadata: {
        ...intentResult.metadata,
        originalIntent: intentResult.intent,
        originalConfidence: confidence,
      },
    };

    // TODO: Cache temporarily disabled
    // setCacheEntry(cacheKey, clarificationResult);
    return clarificationResult;
  }

  // Confidence is acceptable (>= 0.6) or intent is not actionable, return original intent
  const fallbackResult = { ...intentResult, confidence, userLanguage };
  // TODO: Cache temporarily disabled
  // setCacheEntry(cacheKey, fallbackResult);
  return fallbackResult;
}

/**
 * Get fallback clarification question if GPT didn't provide one
 * This should rarely be needed - GPT should always return clarificationQuestion
 * when intent is needs_clarification
 */
function getFallbackClarificationQuestion(intentResult: IntentResult): string {
  logger.warn('[INTENT_PARSER] GPT did not provide clarificationQuestion, using fallback', {
    intent: intentResult.intent,
  });

  // Generic fallback - GPT should have provided a better one
  return "I'm not entirely sure what you'd like me to do. Could you provide more details? (What do you want to test? API endpoint or web page? URL?)";
}

/**
 * Check if user's message is a response to a clarification question
 * by looking at chat history context
 *
 * Uses metadata approach instead of hardcoded markers - more reliable!
 * Currently unused - may be used in future
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// function checkIfResponseToClarification(
//   context?: IntentParserContext
// ): boolean {
//   if (!context?.chatHistory || !Array.isArray(context.chatHistory)) {
//     return false;
//   }

//   const history = context.chatHistory;
//   if (history.length < 2) {
//     return false; // Need at least user message + AI clarification
//   }

//   // Get last assistant message
//   const lastAssistantMessage = history
//     .slice()
//     .reverse()
//     .find(msg => msg.role === 'assistant' || msg.role === 'ai');

//   if (!lastAssistantMessage) {
//     return false;
//   }

//   // Check metadata for clarification indicators (more reliable than text matching)
//   const metadata = (lastAssistantMessage as any).metadata;

//   // Method 1: Check if metadata explicitly marks this as clarification
//   if (metadata) {
//     // From needs_clarification handler
//     if (metadata.requiresAnswers === true) {
//       logger.debug('[INTENT_PARSER] Detected clarification via metadata.requiresAnswers', {
//         hasQuestions: !!metadata.questions,
//       });
//       return true;
//     }

//     // From API/Platform test handlers (questions array)
//     if (metadata.questions && Array.isArray(metadata.questions) && metadata.questions.length > 0) {
//       logger.debug('[INTENT_PARSER] Detected clarification via metadata.questions', {
//         questionsCount: metadata.questions.length,
//       });
//       return true;
//     }

//     // From needsMoreInfo flag
//     if (metadata.needsMoreInfo === true) {
//       logger.debug('[INTENT_PARSER] Detected clarification via metadata.needsMoreInfo');
//       return true;
//     }
//   }

//   // Method 2: Fallback - check message content structure
//   // Only if no metadata found (backward compatibility)
//   const content = lastAssistantMessage.content || '';

//   // Check for structured question format (emoji + question pattern)
//   const hasStructuredQuestion =
//     (content.includes('📋') || content.includes('🌐') || content.includes('📡') || content.includes('❓')) &&
//     (content.includes('?') || content.includes('provide') || content.includes('clarify'));

//   if (hasStructuredQuestion) {
//     logger.debug('[INTENT_PARSER] Detected clarification via structured question format (fallback)', {
//       contentPreview: content.substring(0, 100),
//     });
//     return true;
//   }

//   return false;
// }

/**
 * Get possible intents based on current result
 */
function getPossibleIntents(intentResult: IntentResult): string[] {
  const hasUrl = !!(intentResult.apiUrl || intentResult.page);
  const hasMethod = !!intentResult.apiMethod;

  // If URL exists, likely testing
  if (hasUrl) {
    if (hasMethod || intentResult.intent === 'api_test') {
      return ['api_test', 'platform_test'];
    }
    return ['platform_test', 'api_test'];
  }

  // No URL, could be anything
  return ['api_test', 'platform_test', 'general_chat'];
}

// TODO: KB Search temporarily disabled - will be re-enabled later
// /**
//  * Create enhanced result with RAG metadata
//  */
// function createEnhancedResult(
//   enhancedResult: IntentResult,
//   originalResult: IntentResult,
//   originalConfidence: number,
//   ragResults: any,
//   cacheKey: string,
//   trimmedMessage: string,
//   userLanguage?: 'en' | 'ru' | 'neutral'
// ): IntentResult {
//       const enhancedConfidence = calculateConfidence(enhancedResult, trimmedMessage);
//
//       logger.info('[INTENT_PARSER] RAG-enhanced parse complete', {
//     originalConfidence,
//         enhancedConfidence,
//         ragChunksUsed: ragResults.chunks.length,
//     originalIntent: originalResult.intent,
//         enhancedIntent: enhancedResult.intent,
//     intentChanged: originalResult.intent !== enhancedResult.intent,
//       });
//
//   // If enhanced confidence is still too low, request clarification
//   if (enhancedConfidence < 0.7) {
//     logger.info('[INTENT_PARSER] Enhanced confidence still low, requesting clarification', {
//       enhancedConfidence,
//       enhancedIntent: enhancedResult.intent,
//     });
//
//     // Use clarificationQuestion from GPT if available, otherwise fallback
//     const clarificationQuestion = enhancedResult.clarificationQuestion ||
//       getFallbackClarificationQuestion(enhancedResult);
//
//     const clarificationResult: IntentResult = {
//       intent: 'needs_clarification',
//       confidence: enhancedConfidence,
//       clarificationQuestion,
//       possibleIntents: enhancedResult.possibleIntents || getPossibleIntents(enhancedResult),
//       clarificationReason: enhancedResult.clarificationReason ||
//         `Even with additional context, confidence score (${enhancedConfidence.toFixed(2)}) is below threshold (0.7).`,
//       rawText: enhancedResult.rawText,
//       metadata: {
//         ...enhancedResult.metadata,
//         usedRAG: true,
//         originalConfidence,
//         originalIntent: originalResult.intent,
//         enhancedIntent: enhancedResult.intent,
//         ragSources: ragResults.sources,
//         ragChunksCount: ragResults.chunks.length,
//       },
//     };
//
//     setCacheEntry(cacheKey, clarificationResult);
//     return clarificationResult;
//   }
//
//   // Enhanced confidence is acceptable
//       const finalResult = {
//         ...enhancedResult,
//         confidence: enhancedConfidence,
//         userLanguage, // Include language for downstream use
//         metadata: {
//           ...enhancedResult.metadata,
//           usedRAG: true,
//       originalConfidence,
//       originalIntent: originalResult.intent,
//       originalScope: originalResult.scope,
//       originalTarget: originalResult.target,
//       intentChanged: originalResult.intent !== enhancedResult.intent,
//           ragSources: ragResults.sources,
//           ragChunksCount: ragResults.chunks.length,
//         },
//       };
//
//       setCacheEntry(cacheKey, finalResult);
//       return finalResult;
// }

/**
 * Internal function to parse intent with GPT
 * Separated for reusability in RAG fallback
 */
async function parseIntentWithGPT(
  message: string,
  context?: IntentParserContext,
  availableIntents?: string[] // NEW: Dynamic list of available intents
): Promise<IntentResult | null> {
  try {
    // Step 1: Prepare prompt and log context
    const prompt = buildIntentPrompt(message, context, availableIntents); // Pass availableIntents
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
    const parsed = await parseGPTResponse(response);
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
    const model = AI_MODELS.fast;

    // JSON mode supported by: gpt-4-turbo, gpt-4o, gpt-4o-mini, o1, o3
    // Since we always use gpt-4* models (from env or default), JSON mode is always supported
    const supportsJsonMode = true;

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

    // OPTIMIZATION: Use simple heuristic to detect potential approval-like messages
    // and skip URL extraction for them (they never contain URLs).
    const approvalKeywords = /^(да|yes|ок|ok|go|run|запусти|подтвер|approve|confirm|давай|start|lgtm|выполн)/i;
    const isLikelyApproval = approvalKeywords.test(message.trim());

    if (!isLikelyApproval) {
      logger.info('[INTENT_PARSER] ⚡ Fast path: Message is not approval, skipping URL extraction', {
        message: message.substring(0, 30),
      });
      return { extractedUrl: null, extractedMethod: null };
    }

    logger.info('[INTENT_PARSER] Possible approval detected, extracting URL from history', {
      message: message.substring(0, 30),
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
  // Build system prompt: combine full intent prompt + URL context (if found)
  let systemPrompt = prompt; // Full intent parsing instructions from buildIntentPrompt

  // If URL was extracted from history, add it as important context
  // (The prompt already contains rules for handling "URL FOUND IN HISTORY")
  if (historyData?.extractedUrl) {
    systemPrompt = `${prompt}

⚠️ URL FOUND IN HISTORY:
URL: ${historyData.extractedUrl}
Method: ${historyData.extractedMethod || 'Not specified'}

Use the rules above for "URL FOUND IN HISTORY" to determine the intent.`;
  }

  const messages: any[] = [
    {
      role: 'system',
      content: systemPrompt,
    },
  ];

  // Add chat history for context
  if (context?.chatHistory && context.chatHistory.length > 0) {
    messages.push(...context.chatHistory);
    logger.info('[INTENT_PARSER] Using chat history for context', {
      historyLength: context.chatHistory.length,
    });
  }

  // Add current message (use message directly, not prompt which contains only instructions)
  messages.push({ role: 'user', content: message });

  return messages;
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
async function parseGPTResponse(
  responseText: string
): Promise<IntentResult | null> {
  // Validate input
  if (!responseText || typeof responseText !== 'string' || responseText.trim().length === 0) {
    logger.warn('[INTENT_PARSER] Empty or invalid responseText in parseGPTResponse');
    return null;
  }

  // Limit response length to prevent ReDoS attacks
  const MAX_RESPONSE_LENGTH = 50000; // 50KB
  if (responseText.length > MAX_RESPONSE_LENGTH) {
    logger.warn('[INTENT_PARSER] Response text too long, truncating', {
      originalLength: responseText.length,
      maxLength: MAX_RESPONSE_LENGTH,
    });
    responseText = responseText.substring(0, MAX_RESPONSE_LENGTH);
  }

  // With JSON mode enabled, GPT should return valid JSON directly
  // But we keep fallbacks for edge cases (API errors, model issues, etc.)
  const extractionStrategies = [
    { name: 'direct', fn: () => extractDirectJSON(responseText) },  // Primary: JSON mode should work
    { name: 'markdown', fn: () => extractMarkdownJSON(responseText) },  // Fallback: if GPT wrapped in markdown
    { name: 'text', fn: () => extractJSONFromText(responseText) },  // Fallback: if GPT added extra text
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

// /**
//  * Strategy 4: Fix common issues and try parsing
//  * Fixes: single quotes → double quotes, trailing commas, comments
//  */
// function extractWithQuoteFix(text: string): IntentResult | null {
//   try {
//     let fixed = text;

//     // Remove single-line comments (// ...)
//     fixed = fixed.replace(/\/\/.*$/gm, '');

//     // Remove trailing commas before } or ]
//     fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

//     // Replace single quotes with double quotes (carefully)
//     // ⚠️ WARNING: This doesn't handle apostrophes in strings properly
//     // Only works for simple cases without apostrophes
//     fixed = fixed
//       .replace(/:\s*'([^']*)'/g, ': "$1"')  // Fix string values
//       .replace(/'([^']+)':/g, '"$1":');     // Fix property names

//     return JSON.parse(fixed);
//   } catch {
//     return null;
//   }
// }

/**
 * Strategy 5: Extract from markdown THEN fix quotes
 * Handles: ```json {'intent': 'api_test'} ```
 * Currently unused - may be used in future
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// function extractMarkdownWithQuoteFix(text: string): IntentResult | null {
//   // First extract from markdown
//   const extracted = extractMarkdownJSON(text);
//   if (!extracted) {
//     // Try to extract markdown content and then fix quotes
//     let match = text.match(/```json\s*([\s\S]*?)\s*```/);
//     if (!match) {
//       match = text.match(/```\s*([\s\S]*?)\s*```/);
//     }

//     if (match) {
//       // Apply quote fix to markdown content
//       return extractWithQuoteFix(match[1]);
//     }
//   }
//   return extracted;
// }

/**
 * Validate parsed intent result structure
 * FIX #2: Use centralized constants for validation
 * Note: Intent handler validation is done in intent-parsing.ts using hasHandler()
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

  // Validate intent_confidence (REQUIRED field from GPT)
  const parsedAny = parsed as any; // Temporary type for GPT response fields
  if (parsedAny.intent_confidence === undefined || parsedAny.intent_confidence === null) {
    logger.warn('[INTENT_PARSER] Missing intent_confidence field', { intent: parsed.intent });
    // Don't return null - will be calculated later if missing
  } else {
    const confidence = Number(parsedAny.intent_confidence);
    if (isNaN(confidence) || confidence < 0 || confidence > 1) {
      logger.warn('[INTENT_PARSER] Invalid intent_confidence value', {
        intent_confidence: parsedAny.intent_confidence,
        intent: parsed.intent,
      });
      // Don't return null - will be recalculated
    }
  }

  // Note: Intent validation against available handlers is done in intent-parsing.ts
  // using hasHandler() with proper fallback to general_chat

  // Validate intent-specific fields
  if (parsed.intent === 'api_test') {
    // apiUrl should be string if present
    if (parsed.apiUrl !== undefined && typeof parsed.apiUrl !== 'string') {
      logger.warn('[INTENT_PARSER] Invalid apiUrl type', { apiUrl: parsed.apiUrl });
      parsed.apiUrl = null;
    }

    // FIX #2: apiMethod validation using centralized constant (+ soft normalization)
    if (parsed.apiMethod !== undefined) {
      if (typeof parsed.apiMethod === 'string') {
        const upper = parsed.apiMethod.trim().toUpperCase();
        const map: Record<string, string> = {
          PST: 'POST',
          DEL: 'DELETE',
          GTE: 'GET',
          GETT: 'GET',
          PUTT: 'PUT',
          PATC: 'PATCH',
        };
        const normalized = map[upper] || upper;
        parsed.apiMethod = normalized;
        if (!VALID_HTTP_METHODS.includes(normalized as any)) {
          logger.warn('[INTENT_PARSER] Invalid HTTP method', {
            method: parsed.apiMethod,
            validMethods: VALID_HTTP_METHODS,
          });
        }
      }
    }

    // Soft fallback: if model returned api_test but missed apiUrl, try to extract a relative path from rawText.
    if ((!parsed.apiUrl || String(parsed.apiUrl).trim().length === 0) && typeof parsed.rawText === 'string') {
      const rel = parsed.rawText.match(/(^|\s)(\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%]+)(?=\s|$)/);
      if (rel?.[2]) {
        parsed.apiUrl = rel[2];
        parsed.isRelativePath = true;
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

  if (parsed.intent === 'needs_clarification') {
    // Validate required fields for needs_clarification
    if (!parsed.clarificationQuestion || typeof parsed.clarificationQuestion !== 'string') {
      logger.warn('[INTENT_PARSER] needs_clarification missing clarificationQuestion', {
        hasQuestion: !!parsed.clarificationQuestion,
      });
      // Don't return null - will use fallback
    }

    if (!parsed.possibleIntents || !Array.isArray(parsed.possibleIntents)) {
      logger.warn('[INTENT_PARSER] needs_clarification missing possibleIntents', {
        hasPossibleIntents: !!parsed.possibleIntents,
      });
    }

    if (!parsed.clarificationReason || typeof parsed.clarificationReason !== 'string') {
      logger.warn('[INTENT_PARSER] needs_clarification missing clarificationReason', {
        hasReason: !!parsed.clarificationReason,
      });
    }

    // Note: Removed strict confidence < 0.7 check for needs_clarification
    // AI should use needs_clarification only when critical info is truly missing
  }

  logger.debug('[INTENT_PARSER] Intent result validated successfully', {
    intent: parsed.intent,
    intent_confidence: (parsed as any).intent_confidence,
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
  // Validate inputs
  if (!parsed || typeof parsed !== 'object') {
    logger.error('[INTENT_PARSER] Invalid parsed object in finalizeIntentResult', { parsed });
    throw new Error('Invalid parsed intent result');
  }

  if (!message || typeof message !== 'string') {
    logger.warn('[INTENT_PARSER] Empty message in finalizeIntentResult');
    message = ''; // Fallback to empty string
  }

  const trimmedMessage = message.trim();

  // Step 1: Normalize intent string (trim whitespace)
  if (parsed.intent) {
    parsed.intent = parsed.intent.trim() as IntentType;
  }

  // Step 2: Always update rawText to ensure consistency
  parsed.rawText = trimmedMessage;

  // Step 3: Handle intent_confidence (new field from GPT) and map to confidence
  // GPT now returns intent_confidence, we map it to confidence for backward compatibility
  const parsedAny = parsed as any; // Temporary type for GPT response fields
  if (parsedAny.intent_confidence !== undefined && parsedAny.intent_confidence !== null) {
    const intentConf = Number(parsedAny.intent_confidence);
    if (!isNaN(intentConf) && intentConf >= 0 && intentConf <= 1) {
      parsed.confidence = intentConf;
      // Keep intent_confidence for reference in metadata
      if (!parsed.metadata) parsed.metadata = {};
      parsed.metadata.intent_confidence = intentConf;
    }
  }

  // Step 4: Calculate confidence if still missing
  if (parsed.confidence === undefined || parsed.confidence === null) {
    parsed.confidence = calculateConfidence(parsed, trimmedMessage);
    logger.debug('[INTENT_PARSER] Calculated missing confidence', {
      confidence: parsed.confidence,
      intent: parsed.intent,
    });
  }

  // Step 5: Normalize and clean fields based on intent type
  if (parsed.intent === 'api_test') {
    const extractAgentLevelFromText = (text: string): 'light' | 'medium' | 'hard' | undefined => {
      const lower = (text || '').toLowerCase();
      if (/\b(hard|хард)\b/i.test(lower)) return 'hard';
      if (/\b(medium|медиум)\b/i.test(lower)) return 'medium';
      if (/\b(light|лайт)\b/i.test(lower)) return 'light';
      return undefined;
    };

    const normalizeMethod = (m: string | undefined): string | undefined => {
      if (!m) return undefined;
      const upper = m.trim().toUpperCase();
      if (VALID_HTTP_METHODS.includes(upper as any)) return upper;
      // Common typos/short forms
      const map: Record<string, string> = {
        GETT: 'GET',
        GTE: 'GET',
        PST: 'POST',
        POS: 'POST',
        PUTT: 'PUT',
        DEL: 'DELETE',
        DELETEE: 'DELETE',
        PATC: 'PATCH',
      };
      const mapped = map[upper];
      return mapped && VALID_HTTP_METHODS.includes(mapped as any) ? mapped : undefined;
    };

    const extractApiUrlFromText = (text: string): { url?: string; isRelativePath: boolean } => {
      const t = text || '';
      // 1) Absolute URL
      const abs = t.match(/\bhttps?:\/\/[^\s)]+/i);
      if (abs?.[0]) {
        return { url: abs[0].replace(/[),.]+$/g, ''), isRelativePath: false };
      }

      // 2) Relative path starting with /
      const rel = t.match(/(^|\s)(\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%]+)(?=\s|$)/);
      if (rel?.[2]) {
        return { url: rel[2].replace(/[),.]+$/g, ''), isRelativePath: true };
      }

      // 3) Hostname without scheme (api.example.com/users)
      const host = t.match(/\b([a-z0-9.-]+\.[a-z]{2,})(\/[^\s)]*)?/i);
      if (host?.[0]) {
        const candidate = host[0].replace(/[),.]+$/g, '');
        return { url: `https://${candidate}`, isRelativePath: false };
      }

      return { url: undefined, isRelativePath: false };
    };

    // Clean and normalize apiMethod
    if (parsed.apiMethod) {
      const normalized = normalizeMethod(parsed.apiMethod);
      if (normalized) {
        parsed.apiMethod = normalized as any;
      } else {
        logger.warn('[INTENT_PARSER] Invalid HTTP method, resetting', {
          method: parsed.apiMethod,
          validMethods: VALID_HTTP_METHODS,
        });
        parsed.apiMethod = undefined;
      }
    } else {
      // Try to infer method from text if missing
      const methodMatch = trimmedMessage.match(/\b(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/i);
      const normalized = normalizeMethod(methodMatch?.[1]);
      if (normalized) {
        parsed.apiMethod = normalized as any;
      }
    }

    // Extract agent level (optional): prefer explicit field, fallback to text.
    const parsedAny2 = parsed as any;
    const explicitLevel =
      typeof parsedAny2.agentLevel === 'string'
        ? extractAgentLevelFromText(parsedAny2.agentLevel)
        : undefined;
    const inferredLevel = explicitLevel || extractAgentLevelFromText(trimmedMessage);
    if (inferredLevel) {
      parsed.metadata = { ...(parsed.metadata || {}), agentLevel: inferredLevel };
    }

    // Clean apiUrl and detect relative paths
    if (parsed.apiUrl) {
      parsed.apiUrl = parsed.apiUrl.trim();

      // Check for empty string AFTER trim
      if (parsed.apiUrl === '') {
        parsed.apiUrl = undefined;
        parsed.isRelativePath = false;
      } else {
        // isRelativePath should only mean "path without base host"
        parsed.isRelativePath = parsed.apiUrl.startsWith('/');

        // If it looks like a hostname without scheme, normalize to https://
        if (!parsed.apiUrl.startsWith('http://') && !parsed.apiUrl.startsWith('https://') && !parsed.apiUrl.startsWith('/')) {
          parsed.apiUrl = `https://${parsed.apiUrl}`;
          parsed.isRelativePath = false;
        }
      }
    } else {
      // Try to salvage apiUrl from raw message (absolute URL, /path, or hostname)
      const extracted = extractApiUrlFromText(trimmedMessage);
      if (extracted.url) {
        parsed.apiUrl = extracted.url;
        parsed.isRelativePath = extracted.isRelativePath;
      } else {
        parsed.isRelativePath = false;
      }
    }

    // Convert empty strings to undefined for consistency
    if (parsed.apiBody === '') parsed.apiBody = undefined;
  }

  // Step 5.1: Guardrail - prevent misclassification of regular websites as api_test
  // This happens often on short approval messages like "run it" when URL is extracted from history.
  // If url does not look like an API and message does not mention API/endpoint/method, treat as platform_test.
  if (parsed.intent === 'api_test' && parsed.apiUrl) {
    const messageLower = trimmedMessage.toLowerCase();
    const apiKeywords = ['api', 'endpoint', 'http', 'method', 'graphql', 'rest', 'swagger', 'postman'];
    const hasApiKeywordInMessage = apiKeywords.some((k) => messageLower.includes(k));
    const hasApiSpecificFields = !!(parsed.apiMethod || parsed.apiBody || parsed.apiHeaders);

    const looksLikeApiUrl = (() => {
      try {
        // If it's a relative path, it might be API path - keep api_test
        if (!parsed.apiUrl.startsWith('http://') && !parsed.apiUrl.startsWith('https://')) return true;

        const url = new URL(parsed.apiUrl);
        const host = url.hostname.toLowerCase();
        const path = url.pathname.toLowerCase();

        // Common API signals in host/path
        if (host === 'api' || host.startsWith('api.') || host.includes('.api.')) return true;
        if (path === '/api' || path.startsWith('/api/') || path.includes('/api/')) return true;
        if (path.startsWith('/graphql') || path.includes('/graphql')) return true;
        if (path.startsWith('/v1/') || path.startsWith('/v2/') || path.startsWith('/v3/')) return true;

        return false;
      } catch {
        return false;
      }
    })();

    if (!looksLikeApiUrl && !hasApiKeywordInMessage && !hasApiSpecificFields) {
      logger.warn('[INTENT_PARSER] Correcting misclassified api_test to platform_test (regular website URL)', {
        apiUrl: parsed.apiUrl,
        messagePreview: trimmedMessage.substring(0, 30),
        intent_confidence: parsed.metadata?.intent_confidence ?? parsed.confidence,
      });

      // Convert to platform_test
      const pageUrl = parsed.apiUrl;
      parsed.intent = 'platform_test';
      parsed.page = pageUrl;
      parsed.apiUrl = undefined;
      parsed.apiMethod = undefined;
      parsed.apiBody = undefined;
      parsed.apiHeaders = undefined;
      parsed.isRelativePath = false;

      // Recalculate confidence after intent change
      parsed.confidence = calculateConfidence(parsed, trimmedMessage);

      parsed.metadata = {
        ...parsed.metadata,
        correction: 'api_test->platform_test',
        correctionReason: 'URL looks like website and no API signals in message',
        recalculatedConfidence: parsed.confidence,
      };
    }
  }

  // Step 5.2: Finalize platform_test URL normalization and cleanup
  if (parsed.intent === 'platform_test') {
    // Clean and normalize page URL (consolidated from multiple places)
    if (parsed.page) {
      parsed.page = parsed.page.trim();

      // Check for empty string AFTER trim
      if (parsed.page === '') {
        parsed.page = null;
      } else {
        // Add protocol if missing (for bare domains like example.com)
        if (!parsed.page.startsWith('http://') && !parsed.page.startsWith('https://')) {
          parsed.page = `https://${parsed.page}`;
        }
      }
    }

    // Convert empty strings to null
    if (parsed.target === '') parsed.target = null;

    // FIX #2: Normalize scope using centralized constant
    if (parsed.scope) {
      const trimmedScope = parsed.scope.trim().toLowerCase();
      if (VALID_SCOPES.includes(trimmedScope as any)) {
        parsed.scope = trimmedScope as any;
      } else {
        logger.warn('[INTENT_PARSER] Invalid scope provided, will use fallback', {
          provided: parsed.scope,
          normalized: trimmedScope,
          validScopes: VALID_SCOPES,
        });
        // ✅ FIX: Don't keep invalid scope - set to null so system can use default
        parsed.scope = null;
      }
    }

    // Reset isRelativePath for platform_test
    parsed.isRelativePath = false;
  }

  if (parsed.intent === 'needs_clarification') {
    // Validate that GPT provided clarificationQuestion
    if (!parsed.clarificationQuestion || typeof parsed.clarificationQuestion !== 'string') {
      logger.warn('[INTENT_PARSER] GPT returned needs_clarification but no clarificationQuestion, using fallback');
      parsed.clarificationQuestion = "I need more information to help you. Could you provide more details?";
    } else {
      // Clean and trim clarification question
      parsed.clarificationQuestion = parsed.clarificationQuestion.trim();
      if (parsed.clarificationQuestion === '') {
        parsed.clarificationQuestion = "Could you provide more details?";
      }
    }

    // Validate possibleIntents
    if (!parsed.possibleIntents || !Array.isArray(parsed.possibleIntents) || parsed.possibleIntents.length === 0) {
      logger.warn('[INTENT_PARSER] GPT returned needs_clarification but no possibleIntents, using fallback');
      parsed.possibleIntents = ['api_test', 'platform_test', 'general_chat'];
    }

    // Validate clarificationReason
    if (!parsed.clarificationReason || typeof parsed.clarificationReason !== 'string') {
      logger.debug('[INTENT_PARSER] GPT returned needs_clarification but no clarificationReason, using fallback');
      parsed.clarificationReason = 'Insufficient information to determine intent';
    } else {
      parsed.clarificationReason = parsed.clarificationReason.trim();
      if (parsed.clarificationReason === '') {
        parsed.clarificationReason = 'Unclear user intent';
      }
    }
  }

  // Step 6: Add/update metadata with timestamps and processing info
  parsed.metadata = {
    ...parsed.metadata,
    parsedAt: new Date().toISOString(),
    model: AI_MODELS.fast,
    messageLength: trimmedMessage.length,
  };

  // Step 7: Log intent for monitoring (no validation against hardcoded list)
  logger.info('[INTENT_PARSER] Intent parsed', {
    intent: parsed.intent,
    confidence: parsed.intent_confidence,
  });

  // Step 8: Final validation and logging
  logger.info('[INTENT_PARSER] Intent finalized successfully', {
    intent: parsed.intent,
    confidence: parsed.confidence,
    hasApiUrl: !!parsed.apiUrl,
    hasPage: !!parsed.page,
    isRelativePath: parsed.isRelativePath,
    messageLength: trimmedMessage.length,
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

  const trimmedMessage = message.trim();
  let confidence = 0.5; // Base confidence

  // needs_clarification: should have LOW confidence
  if (intentResult.intent === 'needs_clarification') {
    confidence = 0.3; // Low base confidence for unclear intents

    // If has possibleIntents, slightly higher
    if (intentResult.possibleIntents && intentResult.possibleIntents.length > 0) {
      confidence += 0.1;
    }

    // If has clarificationQuestion, it's properly formed
    if (intentResult.clarificationQuestion && intentResult.clarificationQuestion.length > 10) {
      confidence += 0.1;
    }

    return Math.min(confidence, MIN_CLARIFICATION_CONFIDENCE_CAP); // Cap at 0.65 for needs_clarification
  }

  // Platform test confidence boosters
  if (intentResult.intent === 'platform_test') {
    // No URL-format heuristics here: rely on the model + other signals (scope/target/message).

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

    // Validate API URL has meaningful content (stricter length check)
    if (intentResult.apiUrl && intentResult.apiUrl.length > MIN_API_URL_LENGTH) {
      confidence += 0.2;
    }

    // Bonus for having both method and URL
    if (intentResult.apiMethod && intentResult.apiUrl) {
      confidence += 0.1;
    }
  }

  // General chat confidence boosters
  if (intentResult.intent === 'general_chat') {
    const lowerMessage = trimmedMessage.toLowerCase();

    // Check if message is a question
    if (trimmedMessage.includes('?')) confidence += 0.2;

    // Check if message has no URL (less likely to be testing request)
    if (!trimmedMessage.match(/https?:\/\//)) confidence += 0.1;

    // Check for common greeting/help words
    const helpWords = ['what', 'how', 'help', 'explain', 'tell', 'show', 'hi', 'hello', 'thanks', 'why', 'did', 'have'];
    if (helpWords.some(word => lowerMessage.includes(word))) {
      confidence += 0.1;
    }
  }

  // Message length adjustments (applies to all intents except needs_clarification)
  if (intentResult.intent !== 'needs_clarification') {
    // Very short messages (< 5 chars) are often approvals or unclear
    if (trimmedMessage.length < VERY_SHORT_MESSAGE_LENGTH) {
      confidence -= 0.1;
    }

    // Long, detailed messages are usually more confident
    if (trimmedMessage.length > DETAILED_MESSAGE_LENGTH) {
      confidence += 0.05;
    }
  }

  // Cap at 1.0
  return Math.min(confidence, 1.0);
}

/**
 * Get cached rules with smart fallback logic
 * Tries exact language match first, then falls back to other languages.
 */
function getCachedRulesWithFallback(
  userLanguage: 'en' | 'ru' | 'neutral'
): { content: string; language: 'en' | 'ru'; fallbackUsed: boolean } | null {
  try {
    // Step 1: Try exact language match (if not neutral)
    if (userLanguage !== 'neutral') {
      const exactRules = RulesCacheService.getRules(userLanguage as 'en' | 'ru');
      if (exactRules) {
        return {
          content: exactRules,
          language: userLanguage as 'en' | 'ru',
          fallbackUsed: false,
        };
      }
    }

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
