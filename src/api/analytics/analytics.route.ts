/**
 * Analytics Routes
 * API routes for workspace test analytics
 */

import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import {
  getSummary,
  getResultsOverview,
  getRecentFailures,
  getCriticalChecks,
  getHeatmap,
  getDeployments,
  getTimeSeries,
} from './analytics.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/analytics/summary:
 *   get:
 *     summary: Get analytics summary
 *     description: Returns summary data including top cards, status, and performance metrics
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Optional project filter
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for filtering
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date for filtering
 *     responses:
 *       200:
 *         description: Summary data
 *       400:
 *         description: Missing required parameters
 *       403:
 *         description: Access denied
 */
router.get('/summary', requireAuth, asyncHandler(getSummary));

/**
 * @swagger
 * /api/v1/analytics/results-overview:
 *   get:
 *     summary: Get test results overview
 *     description: Returns donut chart data with passed/failed/skipped/flaky counts
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Results overview
 */
router.get('/results-overview', requireAuth, asyncHandler(getResultsOverview));

/**
 * @swagger
 * /api/v1/analytics/recent-failures:
 *   get:
 *     summary: Get recent test failures
 *     description: Returns list of recent failed tests with severity
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: List of failures
 */
router.get('/recent-failures', requireAuth, asyncHandler(getRecentFailures));

/**
 * @swagger
 * /api/v1/analytics/critical-checks:
 *   get:
 *     summary: Get critical checks status
 *     description: Returns status of all critical priority test cases
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Critical checks status
 */
router.get('/critical-checks', requireAuth, asyncHandler(getCriticalChecks));

/**
 * @swagger
 * /api/v1/analytics/heatmap:
 *   get:
 *     summary: Get activity heatmap data
 *     description: Returns daily activity data for heatmap visualization
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: metric
 *         required: true
 *         schema:
 *           type: string
 *           enum: [runs, failures, flaky]
 *       - in: query
 *         name: range
 *         schema:
 *           type: string
 *           enum: [30d, 90d, 365d]
 *           default: 365d
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Heatmap data
 */
router.get('/heatmap', requireAuth, asyncHandler(getHeatmap));

/**
 * @swagger
 * /api/v1/analytics/deployments:
 *   get:
 *     summary: Get recent deployments
 *     description: Returns recent git webhook deliveries (deployments/releases)
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 5
 *     responses:
 *       200:
 *         description: List of deployments
 */
router.get('/deployments', requireAuth, asyncHandler(getDeployments));

/**
 * @swagger
 * /api/v1/analytics/time-series:
 *   get:
 *     summary: Get time series data
 *     description: Returns time-bucketed run counts for charting
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: interval
 *         required: true
 *         schema:
 *           type: string
 *           enum: [1m, 5m, 15m, 1h, 1d]
 *       - in: query
 *         name: projectId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Time series data points
 */
router.get('/time-series', requireAuth, asyncHandler(getTimeSeries));

export default router;
