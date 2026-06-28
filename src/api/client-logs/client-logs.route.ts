import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limiter.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { ingestClientLogs } from './client-logs.controller';

/**
 * Client-side failure ingest. Mounted at `/api/${API_VERSION}/client-logs`.
 *
 * `requireAuth` first so the rate limiter keys on a real userId and the
 * controller can force the server-derived identity. The per-user limit is
 * generous (the browser batches) but bounded, so a misbehaving client cannot
 * flood Loki.
 */
const router = Router();

const clientLogRateLimiter = createRateLimiter({
  windowMs: 10_000,
  maxRequests: 30,
  keyPrefix: 'client-logs',
});

router.post('/', requireAuth, clientLogRateLimiter, asyncHandler(ingestClientLogs));

export default router;
