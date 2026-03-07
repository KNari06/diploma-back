import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';

/**
 * Lightweight Redis cache utility.
 * All operations are fail-safe: errors are logged but never thrown,
 * so the caller always falls through to the database on cache miss/error.
 */
export const cache = {
  /**
   * Get a cached value by key. Returns null on miss or error.
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const raw = await redisConnection.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn('[CACHE] get failed', { key, error: (err as Error).message });
      return null;
    }
  },

  /**
   * Set a cached value with TTL in seconds.
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await redisConnection.set(key, serialized, 'EX', ttlSeconds);
    } catch (err) {
      logger.warn('[CACHE] set failed', { key, error: (err as Error).message });
    }
  },

  /**
   * Delete one or more cache keys.
   */
  async del(...keys: string[]): Promise<void> {
    try {
      if (keys.length === 0) return;
      await redisConnection.del(...keys);
    } catch (err) {
      logger.warn('[CACHE] del failed', { keys, error: (err as Error).message });
    }
  },

  /**
   * Delete all keys matching a glob pattern (uses SCAN, safe for production).
   * Example: cache.delByPattern('qait:cache:projects:ws:abc:*')
   */
  async delByPattern(pattern: string): Promise<void> {
    try {
      const stream = redisConnection.scanStream({ match: pattern, count: 100 });
      const pipeline = redisConnection.pipeline();
      let count = 0;

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (keys: string[]) => {
          for (const key of keys) {
            pipeline.del(key);
            count++;
          }
        });
        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      if (count > 0) {
        await pipeline.exec();
      }
    } catch (err) {
      logger.warn('[CACHE] delByPattern failed', { pattern, error: (err as Error).message });
    }
  },
};
