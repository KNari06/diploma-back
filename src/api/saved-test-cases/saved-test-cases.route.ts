/**
 * Saved Test Cases Routes
 * API routes for saved_test_cases CRUD with AI dependency suggestions.
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
    assignToFlow,
    getDependencySuggestions,
    getSavedTestCase,
    listSavedTestCases,
    updateDependencies,
    updateSavedTestCase,
} from './saved-test-cases.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/saved-test-cases:
 *   get:
 *     summary: List saved test cases for a project
 *     description: Returns saved test cases with dependsOn field for building dependency graph.
 *     tags: [Saved Test Cases]
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
 *         name: flowId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Optional filter by flow ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: List of saved test cases
 */
router.get('/', requireAuth, listSavedTestCases);

/**
 * @swagger
 * /api/v1/saved-test-cases/{id}:
 *   get:
 *     summary: Get a saved test case by ID
 *     tags: [Saved Test Cases]
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
 *         description: Saved test case details
 *       404:
 *         description: Not found
 */
router.get('/:id', requireAuth, getSavedTestCase);

/**
 * @swagger
 * /api/v1/saved-test-cases/{id}:
 *   patch:
 *     summary: Update a saved test case
 *     description: |
 *       Updates a saved test case. If the case has a flow_id, returns
 *       `suggestedDependsOn` with AI-powered dependency suggestions (not saved).
 *     tags: [Saved Test Cases]
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
 *               flowId:
 *                 type: string
 *                 format: uuid
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               priority:
 *                 type: string
 *                 enum: [critical, high, medium, low]
 *     responses:
 *       200:
 *         description: Updated saved test case with suggestedDependsOn
 */
router.patch('/:id', requireAuth, updateSavedTestCase);

/**
 * @swagger
 * /api/v1/saved-test-cases/{id}/flow:
 *   put:
 *     summary: Assign saved test case to a flow
 *     description: |
 *       Assigns a saved test case to a flow and returns AI dependency suggestions.
 *     tags: [Saved Test Cases]
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - flowId
 *             properties:
 *               flowId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Case assigned to flow with suggestedDependsOn
 */
router.put('/:id/flow', requireAuth, assignToFlow);

/**
 * @swagger
 * /api/v1/saved-test-cases/{id}/dependencies:
 *   patch:
 *     summary: Confirm and save dependencies
 *     description: |
 *       User confirms AI-suggested or manually selected dependencies.
 *       Validates: existence, ownership, same project/flow, no cycles.
 *     tags: [Saved Test Cases]
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - dependsOn
 *             properties:
 *               dependsOn:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 description: Array of saved_test_cases IDs this case depends on
 *     responses:
 *       200:
 *         description: Dependencies saved successfully
 *       422:
 *         description: Validation error (invalid IDs, different project/flow, cycle detected)
 */
router.patch('/:id/dependencies', requireAuth, updateDependencies);

/**
 * @swagger
 * /api/v1/saved-test-cases/{id}/suggestions:
 *   get:
 *     summary: Get AI dependency suggestions
 *     description: |
 *       Returns AI-powered dependency suggestions based on URL continuity,
 *       keyword heuristics, and semantic similarity.
 *     tags: [Saved Test Cases]
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
 *         description: Array of suggested dependencies
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
 *                       confidence:
 *                         type: number
 *                         minimum: 0
 *                         maximum: 1
 *                       reason:
 *                         type: string
 */
router.get('/:id/suggestions', requireAuth, getDependencySuggestions);

export default router;
