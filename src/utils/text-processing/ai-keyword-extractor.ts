/**
 * AI-powered keyword extraction
 * Uses fast AI models (Gemini Flash or GPT-4o-mini) to extract meaningful keywords
 * from user intent descriptions in any language
 *
 * Benefits:
 * - Language-agnostic: works for English, Russian, Turkish, Arabic, Chinese, etc.
 * - Context-aware: understands semantic meaning vs stop words
 * - Fast: 100-200ms with Gemini Flash
 * - Cached: subsequent calls are instant
 */

import { generateText } from '@/services/ai/core/ai-provider.service';
import { logger } from '@/utils/core/logger';

/** Cache: description hash → keywords */
// const keywordCache = new Map<string, string[]>();

/** Max cache size (prevent memory leak) */
const MAX_CACHE_SIZE = 1000;

/** Cache TTL (clear old entries after 1 hour) */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Cache entry with timestamp */
interface CacheEntry {
  keywords: string[];
  timestamp: number;
}

/** Enhanced cache with TTL */
const enhancedCache = new Map<string, CacheEntry>();

/**
 * Compute simple hash for text
 */
function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(36);
}

/**
 * Clean old cache entries (LRU-style)
 */
function cleanCache(): void {
  if (enhancedCache.size < MAX_CACHE_SIZE) return;

  const now = Date.now();
  const entriesToDelete: string[] = [];

  // Remove expired entries
  for (const [key, entry] of enhancedCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      entriesToDelete.push(key);
    }
  }

  // If still too many, remove oldest 20%
  if (enhancedCache.size - entriesToDelete.length >= MAX_CACHE_SIZE) {
    const sortedEntries = Array.from(enhancedCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = Math.floor(enhancedCache.size * 0.2);
    for (let i = 0; i < toRemove; i++) {
      entriesToDelete.push(sortedEntries[i][0]);
    }
  }

  entriesToDelete.forEach(key => enhancedCache.delete(key));

  if (entriesToDelete.length > 0) {
    logger.debug('[AI_KEYWORD_EXTRACTOR] Cache cleaned', {
      removed: entriesToDelete.length,
      remaining: enhancedCache.size,
    });
  }
}

/**
 * Extract keywords using fast AI model (Gemini Flash by default)
 * Falls back to regex if AI unavailable
 *
 * @param description - User intent description in any language
 * @returns Array of important keywords (lowercase, trimmed)
 *
 * @example
 * // English
 * await extractKeywordsWithAI("Click on the login button")
 * // → ["login"]
 *
 * // Russian
 * await extractKeywordsWithAI("Нажми на кнопку входа")
 * // → ["входа"]
 *
 * // Turkish
 * await extractKeywordsWithAI("Giriş butonuna tıkla")
 * // → ["giriş"]
 */
export async function extractKeywordsWithAI(description: string): Promise<string[]> {
  if (!description || description.trim().length === 0) {
    return [];
  }

  // 1. Check cache
  const hash = simpleHash(description);
  const cached = enhancedCache.get(hash);
  if (cached) {
    logger.debug('[AI_KEYWORD_EXTRACTOR] Cache hit', { description: description.slice(0, 50) });
    return cached.keywords;
  }

  // 2. Clean cache if needed
  cleanCache();

  try {
    // 3. Call fast AI model (Gemini Flash or GPT-4o-mini)
    const prompt = `Extract important keywords from this user intent. Remove stop words, generic action words (click, type, enter, fill, press, select, button, field, link, input, box, form, element), and articles. Return ONLY comma-separated keywords in lowercase, no explanation.

User intent: "${description}"

Keywords:`;

    const response = await generateText({
      prompt,
      task: 'fast', // Uses Gemini Flash by default (configured in .env)
      temperature: 0,
      maxTokens: 50,
      timeout: 2000, // Hard 2s timeout
    });

    // 4. Parse response
    const keywords = response.content
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0 && k.length <= 50); // Sanity check

    // 5. Cache result
    enhancedCache.set(hash, {
      keywords,
      timestamp: Date.now(),
    });

    logger.debug('[AI_KEYWORD_EXTRACTOR] Keywords extracted', {
      description: description.slice(0, 50),
      keywords,
      provider: response.usage.provider,
      model: response.usage.model,
      tokensUsed: response.usage.totalTokens,
    });

    return keywords;

  } catch (error) {
    logger.warn('[AI_KEYWORD_EXTRACTOR] AI failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
      description: description.slice(0, 50),
    });

    // 6. Fallback: simple regex (language-agnostic)
    // Keep words > 2 chars, remove punctuation
    const fallbackKeywords = description
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ') // Unicode-aware: keep letters + numbers
      .split(/\s+/)
      .filter(word => word.length > 2); // Keep words longer than 2 chars

    // Cache fallback result too (avoid repeated AI calls on failure)
    enhancedCache.set(hash, {
      keywords: fallbackKeywords,
      timestamp: Date.now(),
    });

    return fallbackKeywords;
  }
}

/**
 * Synchronous keyword extraction fallback (regex-based)
 * Use when async is not possible (rare cases)
 *
 * @param description - User intent description
 * @returns Array of keywords (basic filtering)
 */
export function extractKeywordsSync(description: string): string[] {
  if (!description || description.trim().length === 0) {
    return [];
  }

  // Simple stop words list (English only, for fallback)
  const stopWords = new Set([
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with', 'and', 'or',
    'enter', 'fill', 'type', 'click', 'press', 'select', 'input', 'field',
    'button', 'link', 'into', 'please', 'should', 'want', 'need', 'put',
    'this', 'value', 'box', 'form', 'element', 'of', 'is', 'are', 'from',
  ]);

  return description
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

/**
 * Clear keyword cache (for testing or memory management)
 */
export function clearKeywordCache(): void {
  enhancedCache.clear();
  logger.debug('[AI_KEYWORD_EXTRACTOR] Cache cleared');
}
