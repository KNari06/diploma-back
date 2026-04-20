/**
 * Rules Cache Service
 *
 * Loads AI response rules from data/global-kb/en/qait-platform/*.md once at
 * startup and caches them in memory. No RAG, no searchKB — rules are
 * deterministic text we always want in every prompt, so we read the files
 * directly.
 *
 * Performance impact:
 * - Before:  ~200-300ms searchKB() on every request
 * - After:   ~0ms (in-memory lookup)
 * - Memory:  ~50 KB (whole qait-platform folder concatenated)
 *
 * The "en"/"ru" split is kept for API compatibility with existing callers,
 * but both return the same content now (source is English-only; the AI
 * translates at runtime based on user language).
 */

import fs from 'fs/promises';
import path from 'path';
import { logger } from '@/utils/core/logger';

interface CachedRules {
  content: string;
  loadedAt: number;
  language: 'en' | 'ru';
  sourceFiles: string[];
}

const RULES_DIR_CANDIDATES = [
  path.join(process.cwd(), 'data/global-kb/en/qait-platform'),
  path.join(process.cwd(), '../data/global-kb/en/qait-platform'),
  path.join(__dirname, '../../../data/global-kb/en/qait-platform'),
  path.join(__dirname, '../../../../data/global-kb/en/qait-platform'),
];

export class RulesCacheService {
  private static cache = new Map<string, CachedRules>();
  private static isInitialized = false;
  private static readonly SUPPORTED_LANGUAGES: Array<'en' | 'ru'> = ['en', 'ru'];

  /**
   * Initialize the cache. Called once at application startup.
   */
  static async init(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('[RULES_CACHE] Already initialized');
      return;
    }

    const { content, files } = await this.readRulesFromDisk();

    for (const lang of this.SUPPORTED_LANGUAGES) {
      this.cache.set(lang, {
        content,
        loadedAt: Date.now(),
        language: lang,
        sourceFiles: files,
      });
    }

    this.isInitialized = true;
    logger.info('[RULES_CACHE] Initialized', {
      filesLoaded: files.length,
      contentLength: content.length,
      languages: this.SUPPORTED_LANGUAGES,
    });
  }

  /**
   * Get cached rules for a language. Returns null if not initialized.
   */
  static getRules(language: 'en' | 'ru'): string | null {
    if (!this.isInitialized) {
      logger.warn('[RULES_CACHE] Not initialized yet', { language });
      return null;
    }

    const cached = this.cache.get(language);
    return cached?.content ?? null;
  }

  /**
   * Get cached rules with metadata.
   */
  static getRulesWithMetadata(language: 'en' | 'ru'): CachedRules | null {
    return this.cache.get(language) ?? null;
  }

  /**
   * Reload rules from disk (picks up edits without server restart).
   * The `language` arg is accepted for API compatibility but ignored — rules
   * are source-language-agnostic.
   */
  static async reloadRules(_language?: 'en' | 'ru'): Promise<void> {
    logger.info('[RULES_CACHE] Reloading rules from disk');

    const { content, files } = await this.readRulesFromDisk();
    const now = Date.now();

    for (const lang of this.SUPPORTED_LANGUAGES) {
      this.cache.set(lang, {
        content,
        loadedAt: now,
        language: lang,
        sourceFiles: files,
      });
    }

    logger.info('[RULES_CACHE] Reloaded', {
      filesLoaded: files.length,
      contentLength: content.length,
    });
  }

  /**
   * Clear cache.
   */
  static clear(language?: 'en' | 'ru'): void {
    if (language) {
      this.cache.delete(language);
      logger.info(`[RULES_CACHE] Cleared cache for ${language}`);
    } else {
      this.cache.clear();
      this.isInitialized = false;
      logger.info('[RULES_CACHE] Cleared entire cache');
    }
  }

  /**
   * Get cache statistics.
   */
  static getStats() {
    const stats = {
      isInitialized: this.isInitialized,
      languages: {} as Record<string, {
        isCached: boolean;
        contentLength?: number;
        age?: number;
        sourceFiles?: string[];
      }>,
    };

    for (const lang of this.SUPPORTED_LANGUAGES) {
      const cached = this.cache.get(lang);
      stats.languages[lang] = cached
        ? {
            isCached: true,
            contentLength: cached.content.length,
            age: Date.now() - cached.loadedAt,
            sourceFiles: cached.sourceFiles,
          }
        : { isCached: false };
    }

    return stats;
  }

  /**
   * Check if cache is ready.
   */
  static isReady(): boolean {
    return this.isInitialized && this.cache.size > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────────────

  private static async resolveRulesDir(): Promise<string> {
    for (const candidate of RULES_DIR_CANDIDATES) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          return candidate;
        }
      } catch {
        // Try next candidate
      }
    }
    throw new Error(
      `Rules directory not found. Searched: ${RULES_DIR_CANDIDATES.join(', ')}`
    );
  }

  private static async readRulesFromDisk(): Promise<{ content: string; files: string[] }> {
    const rulesDir = await this.resolveRulesDir();
    const entries = await fs.readdir(rulesDir, { withFileTypes: true });

    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort(); // Stable order so prompt is deterministic across boots

    if (mdFiles.length === 0) {
      throw new Error(`No .md files found in rules directory: ${rulesDir}`);
    }

    const parts: string[] = [];
    const loadedFiles: string[] = [];

    for (const fileName of mdFiles) {
      try {
        const content = await fs.readFile(path.join(rulesDir, fileName), 'utf-8');
        if (content.trim().length > 0) {
          parts.push(content.trim());
          loadedFiles.push(fileName);
        }
      } catch (error) {
        logger.warn('[RULES_CACHE] Failed to read rules file (skipping)', {
          fileName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (parts.length === 0) {
      throw new Error(`All rules files were unreadable in: ${rulesDir}`);
    }

    return {
      content: parts.join('\n\n---\n\n'),
      files: loadedFiles,
    };
  }
}
