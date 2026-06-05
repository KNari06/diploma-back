import { Router, Request, Response, NextFunction } from 'express';
import { asyncHandler } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';
import { handlePublicChat } from './public-chat.controller';

const router = Router();

/**
 * IP-based rate limiter for the public (unauthenticated) widget.
 *
 * The shared `createRateLimiter` keys on `req.user.id` and no-ops when there's
 * no authenticated user, so it can't protect a public route. This is a small
 * in-memory IP limiter scoped to this endpoint. Good enough for a marketing
 * widget; swap for a Redis-backed limiter if it ever needs to be cluster-wide.
 */
const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 12; // per IP per window
const ipHits = new Map<string, { count: number; windowStart: number }>();

function ipRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = ipHits.get(ip);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    ipHits.set(ip, { count: 1, windowStart: now });
    next();
    return;
  }

  if (entry.count >= MAX_REQUESTS) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
    logger.warn('[PUBLIC_CHAT] Rate limit exceeded', { ip: ip.substring(0, 12), count: entry.count });
    res.status(429).json({
      success: false,
      error: 'Too many requests',
      retryAfter,
      code: 'RATE_LIMIT_EXCEEDED',
    });
    return;
  }

  entry.count++;
  ipHits.set(ip, entry);
  next();
}

// Periodically evict stale IP entries so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipHits) {
    if (now - entry.windowStart >= WINDOW_MS) ipHits.delete(ip);
  }
}, WINDOW_MS).unref?.();

/**
 * POST /api/v1/chat/public/ask
 * Public, unauthenticated product Q&A for the B2C "Ask Me Anything" widget.
 */
router.post('/ask', ipRateLimiter, asyncHandler(handlePublicChat));

export default router;
