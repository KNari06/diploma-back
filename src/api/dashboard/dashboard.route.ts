/**
 * Dashboard Routes
 * GET /api/v1/dashboard/summary  — aggregated home-page data in one round-trip
 */

import { Router } from 'express';
import { asyncHandler } from '@/utils/core/error-handler';
import { getDashboardSummary, invalidateDashboardCache } from './dashboard.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/dashboard/summary:
 *   get:
 *     summary: Get all home-page dashboard data in a single request
 *     description: |
 *       Aggregates analytics summary, results overview, test nodes, recent regression
 *       runs, and upcoming schedules into a single response. Results are cached in
 *       Redis for 60 seconds per (workspaceId + userId) pair.
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The workspace to load dashboard data for
 *     responses:
 *       200:
 *         description: Dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 cached:
 *                   type: boolean
 *                   description: Whether the response was served from Redis cache
 *                 data:
 *                   type: object
 *                   properties:
 *                     projectId:
 *                       type: string
 *                       nullable: true
 *                     summary:
 *                       type: object
 *                       nullable: true
 *                     resultsOverview:
 *                       type: object
 *                       nullable: true
 *                     testNodes:
 *                       type: array
 *                       items:
 *                         type: object
 *                     recentRuns:
 *                       type: array
 *                       items:
 *                         type: object
 *                     upcomingSchedules:
 *                       type: array
 *                       items:
 *                         type: object
 *       400:
 *         description: Missing workspaceId
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: No workspace access
 *       500:
 *         description: Internal server error
 */
router.get('/summary', asyncHandler(getDashboardSummary));

/**
 * @swagger
 * /api/v1/dashboard/invalidate:
 *   post:
 *     summary: Invalidate dashboard cache for a workspace
 *     description: |
 *       Clears the Redis cache entry for the given workspaceId + current user.
 *       Call this after a regression run completes or test cases change.
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Cache invalidated
 *       400:
 *         description: Missing workspaceId
 */
router.post('/invalidate', asyncHandler(invalidateDashboardCache));

export default router;
