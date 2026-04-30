import { requireAuth, requireApproved } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import { listAILogs } from './ai-logs.controller';
import { ingestRunnerEvent } from './runner-event.controller';
import { listSystemLogs } from './system-logs.controller';

const router = Router();

// Public from the runner's perspective — auth is via X-Runner-Key header.
// Registered BEFORE requireAuth on the user-facing GET so the shared-secret
// path doesn't run user-token middleware.
router.post('/runner-event', asyncHandler(ingestRunnerEvent));

router.get('/', requireAuth, requireApproved, asyncHandler(listAILogs));

// System (Winston) logs — gated by users.show_logs inside the controller.
router.get('/system', requireAuth, requireApproved, asyncHandler(listSystemLogs));

export default router;
