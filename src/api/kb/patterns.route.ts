import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import * as patternsController from './patterns.controller';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * @swagger
 * /api/v1/kb/patterns/overview:
 *   get:
 *     summary: Get patterns overview (test execution stats)
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Patterns overview stats
 */
router.get('/overview', patternsController.getPatternsOverview);

/**
 * @swagger
 * /api/v1/kb/patterns/pages:
 *   get:
 *     summary: Get frequently visited pages
 *     tags: [Knowledge Base]
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
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Page visit patterns
 */
router.get('/pages', patternsController.getPagePatterns);

/**
 * @swagger
 * /api/v1/kb/patterns/errors:
 *   get:
 *     summary: Get recurring error patterns
 *     tags: [Knowledge Base]
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
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Error patterns
 */
router.get('/errors', patternsController.getErrorPatterns);

/**
 * @swagger
 * /api/v1/kb/patterns/elements:
 *   get:
 *     summary: Get most interacted elements
 *     tags: [Knowledge Base]
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
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Element interaction patterns
 */
router.get('/elements', patternsController.getElementPatterns);

export default router;
