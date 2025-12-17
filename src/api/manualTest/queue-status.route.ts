import { Router } from 'express';
import { getQueueStatus, getJobStatus } from './queue-status.controller';
import { asyncHandler } from '@/utils/error-handler';
import { requireAdmin, requireAuth } from '@/middleware/auth.middleware';

const router = Router();

// ✅ FIX #25: Queue debug endpoints must not be public (job metadata leak)
router.use(requireAuth, requireAdmin);

/**
 * @swagger
 * /api/v1/queue/status:
 *   get:
 *     summary: Get queue status (for debugging)
 *     tags: [Queue]
 *     responses:
 *       200:
 *         description: Queue status retrieved successfully
 */
router.get('/status', asyncHandler(getQueueStatus));

/**
 * @swagger
 * /api/v1/queue/job/{jobId}:
 *   get:
 *     summary: Get job status by ID
 *     tags: [Queue]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job status retrieved successfully
 *       404:
 *         description: Job not found
 */
router.get('/job/:jobId', asyncHandler(getJobStatus));

export default router;
