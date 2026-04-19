import { recordVisit, updateVisitEngagement, getVisits, deleteVisit, deleteVisitsByVisitor } from './investor.controller';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router, json, text, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const router = Router();

// Rate limiters — public endpoints, prevent abuse.
// `validate.trustProxy: false` silences the express-rate-limit v7 warning
// about the global `app.set('trust proxy', true)` config — we know that
// header-spoofable IPs can bypass these limits, which is acceptable for
// a low-traffic investor-report tracker.
const visitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many requests' },
  validate: { trustProxy: false },
});

const engagementLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, error: 'Too many requests' },
  validate: { trustProxy: false },
});

// Middleware to handle beacon requests that may arrive as text/plain
// navigator.sendBeacon() with Blob('application/json') usually works,
// but some browsers send text/plain instead — we need to parse both.
const beaconBodyParser = [
  json({ type: ['application/json', 'text/plain'] }),
  // Fallback: if body is a raw string (text parser), try to JSON.parse it
  (req: Request, _res: Response, next: NextFunction) => {
    if (typeof req.body === 'string') {
      try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
    }
    next();
  },
];

/**
 * POST /api/v1/investor/visit
 * Record a new investor visit (public, rate-limited)
 */
router.post('/visit', visitLimiter, asyncHandler(recordVisit));

/**
 * PATCH /api/v1/investor/visit/:sessionId
 * Update engagement metrics for a visit (public, rate-limited).
 * Uses custom body parser to handle beacon text/plain Content-Type.
 *
 * POST alias exists because `navigator.sendBeacon()` is hard-coded to POST —
 * the browser cannot send PATCH via beacon, so the same handler is registered
 * under both verbs for the same path.
 */
router.patch('/visit/:sessionId', engagementLimiter, ...beaconBodyParser, asyncHandler(updateVisitEngagement));
router.post('/visit/:sessionId', engagementLimiter, ...beaconBodyParser, asyncHandler(updateVisitEngagement));

/**
 * GET /api/v1/investor/visits?key=<password>&month=<optional>
 * List investor visits — admin access via password in query param
 * Same password as report login (hashed and compared server-side)
 */
const adminVisitsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many requests' },
  validate: { trustProxy: false },
});

// Admin auth: accepts password via ?key= (GET) or X-Admin-Key header (DELETE).
// Hashes it server-side and compares with ADMIN_HASH (preferred, separate
// admin password). Falls back to INVESTOR_HASH if ADMIN_HASH is not set —
// that way single-password setups still work.
function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const key = (typeof req.query.key === 'string' && req.query.key) ||
              (typeof req.headers['x-admin-key'] === 'string' && req.headers['x-admin-key'] as string) ||
              '';
  if (!key) {
    res.status(401).json({ success: false, error: 'Access key required' });
    return;
  }
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const adminHash = process.env.ADMIN_HASH || '';
  const investorHash = process.env.INVESTOR_HASH || '';
  // Prefer ADMIN_HASH; fall back to INVESTOR_HASH only if ADMIN_HASH unset
  const matches = adminHash
    ? hash === adminHash
    : (investorHash && hash === investorHash);
  if (!matches) {
    res.status(403).json({ success: false, error: 'Invalid access key' });
    return;
  }
  next();
}

router.get('/visits', adminVisitsLimiter, requireAdminKey, asyncHandler(getVisits));

/**
 * DELETE /api/v1/investor/visits/by-visitor
 * Bulk-delete all visits by (name [+ optional ip/month]). Admin-only.
 * Body: { name: string, ip?: string, month?: string }
 * NOTE: must be registered BEFORE DELETE /:id so Express doesn't capture
 * "by-visitor" as an :id param.
 */
const adminDeleteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many requests' },
  validate: { trustProxy: false },
});

router.delete(
  '/visits/by-visitor',
  adminDeleteLimiter,
  requireAdminKey,
  json(),
  asyncHandler(deleteVisitsByVisitor)
);

/**
 * DELETE /api/v1/investor/visits/:id
 * Delete a single visit by UUID. Admin-only.
 */
router.delete('/visits/:id', adminDeleteLimiter, requireAdminKey, asyncHandler(deleteVisit));

export default router;
