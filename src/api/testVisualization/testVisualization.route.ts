import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import {
    exportTestGraph,
    getTestVisualization,
    parseTestSteps,
    validateTestSteps,
} from './testVisualization.controller';

const router = Router();

/**
 * @swagger
 * /api/test-visualization/parse:
 *   post:
 *     summary: Parse test steps into graph visualization
 *     tags: [Test Visualization]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - steps
 *             properties:
 *               steps:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     type:
 *                       type: string
 *                     label:
 *                       type: string
 *                     selector:
 *                       type: string
 *                     value:
 *                       type: string
 *                     children:
 *                       type: array
 *                     else:
 *                       type: array
 *               options:
 *                 type: object
 *                 properties:
 *                   includeStartEnd:
 *                     type: boolean
 *                   autoLayout:
 *                     type: boolean
 *                   groupNesting:
 *                     type: boolean
 *                   addButtons:
 *                     type: boolean
 *     responses:
 *       200:
 *         description: Successfully parsed test steps
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 */
router.post('/parse', requireAuth, parseTestSteps);

/**
 * @swagger
 * /api/test-visualization/export:
 *   post:
 *     summary: Export graph in different formats (JSON, Mermaid)
 *     tags: [Test Visualization]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - steps
 *             properties:
 *               steps:
 *                 type: array
 *               format:
 *                 type: string
 *                 enum: [json, mermaid]
 *                 default: json
 *               options:
 *                 type: object
 *     responses:
 *       200:
 *         description: Successfully exported graph
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 */
router.post('/export', requireAuth, exportTestGraph);

/**
 * @swagger
 * /api/test-visualization/validate:
 *   post:
 *     summary: Validate test steps structure
 *     tags: [Test Visualization]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - steps
 *             properties:
 *               steps:
 *                 type: array
 *     responses:
 *       200:
 *         description: Validation result
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 */
router.post('/validate', requireAuth, validateTestSteps);

/**
 * @swagger
 * /api/test-visualization/{testId}:
 *   get:
 *     summary: Get visualization for existing test
 *     tags: [Test Visualization]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [json, mermaid]
 *           default: json
 *     responses:
 *       200:
 *         description: Test visualization
 *       404:
 *         description: Test not found
 *       401:
 *         description: Unauthorized
 *       501:
 *         description: Not implemented yet
 */
router.get('/:testId', requireAuth, getTestVisualization);

export default router;
