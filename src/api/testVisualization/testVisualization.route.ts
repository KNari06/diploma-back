import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import {
    exportTestGraph,
    getTestVisualization,
    parseTestSteps,
    validateTestSteps,
    getProjectOverall,
} from './testVisualization.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/test-visualization/parse:
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
 * /api/v1/test-visualization/export:
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
 * /api/v1/test-visualization/validate:
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
 * /api/v1/test-visualization/project/{projectId}/overall:
 *   get:
 *     summary: Get project-level overall visualization (planet view)
 *     description: |
 *       Returns comprehensive project visualization with all test entities,
 *       their relationships, and clusters for the frontend "planet" view.
 *
 *       **Includes:**
 *       - All tests in project with status flags (success/failed/danger/cancelled)
 *       - Relationship edges between related tests
 *       - Clusters of related test flows (spheres)
 *     tags: [Test Visualization]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project ID (UUID)
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Project overall visualization successfully retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     nodes:
 *                       type: array
 *                       description: Test entities as nodes
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             format: uuid
 *                           entityType:
 *                             type: string
 *                             enum: [test_run, saved_case, module]
 *                           label:
 *                             type: string
 *                           statusFlag:
 *                             type: string
 *                             enum: [success, failed, danger, cancelled]
 *                           source:
 *                             type: string
 *                             enum: [manual, intelligent, api, regression]
 *                           lastRunAt:
 *                             type: string
 *                             format: date-time
 *                             nullable: true
 *                           meta:
 *                             type: object
 *                     edges:
 *                       type: array
 *                       description: Relationships between nodes
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           source:
 *                             type: string
 *                           target:
 *                             type: string
 *                           relationshipType:
 *                             type: string
 *                             enum: [url, page_flow, semantic, temporal]
 *                           confidence:
 *                             type: number
 *                             minimum: 0
 *                             maximum: 1
 *                           reasons:
 *                             type: array
 *                             items:
 *                               type: string
 *                     clusters:
 *                       type: array
 *                       description: Related test clusters (spheres)
 *                       items:
 *                         type: object
 *                         properties:
 *                           clusterId:
 *                             type: string
 *                           label:
 *                             type: string
 *                           memberNodeIds:
 *                             type: array
 *                             items:
 *                               type: string
 *                           confidence:
 *                             type: number
 *                           reasons:
 *                             type: array
 *                             items:
 *                               type: string
 *                     metadata:
 *                       type: object
 *                       properties:
 *                         projectId:
 *                           type: string
 *                         totalTests:
 *                           type: number
 *                         totalSavedCases:
 *                           type: number
 *                         totalSuites:
 *                           type: number
 *                         generatedAt:
 *                           type: string
 *                           format: date-time
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Bad request - invalid project ID format
 *       401:
 *         description: Unauthorized - authentication required
 *       403:
 *         description: Forbidden - access denied to this project
 *       404:
 *         description: Project not found
 *       500:
 *         description: Internal server error
 */
router.get('/project/:projectId/overall', requireAuth, getProjectOverall);

/**
 * @swagger
 * /api/v1/test-visualization/{testId}:
 *   get:
 *     summary: Get comprehensive visualization for existing test from database
 *     description: |
 *       Retrieves test visualization by aggregating data from multiple sources:
 *       - Trace files (Playwright traces)
 *       - Test reports
 *       - Intelligent test sessions
 *       - AI summaries
 *       - API configurations
 *
 *       Returns a graph structure (nodes + edges) ready for visualization as neural network.
 *     tags: [Test Visualization]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Test ID (UUID)
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [json, mermaid]
 *           default: json
 *         description: Response format - JSON graph or Mermaid diagram
 *         example: "json"
 *       - in: query
 *         name: options
 *         schema:
 *           type: string
 *         description: JSON string with parser options (includeStartEnd, autoLayout, etc.)
 *         example: '{"includeStartEnd":true,"autoLayout":true}'
 *     responses:
 *       200:
 *         description: Test visualization graph successfully generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     nodes:
 *                       type: array
 *                       description: Graph nodes for visualization
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: "node_1"
 *                           type:
 *                             type: string
 *                             enum: [start, step, conditional, loop, end]
 *                             example: "step"
 *                           stepType:
 *                             type: string
 *                             description: Playwright step type
 *                             example: "goto"
 *                           label:
 *                             type: string
 *                             example: "Navigate to https://example.com"
 *                           selector:
 *                             type: string
 *                             example: "button.login"
 *                           value:
 *                             type: string
 *                             example: "https://example.com"
 *                           group:
 *                             type: string
 *                           meta:
 *                             type: object
 *                             properties:
 *                               color:
 *                                 type: string
 *                                 example: "#2196F3"
 *                               icon:
 *                                 type: string
 *                                 example: "globe"
 *                               source:
 *                                 type: string
 *                                 description: Data source (trace, report, intelligent, ai_summary, api_config, generated)
 *                                 example: "trace"
 *                               traceFile:
 *                                 type: string
 *                                 example: "trace_123.zip"
 *                               browser:
 *                                 type: string
 *                                 example: "chrome"
 *                               success:
 *                                 type: boolean
 *                               durationMs:
 *                                 type: number
 *                     edges:
 *                       type: array
 *                       description: Graph edges (connections between nodes)
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: "edge_1"
 *                           source:
 *                             type: string
 *                             example: "node_1"
 *                           target:
 *                             type: string
 *                             example: "node_2"
 *                           type:
 *                             type: string
 *                             enum: [normal, conditional-true, conditional-false, loop]
 *                             example: "normal"
 *                           label:
 *                             type: string
 *                           animated:
 *                             type: boolean
 *                     metadata:
 *                       type: object
 *                       properties:
 *                         totalSteps:
 *                           type: number
 *                           example: 10
 *                         conditionalBranches:
 *                           type: number
 *                           example: 2
 *                         loops:
 *                           type: number
 *                           example: 1
 *                         assertions:
 *                           type: number
 *                           example: 3
 *                         testId:
 *                           type: string
 *                           format: uuid
 *                         testUrl:
 *                           type: string
 *                           example: "https://example.com"
 *                         testStatus:
 *                           type: string
 *                           enum: [pending, running, completed, failed, cancelled, timeout]
 *                         executedAt:
 *                           type: string
 *                           format: date-time
 *                         dataSources:
 *                           type: object
 *                           properties:
 *                             traceFiles:
 *                               type: number
 *                             testResults:
 *                               type: number
 *                             intelligentSession:
 *                               type: boolean
 *                             report:
 *                               type: boolean
 *                             apiConfigs:
 *                               type: number
 *                         stepsSource:
 *                           type: string
 *                           description: Primary source of steps (trace_files, test_report, intelligent_session, ai_summary, api_configs, generated_basic)
 *                         generatedAt:
 *                           type: string
 *                           format: date-time
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *           text/plain:
 *             schema:
 *               type: string
 *             description: Mermaid diagram (when format=mermaid)
 *             example: |
 *               graph TD
 *                   node_1[Start] --> node_2[Navigate to https://example.com]
 *                   node_2 --> node_3[Click Login Button]
 *       400:
 *         description: Bad request - invalid test ID format or parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Invalid test ID format"
 *       401:
 *         description: Unauthorized - authentication required
 *       404:
 *         description: Test not found or no steps available
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Test not found"
 *                 message:
 *                   type: string
 *                 testData:
 *                   type: object
 *                   description: Available test data info
 *       500:
 *         description: Internal server error
 */
router.get('/:testId', requireAuth, getTestVisualization);

export default router;
