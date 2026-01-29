/**
 * Schedules Routes
 * CRUD routes for test schedules
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
    activateSchedule,
    createSchedule,
    deactivateSchedule,
    deleteSchedule,
    getSchedule,
    listSchedules,
    updateSchedule,
} from './schedules.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/schedules:
 *   get:
 *     summary: List schedules for a project
 *     tags: [Schedules]
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
 *         description: List of schedules
 *   post:
 *     summary: Create a new schedule
 *     tags: [Schedules]
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
 *               - cronExpression
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               cronExpression:
 *                 type: string
 *                 example: "0 0 * * *"
 *               timezone:
 *                 type: string
 *                 default: UTC
 *               moduleId:
 *                 type: string
 *                 format: uuid
 *               suiteId:
 *                 type: string
 *                 format: uuid
 *               planId:
 *                 type: string
 *                 format: uuid
 *               parameters:
 *                 type: object
 *     responses:
 *       200:
 *         description: Schedule created
 */
router.get('/', requireAuth, listSchedules);
router.post('/', requireAuth, createSchedule);

/**
 * @swagger
 * /api/v1/schedules/{id}:
 *   get:
 *     summary: Get schedule by ID
 *     tags: [Schedules]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Schedule details
 *   patch:
 *     summary: Update a schedule
 *     tags: [Schedules]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Schedule updated
 *   delete:
 *     summary: Delete a schedule
 *     tags: [Schedules]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Schedule deleted
 */
router.get('/:id', requireAuth, getSchedule);
router.patch('/:id', requireAuth, updateSchedule);
router.delete('/:id', requireAuth, deleteSchedule);

/**
 * @swagger
 * /api/v1/schedules/{id}/activate:
 *   post:
 *     summary: Activate a schedule
 *     tags: [Schedules]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Schedule activated
 */
router.post('/:id/activate', requireAuth, activateSchedule);

/**
 * @swagger
 * /api/v1/schedules/{id}/deactivate:
 *   post:
 *     summary: Deactivate a schedule
 *     tags: [Schedules]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Schedule deactivated
 */
router.post('/:id/deactivate', requireAuth, deactivateSchedule);

export default router;
