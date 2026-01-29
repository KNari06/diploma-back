/**
 * Flows Routes
 * CRUD routes for test flows
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
    createFlow,
    deleteFlow,
    getFlow,
    listFlows,
    reorderFlows,
    updateFlow,
} from './flows.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/flows:
 *   get:
 *     summary: List flows for a suite
 *     tags: [Flows]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: suiteId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: List of flows
 *   post:
 *     summary: Create a new flow
 *     tags: [Flows]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - suiteId
 *               - name
 *             properties:
 *               suiteId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               flowType:
 *                 type: string
 *                 enum: [ui, api, mixed]
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               priority:
 *                 type: string
 *                 enum: [critical, high, medium, low]
 *     responses:
 *       200:
 *         description: Flow created
 */
router.get('/', requireAuth, listFlows);
router.post('/', requireAuth, createFlow);

/**
 * @swagger
 * /api/v1/flows/reorder:
 *   post:
 *     summary: Reorder flows within a suite
 *     tags: [Flows]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - suiteId
 *               - flowIds
 *             properties:
 *               suiteId:
 *                 type: string
 *                 format: uuid
 *               flowIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       200:
 *         description: Flows reordered
 */
router.post('/reorder', requireAuth, reorderFlows);

/**
 * @swagger
 * /api/v1/flows/{id}:
 *   get:
 *     summary: Get flow by ID
 *     tags: [Flows]
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
 *         description: Flow details
 *   patch:
 *     summary: Update a flow
 *     tags: [Flows]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Flow updated
 *   delete:
 *     summary: Delete a flow
 *     tags: [Flows]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Flow deleted
 */
router.get('/:id', requireAuth, getFlow);
router.patch('/:id', requireAuth, updateFlow);
router.delete('/:id', requireAuth, deleteFlow);

export default router;
