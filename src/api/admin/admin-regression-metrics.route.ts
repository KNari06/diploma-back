import { requireAuth, requireAdmin } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import { getRegressionMetrics } from './admin-regression-metrics.controller';

/**
 * Admin-only routes for Phase 2 mobile telemetry aggregates.
 *
 * Mounted at `/api/${API_VERSION}/admin` (alongside admin-traces). The
 * `requireAuth` + `requireAdmin` middleware are applied at the router
 * level so every endpoint added here inherits them — there is no
 * accidental public-exposure path.
 */
const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/regression-metrics', asyncHandler(getRegressionMetrics));

export default router;
