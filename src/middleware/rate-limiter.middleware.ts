/**
 * Rate Limiter Middleware
 * Per-user rate limiting for sensitive endpoints (test run/retry)
 *
 * Uses in-memory store with sliding window algorithm
 * Prevents rapid fire requests from frontend that could cause duplicate tests
 */

import { logger } from '@/utils/core/logger';
import { NextFunction, Request, Response } from 'express';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

// In-memory store (per-process, resets on restart)
// For production with multiple instances, consider using Redis
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of rateLimitStore.entries()) {
    // Remove entries older than 10 minutes
    if (now - entry.windowStart > 10 * 60 * 1000) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug('[RATE_LIMITER] Cleaned old entries', { cleaned, remaining: rateLimitStore.size });
  }
}, 5 * 60 * 1000);

/**
 * Create a rate limiter middleware for specific endpoints
 *
 * @param options - Rate limit configuration
 * @param options.windowMs - Time window in milliseconds (default: 10000 = 10 seconds)
 * @param options.maxRequests - Max requests per window per user (default: 2)
 * @param options.keyPrefix - Prefix for rate limit key (to separate different endpoints)
 * @returns Express middleware
 */
export function createRateLimiter(options: {
  windowMs?: number;
  maxRequests?: number;
  keyPrefix?: string;
}) {
  const windowMs = options.windowMs || 10000; // 10 seconds default
  const maxRequests = options.maxRequests || 2; // 2 requests per window default
  const keyPrefix = options.keyPrefix || 'default';

  return (req: Request, res: Response, next: NextFunction): void => {
    // Get user ID from authenticated request
    const userId = req.user?.id;

    if (!userId) {
      // If not authenticated, let auth middleware handle it
      next();
      return;
    }

    const key = `${keyPrefix}:${userId}`;
    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      // New window or window expired - reset
      rateLimitStore.set(key, { count: 1, windowStart: now });
      next();
      return;
    }

    // Within window - check count
    if (entry.count >= maxRequests) {
      const retryAfterMs = windowMs - (now - entry.windowStart);
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      logger.warn('[RATE_LIMITER] Rate limit exceeded', {
        userId: userId.substring(0, 8) + '...',
        endpoint: keyPrefix,
        count: entry.count,
        maxRequests,
        retryAfterMs,
      });

      res.status(429).json({
        success: false,
        error: 'Too many requests',
        message: `Rate limit exceeded. Please wait ${retryAfterSec} seconds before trying again.`,
        retryAfter: retryAfterSec,
        code: 'RATE_LIMIT_EXCEEDED',
      });
      return;
    }

    // Increment count and proceed
    entry.count++;
    rateLimitStore.set(key, entry);
    next();
  };
}

/**
 * Rate limiter for test run endpoint
 * Allows 2 requests per 10 seconds per user
 */
export const testRunRateLimiter = createRateLimiter({
  windowMs: 10000, // 10 seconds
  maxRequests: 2, // Max 2 test starts per 10 seconds
  keyPrefix: 'test-run',
});

/**
 * Rate limiter for test retry endpoint
 * Allows 2 requests per 10 seconds per user
 */
export const testRetryRateLimiter = createRateLimiter({
  windowMs: 10000, // 10 seconds
  maxRequests: 2, // Max 2 retries per 10 seconds
  keyPrefix: 'test-retry',
});

/**
 * Create an IP-based rate limiter for public (unauthenticated) endpoints.
 * Uses the same in-memory sliding window store.
 */
export function createIpRateLimiter(options: {
  windowMs?: number;
  maxRequests?: number;
  keyPrefix?: string;
}) {
  const windowMs = options.windowMs || 60000;
  const maxRequests = options.maxRequests || 30;
  const keyPrefix = options.keyPrefix || 'ip';

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      rateLimitStore.set(key, { count: 1, windowStart: now });
      next();
      return;
    }

    if (entry.count >= maxRequests) {
      const retryAfterMs = windowMs - (now - entry.windowStart);
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      logger.warn('[RATE_LIMITER] IP rate limit exceeded', {
        ip,
        endpoint: keyPrefix,
        count: entry.count,
        maxRequests,
      });

      res.status(429).json({
        success: false,
        error: 'Too many requests',
        message: `Rate limit exceeded. Please wait ${retryAfterSec} seconds.`,
        retryAfter: retryAfterSec,
        code: 'RATE_LIMIT_EXCEEDED',
      });
      return;
    }

    entry.count++;
    rateLimitStore.set(key, entry);
    next();
  };
}

/**
 * Rate limiter for public shared report endpoint
 * 30 requests per 60 seconds per IP
 */
export const sharedReportRateLimiter = createIpRateLimiter({
  windowMs: 60000,
  maxRequests: 30,
  keyPrefix: 'shared-report',
});
