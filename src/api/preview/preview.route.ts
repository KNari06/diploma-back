/**
 * Preview Routes
 * API routes for step editor preview and intent test cases
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
  createIntentTestCase,
  deleteIntentTestCase,
  getIntentTestCase,
  listIntentTestCases,
  startPreview,
  stopPreview,
  updateIntentTestCase,
} from './preview.controller';

const router = Router();

// ============================================================================
// PREVIEW SESSION ROUTES
// ============================================================================

/**
 * @swagger
 * /api/v1/preview/start:
 *   post:
 *     summary: Start a preview session
 *     tags: [Preview]
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
 *               - startUrl
 *             properties:
 *               projectId:
 *                 type: string
 *               startUrl:
 *                 type: string
 *     responses:
 *       200:
 *         description: Preview session started
 */
router.post('/start', requireAuth, startPreview);

/**
 * @swagger
 * /api/v1/preview/stop:
 *   post:
 *     summary: Stop a preview session
 *     tags: [Preview]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - previewSessionId
 *             properties:
 *               previewSessionId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Preview session stopped
 */
router.post('/stop', requireAuth, stopPreview);

// ============================================================================
// INTENT TEST CASE ROUTES
// ============================================================================

/**
 * @swagger
 * /api/v1/preview/intent-test-cases:
 *   post:
 *     summary: Create an intent test case
 *     tags: [Intent Test Cases]
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
 *               - startUrl
 *             properties:
 *               projectId:
 *                 type: string
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               startUrl:
 *                 type: string
 *               steps:
 *                 type: array
 *     responses:
 *       201:
 *         description: Test case created
 */
router.post('/intent-test-cases', requireAuth, createIntentTestCase);

/**
 * @swagger
 * /api/v1/preview/intent-test-cases:
 *   get:
 *     summary: List intent test cases for a project
 *     tags: [Intent Test Cases]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of test cases
 */
router.get('/intent-test-cases', requireAuth, listIntentTestCases);

/**
 * @swagger
 * /api/v1/preview/intent-test-cases/{id}:
 *   get:
 *     summary: Get an intent test case by ID
 *     tags: [Intent Test Cases]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Test case details
 */
router.get('/intent-test-cases/:id', requireAuth, getIntentTestCase);

/**
 * @swagger
 * /api/v1/preview/intent-test-cases/{id}:
 *   patch:
 *     summary: Update an intent test case
 *     tags: [Intent Test Cases]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
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
 *               startUrl:
 *                 type: string
 *               steps:
 *                 type: array
 *     responses:
 *       200:
 *         description: Test case updated
 */
router.patch('/intent-test-cases/:id', requireAuth, updateIntentTestCase);

/**
 * @swagger
 * /api/v1/preview/intent-test-cases/{id}:
 *   delete:
 *     summary: Delete an intent test case
 *     tags: [Intent Test Cases]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Test case deleted
 */
router.delete('/intent-test-cases/:id', requireAuth, deleteIntentTestCase);

export default router;
