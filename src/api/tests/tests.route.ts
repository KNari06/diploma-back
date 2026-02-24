/**
 * Tests Routes
 * Unified test listing for the Runs/Debug page
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import { listTests } from './tests.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/tests:
 *   get:
 *     summary: List all UI tests for a project (unified across all sources)
 *     description: |
 *       Single endpoint for the Runs/Debug page. Lists all UI tests from all sources
 *       (regression, chat, manual, intelligent) with source classification, pagination,
 *       and bug detection.
 *     tags: [Tests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [regression, chat, manual, intelligent, all]
 *           default: all
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, running, completed, failed, cancelled, timeout, all]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Paginated list of tests with source classification
 *       400:
 *         description: Missing projectId
 */
router.get('/', requireAuth, listTests);

export default router;
