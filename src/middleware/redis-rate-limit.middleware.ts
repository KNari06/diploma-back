/**
 * Redis-backed fixed-window rate limiter.
 *
 * WHY NOT `rate-limiter.middleware.ts`. That one is an in-process `Map`, and
 * the API autoscales to multiple replicas on Azure Container Apps — a
 * per-process counter caps nothing in aggregate. It keys on `req.user?.id` and calls
 * `next()` when unauthenticated, so a CI-key request (no `req.user`) would
 * sail past it. Both make it unusable for a per-project CI quota.
 *
 * WHY ONE LUA CALL. `INCR` then `EXPIRE` is two round trips: a crash or a
 * rejected second command between them leaves a key with NO TTL, which then
 * 429s that project forever — a bricked pipeline that no error handler catches,
 * because Redis never errored. The script below makes increment, expiry and
 * TTL-read a single atomic step.
 *
 * FIXED window, not sliding: the window is anchored on the first request in it,
 * so burst capacity across a boundary is up to 2x `max`. Say "per hour", never
 * "rolling", in messages and docs.
 */

import { QueueManager, redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';
import { NextFunction, Request, Response } from 'express';

/**
 * Increment the window counter, set the expiry only when the key is new, and
 * return both the count and the remaining TTL — atomically.
 */
const INCR_WITH_WINDOW = `
  local count = redis.call('incr', KEYS[1])
  if count == 1 then
    redis.call('expire', KEYS[1], ARGV[1])
  end
  return { count, redis.call('ttl', KEYS[1]) }`;

export interface RedisRateLimitConfig {
  /** Key namespace, e.g. `ci_publish_rate:`. */
  prefix: string;
  windowSec: number;
  max: number;
  /**
   * What to do when Redis cannot answer. `allow` for endpoints where losing
   * the limiter beats losing the endpoint; `deny` where the limiter is the
   * only thing bounding a costly side effect.
   */
  onUnavailable: 'allow' | 'deny';
  /** Log prefix, e.g. `CI_APP`. */
  logTag: string;
}

export type RateLimitVerdict =
  | { outcome: 'allowed' }
  | { outcome: 'limited'; retryAfterSec: number }
  /** Redis is down or errored — the caller applies `onUnavailable`. */
  | { outcome: 'unavailable' };

/**
 * Consume one slot for `identity`. Exported separately from the middleware
 * because `/ci/run` limits CONDITIONALLY (only when `appUrl` is present), and
 * a route-level middleware cannot see that.
 */
export async function consumeRateLimit(
  config: RedisRateLimitConfig,
  identity: string,
): Promise<RateLimitVerdict> {
  // Check availability BEFORE issuing a command. ioredis buffers commands in
  // its offline queue while disconnected, so a bare try/catch would stall the
  // request for seconds before "failing fast".
  if (!QueueManager.isRedisAvailable()) {
    logger.warn(`[${config.logTag}] Rate limiter unavailable — Redis not connected`, {
      onUnavailable: config.onUnavailable,
    });
    return { outcome: 'unavailable' };
  }

  try {
    const raw = (await redisConnection.eval(
      INCR_WITH_WINDOW,
      1,
      `${config.prefix}${identity}`,
      String(config.windowSec),
    )) as [number, number];

    const count = Number(raw?.[0] ?? 0);
    const ttl = Number(raw?.[1] ?? -1);
    if (count <= config.max) return { outcome: 'allowed' };

    // TTL is -1 (no expiry) or -2 (key gone) only if something outside this
    // script touched the key; fall back to a full window rather than emit a
    // negative Retry-After.
    return { outcome: 'limited', retryAfterSec: ttl > 0 ? ttl : config.windowSec };
  } catch (err) {
    logger.warn(`[${config.logTag}] Rate limiter errored`, {
      error: err instanceof Error ? err.message : String(err),
      onUnavailable: config.onUnavailable,
    });
    return { outcome: 'unavailable' };
  }
}

/**
 * Write the 429. `Retry-After` is the HTTP-standard signal; `retryAfterSeconds`
 * repeats it in the BODY because `qait-publish.sh` parses JSON with `jq` and
 * never captures response headers — a header-only hint is invisible to every
 * copy of the script customers have already vendored into their own repos.
 */
export function sendRateLimited(
  res: Response,
  retryAfterSec: number,
  message: string,
): void {
  res.set('Retry-After', String(retryAfterSec));
  res.status(429).json({
    success: false,
    error: 'Too many requests',
    code: 'RATE_LIMITED',
    message,
    retryAfterSeconds: retryAfterSec,
  });
}

/** Write the 503 used when a `deny`-policy limiter cannot reach Redis. */
export function sendRateLimiterUnavailable(res: Response, message: string): void {
  res.status(503).json({
    success: false,
    error: 'Service temporarily unavailable',
    code: 'RATE_LIMITER_UNAVAILABLE',
    message,
  });
}

export interface RedisRateLimiterMiddlewareConfig extends RedisRateLimitConfig {
  /** Derives the per-caller identity (project id, IP, …) from the request. */
  keyOf: (req: Request) => string;
  /** 429 body message. */
  limitMessage: string;
  /** 503 body message, when `onUnavailable: 'deny'`. */
  unavailableMessage?: string;
}

/** Express middleware form, for routes whose limit is unconditional. */
export function createRedisRateLimiter(config: RedisRateLimiterMiddlewareConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const verdict = await consumeRateLimit(config, config.keyOf(req));

    if (verdict.outcome === 'limited') {
      sendRateLimited(res, verdict.retryAfterSec, config.limitMessage);
      return;
    }
    if (verdict.outcome === 'unavailable' && config.onUnavailable === 'deny') {
      sendRateLimiterUnavailable(
        res,
        config.unavailableMessage ?? 'Try again shortly.',
      );
      return;
    }
    next();
  };
}
