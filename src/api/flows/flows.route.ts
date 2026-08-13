/**
 * Flows Routes
 * CRUD routes for test flows
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
    createFlow,
    deleteFlow,
    duplicateFlow,
    getFlow,
    listFlows,
    reorderFlows,
    searchFlows,
    updateFlow,
} from './flows.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/flows:
 *   get:
 *     summary: List flows for a module
 *     tags: [Flows]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: moduleId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: List of flows
 *   post:
 *     summary: Create a new flow
 *     description: |
 *       Create a new test flow under a module.
 *       Provide `moduleId` to create flow and optionally create 1 initial test case.
 *
 *       When `moduleId` is provided with `baseUrl`, the baseUrl is stored as `startUrl`
 *       and `url` in the auto-created intent test case, enabling the editor to reopen
 *       the test case even when it has no steps yet.
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
 *               - name
 *             properties:
 *               moduleId:
 *                 type: string
 *                 format: uuid
 *                 description: Module ID (required) - will create flow under this module and optionally create initial test case
 *               name:
 *                 type: string
 *                 description: Flow name
 *               flowType:
 *                 type: string
 *                 enum: [ui, api, mixed]
 *                 description: Flow type (defaults to ui)
 *               baseUrl:
 *                 type: string
 *                 format: uri
 *                 description: |
 *                   Optional base URL for the test case (when moduleId is provided for web_ui platform).
 *                   Will be stored as startUrl and url in the auto-created intent test case.
 *                   Example: https://example.com/login
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Flow tags
 *               priority:
 *                 type: string
 *                 enum: [critical, high, medium, low]
 *                 description: Flow priority
 *               preconditions:
 *                 type: array
 *                 description: Precondition steps
 *               expectedResult:
 *                 type: string
 *                 description: Expected result description
 *     responses:
 *       200:
 *         description: Flow created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     flow:
 *                       type: object
 *                       description: Created flow object
 *                     createdTestCaseId:
 *                       type: string
 *                       format: uuid
 *                       nullable: true
 *                       description: ID of initial test case (only when moduleId used, web_ui platform only)
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Bad request (validation error)
 *       404:
 *         description: Module not found
 */
router.get('/', requireAuth, listFlows);
router.post('/', requireAuth, createFlow);

/**
 * @swagger
 * /api/v1/flows/reorder:
 *   post:
 *     summary: Reorder flows within a module
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
 *               - moduleId
 *               - flowIds
 *             properties:
 *               moduleId:
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
 * /api/v1/flows/search:
 *   get:
 *     summary: Search a project's flows by name (owner-scoped)
 *     description: |
 *       Case-insensitive substring match on flow name across every folder in the
 *       project. Backs the Repository page test-case search box.
 *     tags: [Flows]
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
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Search query (matched against flow name)
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 500
 *     responses:
 *       200:
 *         description: Matching flows (may be empty)
 */
// NOTE: must be registered BEFORE `/:id` so "search" is not captured as an id.
router.get('/search', requireAuth, searchFlows);

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

/**
 * @swagger
 * /api/v1/flows/{id}/duplicate:
 *   post:
 *     summary: Duplicate a flow (deep-copy flow + all test cases)
 *     description: |
 *       Creates a new flow in the same module with all test cases copied.
 *       The new flow's name is suffixed with " (Copy)".
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
 *         description: Flow duplicated successfully
 *       404:
 *         description: Source flow not found
 */
router.post('/:id/duplicate', requireAuth, duplicateFlow);

export default router;
