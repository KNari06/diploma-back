/**
 * Modules Routes
 * CRUD routes for test modules
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
    createModule,
    deleteModule,
    getModule,
    listModules,
    reorderModules,
    updateModule,
} from './modules.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/modules:
 *   get:
 *     summary: List modules for a project
 *     description: Returns modules optionally filtered by platform
 *     tags: [Modules]
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
 *         name: platformId
 *         description: Filter by platform UUID
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: platformKey
 *         description: Filter by platform key
 *         schema:
 *           type: string
 *           enum: [web_ui, api]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: List of modules
 *   post:
 *     summary: Create a new module
 *     description: Creates a module under a platform. Requires platformId or platformKey.
 *     tags: [Modules]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - name
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               platformId:
 *                 type: string
 *                 format: uuid
 *                 description: Platform UUID (required if platformKey not provided)
 *               platformKey:
 *                 type: string
 *                 enum: [web_ui, api]
 *                 description: Platform key (required if platformId not provided)
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               priority:
 *                 type: string
 *                 enum: [critical, high, medium, low]
 *     responses:
 *       200:
 *         description: Module created
 */
router.get('/', requireAuth, listModules);
router.post('/', requireAuth, createModule);
// Must be registered before '/:id' so "reorder" isn't captured as an id.
router.post('/reorder', requireAuth, reorderModules);

/**
 * @swagger
 * /api/v1/modules/{id}:
 *   get:
 *     summary: Get module by ID
 *     tags: [Modules]
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
 *         description: Module details
 *   patch:
 *     summary: Update a module
 *     tags: [Modules]
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
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               priority:
 *                 type: string
 *     responses:
 *       200:
 *         description: Module updated
 *   delete:
 *     summary: Delete a module
 *     tags: [Modules]
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
 *         description: Module deleted
 */
router.get('/:id', requireAuth, getModule);
router.patch('/:id', requireAuth, updateModule);
router.delete('/:id', requireAuth, deleteModule);

export default router;
