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
 * Regression API routes (replay-oriented).
 *
 * Key concepts (to avoid confusion with other "test" routes):
 * - `tests` (execution): results of an actual run (produced by running UI/API tests)
 * - `saved_test_cases` (definition): reusable UI test definitions used for replay/regression runs
 * - `regression_suites` (collection): groups of saved test cases to run together
 *
 * This router mainly does 2 things:
 * 1) Save: convert an already executed test (`tests`) into a reusable saved test case (`saved_test_cases`)
 * 2) Run: execute saved definitions (saved test case / suite / module / flow / plan) and create new executions
 *
 * It does NOT provide "step editor" endpoints to manually author `saved_test_cases.commands`.
 * Manual authoring is handled by the Preview/Intent Test Case endpoints (`/api/v1/preview/...`) in this codebase.
 */

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
// Save FROM execution: takes `sourceTestId` (completed test) -> creates `saved_test_cases` for replay.
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
// List suites (collections of saved test cases) for a project.
router.get('/suites', requireAuth, listSuites);
// Create a suite (collection of saved test cases) for a project.
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
// Run/replay: execute a saved test case OR a suite (creates new execution run records).
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
// List saved test case definitions for a project (replay definitions, not execution history).
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
// List regression run history/metadata for a project.
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
// Run a regression plan (a custom selection of tests).
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
// Run all tests under a module (hierarchy shortcut).
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
// Run all tests under a flow (hierarchy shortcut).
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
// Run tests filtered by tag across a project.
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
// Run tests filtered by priority across a project.
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
// Get aggregated execution stats for a specific runId (progress, pass/fail counts, etc.).
router.get('/runs/:runId/stats', requireAuth, getRunStats);

export default router;
