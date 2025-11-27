/**
 * Selector Cache Service
 * Multi-tenant cache with SHA256 keys and versioning
 */

import { logger } from '@/utils/logger';
import type {
  CacheKeyComponents,
  CachedSelectorResult,
  SelectorResolveResponse,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const ENGINE_VERSION = '1.0.0'; // Selector engine version
const MODEL_VERSION = 'gpt-4o-2024-11-20'; // AI model version
const CACHE_TTL = 3600; // 1 hour in seconds

// ═══════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE (temporary, will be replaced with Redis)
// ═══════════════════════════════════════════════════════════════════════════

const memoryCache = new Map<string, CachedSelectorResult>();

// ═══════════════════════════════════════════════════════════════════════════
// SELECTOR CACHE SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class SelectorCacheService {
  /**
   * Generate cache key using SHA256
   * Format: SHA256(projectId + '|' + intent_norm + '|' + domHash + '|' + viewport + '|' + model_version + '|' + engine_version)
   */
  static async generateCacheKey(components: CacheKeyComponents): Promise<string> {
    const {
      projectId,
      intent,
      domHash,
      viewport,
      modelVersion = MODEL_VERSION,
      engineVersion = ENGINE_VERSION,
    } = components;

    // Normalize intent (lowercase, trim, remove extra spaces)
    const intentNorm = intent.toLowerCase().trim().replace(/\s+/g, ' ');

    // Build key string
    const keyString = [
      projectId,
      intentNorm,
      domHash,
      viewport,
      modelVersion,
      engineVersion,
    ].join('|');

    // Generate SHA256 hash
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256').update(keyString).digest('hex');

    return `ai-selector:${hash}`;
  }

  /**
   * Get cached selector result
   */
  static async get(cacheKey: string): Promise<SelectorResolveResponse | null> {
    try {
      const cached = memoryCache.get(cacheKey);

      if (!cached) {
        logger.debug('[SELECTOR_CACHE] Cache miss', { cacheKey });
        return null;
      }

      // Check expiration
      if (Date.now() > cached.expiresAt) {
        memoryCache.delete(cacheKey);
        logger.debug('[SELECTOR_CACHE] Cache expired', { cacheKey });
        return null;
      }

      // Update hit count
      cached.hitCount++;

      logger.info('[SELECTOR_CACHE] Cache hit', {
        cacheKey,
        hitCount: cached.hitCount,
        age: `${Math.round((Date.now() - cached.createdAt) / 1000)}s`,
      });

      // Return result with cache flag
      return {
        ...cached.result,
        metrics: {
          ...cached.result.metrics,
          cacheHit: true,
        },
      };
    } catch (error) {
      logger.error('[SELECTOR_CACHE] Failed to get from cache', { error, cacheKey });
      return null;
    }
  }

  /**
   * Set cache result
   */
  static async set(
    cacheKey: string,
    result: SelectorResolveResponse,
    ttl: number = CACHE_TTL
  ): Promise<void> {
    try {
      const now = Date.now();

      const cachedResult: CachedSelectorResult = {
        cacheKey,
        result,
        createdAt: now,
        expiresAt: now + ttl * 1000,
        hitCount: 0,
      };

      memoryCache.set(cacheKey, cachedResult);

      logger.info('[SELECTOR_CACHE] Cached result', {
        cacheKey,
        ttl: `${ttl}s`,
        success: result.success,
      });
    } catch (error) {
      logger.error('[SELECTOR_CACHE] Failed to set cache', { error, cacheKey });
    }
  }

  /**
   * Clear cache (for testing or after engine updates)
   */
  static async clear(projectId?: string): Promise<void> {
    if (projectId) {
      // Clear only for specific project
      const keysToDelete: string[] = [];
      for (const [key, value] of memoryCache.entries()) {
        // Check if cache key belongs to project (TODO: better indexing)
        if (key.includes(projectId)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => memoryCache.delete(key));
      logger.info('[SELECTOR_CACHE] Cleared project cache', {
        projectId,
        cleared: keysToDelete.length,
      });
    } else {
      // Clear all
      memoryCache.clear();
      logger.info('[SELECTOR_CACHE] Cleared all cache');
    }
  }

  /**
   * Get cache stats
   */
  static getCacheStats(): {
    size: number;
    hits: number;
    avgAge: number;
  } {
    const now = Date.now();
    let totalHits = 0;
    let totalAge = 0;

    for (const [_, cached] of memoryCache.entries()) {
      totalHits += cached.hitCount;
      totalAge += now - cached.createdAt;
    }

    return {
      size: memoryCache.size,
      hits: totalHits,
      avgAge: memoryCache.size > 0 ? Math.round(totalAge / memoryCache.size / 1000) : 0,
    };
  }
}
