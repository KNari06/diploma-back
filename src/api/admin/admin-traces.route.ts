import { requireAuth, requireAdmin } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import { listAllTraces, getTraceEvents } from './admin-traces.controller';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/traces', asyncHandler(listAllTraces));
router.get('/traces/:id/events', asyncHandler(getTraceEvents));

export default router;
