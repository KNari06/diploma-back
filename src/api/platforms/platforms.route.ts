/**
 * Platforms Routes
 * API routes for test platforms
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
    getPlatform,
    listPlatforms,
    updatePlatform,
} from './platforms.controller';
import { getPlatformTree } from './platforms.tree.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/platforms:
 *   get:
 *     summary: List platforms for a project
 *     description: Returns both web_ui and api platforms. Auto-seeds if missing.
 *     tags: [Platforms]
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
 *         description: List of platforms
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       projectId:
 *                         type: string
 *                         format: uuid
 *                       platformKey:
 *                         type: string
 *                         enum: [web_ui, api]
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 */
router.get('/', requireAuth, listPlatforms);

/**
 * @swagger
 * /api/v1/platforms/tree:
 *   get:
 *     summary: Get nested platform tree with pagination
 *     description: |
 *       Returns nested hierarchy (platforms -> modules -> suites -> flows -> testCases).
 *       Supports pagination at each level via scoped calls.
 *
 *       **Modes** (based on scope params, precedence order):
 *       - `flowId` provided: returns flow + paginated testCases
 *       - `suiteId` provided: returns suite + paginated flows
 *       - `moduleId` provided: returns module + paginated suites
 *       - no scope params: returns platforms + paginated modules (requires projectId)
 *     tags: [Platforms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: projectId
 *         description: Required for base mode (when no scope params)
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: flowId
 *         description: Scope to a specific flow (returns paginated testCases)
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: suiteId
 *         description: Scope to a specific suite (returns paginated flows)
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: moduleId
 *         description: Scope to a specific module (returns paginated suites)
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: limit
 *         description: Pagination limit (default 20)
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: offset
 *         description: Pagination offset (default 0)
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Nested tree data with pagination info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 mode:
 *                   type: string
 *                   enum: [base, module, suite, flow]
 *                 data:
 *                   type: object
 *                   description: Structure varies by mode
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get('/tree', requireAuth, getPlatformTree);

/**
 * @swagger
 * /api/v1/platforms/{id}:
 *   get:
 *     summary: Get platform by ID
 *     tags: [Platforms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Platform details
 *   patch:
 *     summary: Update a platform (name/description)
 *     tags: [Platforms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Platform updated
 */
router.get('/:id', requireAuth, getPlatform);
router.patch('/:id', requireAuth, updatePlatform);

export default router;
