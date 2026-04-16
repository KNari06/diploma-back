import { recordVisit, updateVisitEngagement, getVisits } from './investor.controller';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router, json, text, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const router = Router();

// Rate limiters — public endpoints, prevent abuse
const visitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many requests' },
});

const engagementLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, error: 'Too many requests' },
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
 * Update engagement metrics for a visit (public, rate-limited)
 * Uses custom body parser to handle beacon text/plain Content-Type
 */
router.patch('/visit/:sessionId', engagementLimiter, ...beaconBodyParser, asyncHandler(updateVisitEngagement));

/**
 * GET /api/v1/investor/visits?key=<password>&month=<optional>
 * List investor visits — admin access via password in query param
 * Same password as report login (hashed and compared server-side)
 */
const adminVisitsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many requests' },
});

router.get('/visits', adminVisitsLimiter, (req: Request, res: Response, next: NextFunction) => {
  const key = req.query.key;
  if (!key || typeof key !== 'string') {
    res.status(401).json({ success: false, error: 'Access key required' });
    return;
  }
  // Hash the provided key and compare with the investor hash from env
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const expected = process.env.INVESTOR_HASH || '';
  if (!expected || hash !== expected) {
    res.status(403).json({ success: false, error: 'Invalid access key' });
    return;
  }
  next();
}, asyncHandler(getVisits));

export default router;
