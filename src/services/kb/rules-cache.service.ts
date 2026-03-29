/**
 * Rules Cache Service
 *
 * Loads AI response rules (general_ai_rules.md) once at startup and caches them in memory.
 * This eliminates the need for repeated searchKB() calls for rules on every request.
 *
 * Performance impact:
 * - Before: ~200-300ms searchKB() on every request
 * - After: ~0ms (in-memory lookup)
 * - Memory: ~14-20 MB for 2 languages
 */

import { logger } from '@/utils/core/logger';
import { KBChunk, searchKB } from './kb.service';

interface CachedRules {
  content: string;
  chunks: KBChunk[];
  loadedAt: number;
  language: 'en' | 'ru';
}

export class RulesCacheService {
  private static cache = new Map<string, CachedRules>();
  private static isInitialized = false;
  private static SUPPORTED_LANGUAGES: Array<'en' | 'ru'> = ['en', 'ru'];

  /**
   * Initialize the cache by loading rules for all supported languages
   * Should be called once at application startup
   */
  static async init(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('[RULES_CACHE] Already initialized');
      return;
    }

    const results = await Promise.allSettled(
      this.SUPPORTED_LANGUAGES.map((lang) => this.loadRules(lang))
    );

    let failCount = 0;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failCount++;
        logger.error(`[RULES_CACHE] Failed to load rules for ${this.SUPPORTED_LANGUAGES[index]}`, {
          error: result.reason,
        });
      }
    });

    this.isInitialized = true;
  }

  /**
   * Load rules for a specific language from KB
   */
  static async loadRules(language: 'en' | 'ru'): Promise<CachedRules> {
    try {
      // Search for rules with specific query to find general_ai_rules.md
      const searchResults = await searchKB('AI response guidelines rules communication style', undefined, {
        matchCount: 10, // Get more chunks to ensure we get all rules
        matchThreshold: 0.4, // Lower threshold to catch all relevant rules
        language, // Filter by language
      });

      if (searchResults.chunks.length === 0) {
        throw new Error(`No rules found for language: ${language}`);
      }

      // Filter chunks that are actually from rules files
      const rulesChunks = searchResults.chunks.filter(
        (chunk) =>
          chunk.source_file?.includes('rules') ||
          chunk.source_file?.includes('general_ai')
      );

      if (rulesChunks.length === 0) {
        logger.warn(`[RULES_CACHE] No rules chunks found for ${language}, using all search results`);
        // Fallback to all chunks if no specific rules found
        rulesChunks.push(...searchResults.chunks);
      }

      // Combine chunks into single text
      const content = rulesChunks
        .map((chunk) => chunk.content)
        .join('\n\n');

      // Cache the rules
      const cachedRules: CachedRules = {
        content,
        chunks: rulesChunks,
        loadedAt: Date.now(),
        language,
      };

      this.cache.set(language, cachedRules);

      return cachedRules;
    } catch (error) {
      const errorMessage = error instanceof Error && error.message
        ? error.message
        : (error ? String(error) : `Unknown error loading rules for ${language}`);

      logger.error(`[RULES_CACHE] Failed to load rules for ${language}`, {
        error,
        errorMessage,
        errorType: error?.constructor?.name,
      });

      // Re-throw with proper message
      throw new Error(errorMessage);
    }
  }

  /**
   * Get cached rules for a language
   * Returns null if not cached or not initialized
   */
  static getRules(language: 'en' | 'ru'): string | null {
    // Check if cache is initialized
    if (!this.isInitialized) {
      logger.warn(`[RULES_CACHE] Cache not initialized yet, language: ${language}`);
      return null;
    }

    const cached = this.cache.get(language);

    if (!cached) {
      logger.debug(`[RULES_CACHE] Cache miss for language: ${language}`, {
        availableLanguages: Array.from(this.cache.keys()),
        cacheSize: this.cache.size,
        isInitialized: this.isInitialized,
      });
      return null;
    }

    logger.debug(`[RULES_CACHE] Cache hit for language: ${language}`, {
      chunksCount: cached.chunks?.length || 0,
      contentLength: cached.content?.length || 0,
      age: `${Math.floor((Date.now() - cached.loadedAt) / 1000)}s`,
    });

    return cached.content;
  }

  /**
   * Get cached rules with metadata
   */
  static getRulesWithMetadata(language: 'en' | 'ru'): CachedRules | null {
    return this.cache.get(language) || null;
  }

  /**
   * Reload rules for specific language or all languages
   */
  static async reloadRules(language?: 'en' | 'ru'): Promise<void> {
    if (language) {
      logger.info(`[RULES_CACHE] Reloading rules for ${language}`);
      await this.loadRules(language);
    } else {
      logger.info('[RULES_CACHE] Reloading rules for all languages');
      await Promise.allSettled(
        this.SUPPORTED_LANGUAGES.map((lang) => this.loadRules(lang))
      );
    }
  }

  /**
   * Clear cache for specific language or all
   */
  static clear(language?: 'en' | 'ru'): void {
    if (language) {
      this.cache.delete(language);
      logger.info(`[RULES_CACHE] Cleared cache for ${language}`);
    } else {
      this.cache.clear();
      logger.info('[RULES_CACHE] Cleared entire cache');
    }
  }

  /**
   * Get cache statistics
   */
  static getStats() {
    const stats = {
      isInitialized: this.isInitialized,
      languages: {} as Record<string, {
        isCached: boolean;
        chunksCount?: number;
        contentLength?: number;
        age?: number;
      }>,
    };

    this.SUPPORTED_LANGUAGES.forEach((lang) => {
      const cached = this.cache.get(lang);
      if (cached) {
        stats.languages[lang] = {
          isCached: true,
          chunksCount: cached.chunks.length,
          contentLength: cached.content.length,
          age: Date.now() - cached.loadedAt,
        };
      } else {
        stats.languages[lang] = {
          isCached: false,
        };
      }
    });

    return stats;
  }

  /**
   * Check if cache is ready
   */
  static isReady(): boolean {
    return this.isInitialized && this.cache.size > 0;
  }
}
