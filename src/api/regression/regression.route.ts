import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
    createSuite,
    getRunStats,
    listRuns,
    listSavedTestCases,
    listSuites,
    runByPriority,
    runByTag,
    runFlow,
    runModule,
    runPlan,
    runRegression,
    saveTestCase,
} from './regression.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/regression/save:
 *   post:
 *     summary: Save a test flow as a regression test case
 *     description: |
 *       Saves a completed test flow for replay.
 *       Extracts commands or graph_data and parameterizes sensitive values.
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sourceTestId
 *               - name
 *             properties:
 *               sourceTestId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               kind:
 *                 type: string
 *                 enum: [standalone, regression_member]
 *                 default: standalone
 *     responses:
 *       200:
 *         description: Test case saved successfully
 *       400:
 *         description: Bad request
 *       404:
 *         description: Test not found
 *       422:
 *         description: Test is not replayable
 */
router.post('/save', requireAuth, saveTestCase);

/**
 * @swagger
 * /api/v1/regression/suites:
 *   post:
 *     summary: Create a regression suite
 *     description: Creates a collection of related test cases to run together
 *     tags: [Regression]
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
 *               - testCaseIds
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               testCaseIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       200:
 *         description: Suite created successfully
 *       400:
 *         description: Bad request
 *       403:
 *         description: Access denied
 *   get:
 *     summary: List suites for project
 *     tags: [Regression]
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
 *         description: List of suites
 */
router.get('/suites', requireAuth, listSuites);
router.post('/suites', requireAuth, createSuite);

/**
 * @swagger
 * /api/v1/regression/run:
 *   post:
 *     summary: Run a saved test case or suite
 *     description: |
 *       Executes a saved test case or entire suite.
 *       Applies provided parameters to parameterized values.
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               suiteId:
 *                 type: string
 *                 format: uuid
 *               savedTestCaseId:
 *                 type: string
 *                 format: uuid
 *               trigger:
 *                 type: string
 *                 enum: [manual, chat]
 *                 default: manual
 *               parameters:
 *                 type: object
 *                 description: Parameter values for parameterized tests
 *     responses:
 *       200:
 *         description: Run started successfully
 *       400:
 *         description: Bad request
 *       404:
 *         description: Resource not found
 */
router.post('/run', requireAuth, runRegression);

/**
 * @swagger
 * /api/v1/regression/saved-test-cases:
 *   get:
 *     summary: List saved test cases for project
 *     tags: [Regression]
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
 *         description: List of saved test cases
 */
router.get('/saved-test-cases', requireAuth, listSavedTestCases);

/**
 * @swagger
 * /api/v1/regression/runs:
 *   get:
 *     summary: List regression runs for project
 *     tags: [Regression]
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
 *         description: List of runs
 */
router.get('/runs', requireAuth, listRuns);

/**
 * @swagger
 * /api/v1/regression/run-plan:
 *   post:
 *     summary: Run a regression plan
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - planId
 *             properties:
 *               planId:
 *                 type: string
 *                 format: uuid
 *               parameters:
 *                 type: object
 *     responses:
 *       200:
 *         description: Plan run started
 */
router.post('/run-plan', requireAuth, runPlan);

/**
 * @swagger
 * /api/v1/regression/run-module:
 *   post:
 *     summary: Run all tests in a module
 *     tags: [Regression]
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
 *             properties:
 *               moduleId:
 *                 type: string
 *                 format: uuid
 *               parameters:
 *                 type: object
 *     responses:
 *       200:
 *         description: Module run started
 */
router.post('/run-module', requireAuth, runModule);

/**
 * @swagger
 * /api/v1/regression/run-flow:
 *   post:
 *     summary: Run all tests in a flow
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
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
 *               parameters:
 *                 type: object
 *     responses:
 *       200:
 *         description: Flow run started
 */
router.post('/run-flow', requireAuth, runFlow);

/**
 * @swagger
 * /api/v1/regression/run-by-tag:
 *   post:
 *     summary: Run tests by tag
 *     tags: [Regression]
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
 *               - tag
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               tag:
 *                 type: string
 *     responses:
 *       200:
 *         description: Tag run started
 */
router.post('/run-by-tag', requireAuth, runByTag);

/**
 * @swagger
 * /api/v1/regression/run-by-priority:
 *   post:
 *     summary: Run tests by priority
 *     tags: [Regression]
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
 *               - priority
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               priority:
 *                 type: string
 *                 enum: [critical, high, medium, low]
 *     responses:
 *       200:
 *         description: Priority run started
 */
router.post('/run-by-priority', requireAuth, runByPriority);

/**
 * @swagger
 * /api/v1/regression/runs/{runId}/stats:
 *   get:
 *     summary: Get execution stats for a run
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Run stats
 */
router.get('/runs/:runId/stats', requireAuth, getRunStats);

export default router;
