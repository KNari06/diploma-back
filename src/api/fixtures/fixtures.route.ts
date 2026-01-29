/**
 * Fixtures Routes
 * CRUD routes for test fixtures
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
    createFixture,
    deleteFixture,
    getFixture,
    listFixtures,
    updateFixture,
} from './fixtures.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/fixtures:
 *   get:
 *     summary: List fixtures for a project
 *     tags: [Fixtures]
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
 *         name: scope
 *         schema:
 *           type: string
 *           enum: [global, project, module, suite, flow]
 *     responses:
 *       200:
 *         description: List of fixtures
 *   post:
 *     summary: Create a new fixture
 *     tags: [Fixtures]
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
 *               - data
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               data:
 *                 type: object
 *               scope:
 *                 type: string
 *                 enum: [global, project, module, suite, flow]
 *               moduleId:
 *                 type: string
 *                 format: uuid
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Fixture created
 */
router.get('/', requireAuth, listFixtures);
router.post('/', requireAuth, createFixture);

/**
 * @swagger
 * /api/v1/fixtures/{id}:
 *   get:
 *     summary: Get fixture by ID
 *     tags: [Fixtures]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Fixture details
 *   patch:
 *     summary: Update a fixture
 *     tags: [Fixtures]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Fixture updated
 *   delete:
 *     summary: Delete a fixture
 *     tags: [Fixtures]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Fixture deleted
 */
router.get('/:id', requireAuth, getFixture);
router.patch('/:id', requireAuth, updateFixture);
router.delete('/:id', requireAuth, deleteFixture);

export default router;
