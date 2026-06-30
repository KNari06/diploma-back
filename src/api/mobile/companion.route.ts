import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth, requireApproved } from '@/middleware/auth.middleware';
import { createIpRateLimiter, createRateLimiter } from '@/middleware/rate-limiter.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { CompanionFeature } from '@/config/features/companion';
import {
  generatePairingCode,
  getCompanionStatus,
  pairDevice,
  refreshToken,
  revokeDevice,
} from './companion.controller';

const router = Router();

// Gate every companion endpoint behind the feature flag.
// COMPANION_ENABLED=false keeps all four routes unreachable even though
// the router is mounted unconditionally in index.ts.
router.use((_req: Request, res: Response, next: NextFunction): void => {
  if (!CompanionFeature.isEnabled()) {
    res.status(503).json({ error: 'Companion feature is not enabled' });
    return;
  }
  next();
});

// Rate limiter for unauthenticated pairing endpoints.
// These accept public traffic so they need IP-based throttling.
const companionPairRateLimiter = createIpRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  keyPrefix: 'companion-pair',
});

// Per-user limiter for pair-code minting. requireAuth alone left this unbounded:
// a logged-in user could spam codes (each is a Redis write + a single-use slot).
// Generous cap — pairing a device is a once-in-a-while action, far under this.
const companionPairCodeRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  keyPrefix: 'companion-pair-code',
});

// ── Authenticated (user's QAIT session) ──────────────────────────────────────

// POST /api/v1/companion/pair-code
// Generates a short-lived pairing code the user pastes into the companion CLI.
router.post('/pair-code', requireAuth, requireApproved, companionPairCodeRateLimiter, asyncHandler(generatePairingCode));

// GET /api/v1/companion/status
// Reports whether the user's companion is connected + its last device snapshot,
// so the web device picker can show physical devices before any session exists.
router.get('/status', requireAuth, requireApproved, asyncHandler(getCompanionStatus));

// DELETE /api/v1/companion/devices/:id
// Revokes a companion device so its refresh token stops working.
router.delete('/devices/:id', requireAuth, requireApproved, asyncHandler(revokeDevice));

// ── Unauthenticated (companion CLI only) ─────────────────────────────────────

// POST /api/v1/companion/pair
// Exchanges a pairing code for a refresh + access token. No QAIT session needed.
router.post('/pair', companionPairRateLimiter, asyncHandler(pairDevice));

// POST /api/v1/companion/token/refresh
// Exchanges a valid refresh token for a new access token.
router.post('/token/refresh', companionPairRateLimiter, asyncHandler(refreshToken));

export default router;
