/**
 * Observer Cache
 * Caches Observer results for unchanged pages to avoid redundant AI calls.
 * Key: URL + contentHash
 * TTL: 10s (covers 2-3 iterations on same page)
 * Max entries: 5
 */

import { logger } from '@/utils/core/logger';
import type { ObserverOutput } from './types';

interface CacheEntry {
  output: ObserverOutput;
  timestamp: number;
  url: string;
}

export class ObserverCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly TTL_MS = 10_000; // 10 seconds
  private readonly MAX_ENTRIES = 5;

  /**
   * Build cache key from URL and content hash
   */
  private buildKey(url: string, contentHash: string): string {
    return `${url}|${contentHash}`;
  }

  /**
   * Get cached observer output if still valid
   */
  get(url: string, contentHash: string): ObserverOutput | null {
    const key = this.buildKey(url, contentHash);
    const entry = this.cache.get(key);

    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > this.TTL_MS) {
      this.cache.delete(key);
      logger.debug('[OBSERVER_CACHE] Entry expired', { url: url.slice(0, 50) });
      return null;
    }

    logger.debug('[OBSERVER_CACHE] Cache hit', { url: url.slice(0, 50) });
    return entry.output;
  }

  /**
   * Store observer output in cache
   */
  set(url: string, contentHash: string, output: ObserverOutput): void {
    const key = this.buildKey(url, contentHash);

    // Evict if at capacity (remove oldest)
    if (this.cache.size >= this.MAX_ENTRIES && !this.cache.has(key)) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { output, timestamp: Date.now(), url });
    logger.debug('[OBSERVER_CACHE] Cached observation', {
      url: url.slice(0, 50),
      cacheSize: this.cache.size,
    });
  }

  /**
   * Invalidate all entries for a URL (URL change, state_changed, modal dismiss)
   * Compares by origin+pathname to handle query string changes (e.g., /login → /login?error=1)
   */
  invalidateForUrl(url: string): void {
    const targetBase = ObserverCache.getUrlBase(url);
    for (const [key, entry] of this.cache) {
      if (ObserverCache.getUrlBase(entry.url) === targetBase) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Extract origin+pathname for comparison (ignores query params and hash)
   */
  private static getUrlBase(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size;
  }
}
