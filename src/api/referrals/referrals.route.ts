import { Router } from 'express';
import { requireAuth, requireAdmin } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import {
  attributeMe,
  createPartner,
  getMyReferrals,
  getMyStats,
  listPartners,
  updatePartner,
} from './referrals.controller';

const router = Router();

// Partner-scoped — the authenticated partner's OWN data only (partner id is
// derived from the token in the service, never from the request → no IDOR).
router.get('/me/stats', requireAuth, asyncHandler(getMyStats));
router.get('/me/referrals', requireAuth, asyncHandler(getMyReferrals));

// Attribution — OAuth-safe path + general fallback. Any authenticated user may
// attribute THEMSELVES (userId from the token); first-touch set-once is DB-enforced.
router.post('/attribute', requireAuth, asyncHandler(attributeMe));

// Staff / admin — manage partners and view all stats.
router.get('/admin/partners', requireAuth, requireAdmin, asyncHandler(listPartners));
router.post('/admin/partners', requireAuth, requireAdmin, asyncHandler(createPartner));
router.patch('/admin/partners/:id', requireAuth, requireAdmin, asyncHandler(updatePartner));

export default router;
