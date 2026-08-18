import { requireAuth, requireCredits } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
  applyDoctorFindingHandler,
  bulkDeleteNegatives,
  bulkSetNegativesEnabled,
  cancelRun,
  createShareLink,
  deleteNegative,
  dismissDoctorFinding,
  generateNegatives,
  getDoctorFindingSnapshots,
  getExecutionDetail,
  getNegatives,
  getNegativesEstimate,
  getNegativesStatus,
  getPlanHealth,
  regenerateNegatives,
  setNegativeEnabled,
  analyzeRunFailures,
  getRunDoctorFindings,
  getRunExecutions,
  getRunReport,
  getRunStats,
  getTestCaseCommands,
  listRuns,
  listSavedTestCases,
  revertDoctorFindingHandler,
  runByPriority,
  runByTag,
  runFlow,
  runModule,
  runPlan,
  runRegression,
  saveTestCase,
  toggleNegativeTesting,
} from './regression.controller';

const router = Router();

/**
 * Regression API routes (replay-oriented).
 *
 * Key concepts (to avoid confusion with other "test" routes):
 * - `tests` (execution): results of an actual run (produced by running UI/API tests)
 * - `intent_test_cases` (definition): unified UI test definitions used for authoring and replay/regression
 *
 * This router mainly does 2 things:
 * 1) Save: convert an already executed test (`tests`) into a reusable test case (`intent_test_cases` with status=published)
 * 2) Run: execute saved definitions (test case / module / flow / plan) and create new executions
 *
 * It does NOT provide "step editor" endpoints to manually author `intent_test_cases.commands`.
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
// Save a test case. Two modes:
//   A. Replay mode: pass `sourceTestId` (a completed `tests` row) — backend
//      extracts commands/graph_ref and writes an intent_test_case with
//      replay_strategy='commands' | 'graph_extract'.
//   B. Recording mode: pass `projectId` + `platform` + `steps` (IntentStep[]) —
//      backend writes the row directly with replay_strategy='mobile_steps'
//      (for mobile_*) or 'steps_editor' (for web). No `tests` row required.
//      Used for mobile recordings and step-editor authored cases.
router.post('/save', requireAuth, saveTestCase);

/**
 * @swagger
 * /api/v1/regression/run:
 *   post:
 *     summary: Run a saved test case
 *     description: |
 *       Executes a saved test case.
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
 *             required:
 *               - savedTestCaseId
 *             properties:
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
// Run/replay: execute a saved test case (creates new execution run records).
router.post('/run', requireAuth, requireCredits(1), runRegression);

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
router.post('/run-plan', requireAuth, requireCredits(1), runPlan);

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
router.post('/run-module', requireAuth, requireCredits(1), runModule);

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
router.post('/run-flow', requireAuth, requireCredits(1), runFlow);

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
router.post('/run-by-tag', requireAuth, requireCredits(1), runByTag);

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
router.post('/run-by-priority', requireAuth, requireCredits(1), runByPriority);

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

/**
 * @swagger
 * /api/v1/regression/test-cases/{id}/commands:
 *   get:
 *     summary: Get test case commands for shared steps picker
 *     description: Returns commands, parameters schema, and name for a test case (used by frontend shared steps picker)
 *     tags: [Regression]
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
 *         description: Test case commands retrieved successfully
 *       403:
 *         description: Access denied
 *       404:
 *         description: Test case not found
 */
// Get test case commands (for shared steps picker in frontend).
router.get('/test-cases/:id/commands', requireAuth, getTestCaseCommands);

/**
 * @swagger
 * /api/v1/regression/runs/{runId}/report:
 *   get:
 *     summary: Get full run report
 *     description: Returns aggregated report with executions, bugs, artifacts, recommendations
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full run report
 *       404:
 *         description: Run not found
 */
router.get('/runs/:runId/report', requireAuth, getRunReport);

/**
 * @swagger
 * /api/v1/regression/runs/{runId}/executions:
 *   get:
 *     summary: Get executions for a run with testId mapping
 *     description: Returns individual test executions with status and testId for WebSocket subscription
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
 *         description: List of executions
 *       404:
 *         description: Run not found
 */
router.get('/runs/:runId/executions', requireAuth, getRunExecutions);

/**
 * @swagger
 * /api/v1/regression/runs/{runId}/cancel:
 *   post:
 *     summary: Cancel a running regression run
 *     description: Cancels all running/pending tests in the run and marks the run as cancelled
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
 *         description: Run cancelled
 *       404:
 *         description: Run not found
 *       422:
 *         description: Run is not in a cancellable state
 */
router.post('/runs/:runId/cancel', requireAuth, cancelRun);

/**
 * @swagger
 * /api/v1/regression/plans/{planId}/health:
 *   get:
 *     summary: Get plan health report
 *     description: Returns current health, run history trend, and flaky tests
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: planId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: historyLimit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 50
 *     responses:
 *       200:
 *         description: Plan health report
 *       404:
 *         description: Plan not found
 */
router.get('/plans/:planId/health', requireAuth, getPlanHealth);

/**
 * @swagger
 * /api/v1/regression/runs/{runId}/executions/{executionId}/detail:
 *   get:
 *     summary: Get full test detail for a regression execution
 *     description: Returns execution metadata plus full test data (screenshots, video, logs, errors, AI analysis) without needing to know the testId
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
 *       - in: path
 *         name: executionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Execution detail with full test data
 *       404:
 *         description: Run or execution not found
 */
router.get('/runs/:runId/executions/:executionId/detail', requireAuth, getExecutionDetail);

/**
 * @swagger
 * /api/v1/regression/runs/{runId}/share:
 *   post:
 *     summary: Generate a public share link for a run
 *     description: Creates (or reuses) a share token so the run report can be viewed without authentication
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
 *         description: Share link created
 *       404:
 *         description: Run not found
 */
router.post('/runs/:runId/share', requireAuth, createShareLink);

// NOTE: GET /shared/:shareToken is intentionally NOT defined here. This router
// is mounted with `requireAuth, requireApproved`, so any /shared route here
// would be auth-gated. The public shared-report endpoint lives in src/index.ts,
// registered BEFORE this mount. Do not re-add a /shared route in this router.

// ============================================================================
// REGRESSION DOCTOR (Phase-1 — drift aggregation findings)
// ============================================================================

/**
 * @swagger
 * /api/v1/regression/runs/{runId}/doctor:
 *   get:
 *     summary: List Regression Doctor findings for a run
 *     description: |
 *       Returns drift patterns detected by the Regression Doctor after the
 *       run completed. Each finding represents one product change that
 *       affected multiple tests. Findings include a diagnosis, confidence
 *       score, optional proposed patch, and the list of affected test
 *       case ids.
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
 *         description: List of findings (may be empty)
 *       404:
 *         description: Run not found
 *       403:
 *         description: Forbidden
 */
router.get('/runs/:runId/doctor', requireAuth, getRunDoctorFindings);

/**
 * @swagger
 * /api/v1/regression/runs/{runId}/doctor/analyze:
 *   post:
 *     tags: [Regression]
 *     summary: Start the Regression Doctor for a run
 *     description: |
 *       Queues the analysis that proposes a fix for the first failing step of
 *       each failed test. **Manual on purpose** — it costs one vision call per
 *       failed test, so it never runs automatically when a regression finishes.
 *
 *       Safe to call again: steps that already have a finding are skipped, and
 *       a job still in flight returns `alreadyRunning` instead of duplicating.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       202:
 *         description: Analysis queued (or already in flight)
 *       403:
 *         description: Run belongs to another user
 *       404:
 *         description: Run not found
 */
router.post('/runs/:runId/doctor/analyze', requireAuth, analyzeRunFailures);

/**
 * @swagger
 * /api/v1/regression/doctor/findings/{findingId}/dismiss:
 *   post:
 *     summary: Dismiss a Regression Doctor finding
 *     description: |
 *       Marks the finding as dismissed. The user acknowledged the drift
 *       but does not want the patch applied automatically.
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: findingId
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
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: Dismissed
 *       404:
 *         description: Finding not found
 *       403:
 *         description: Forbidden
 *       409:
 *         description: Finding not in 'open' state
 */
router.post('/doctor/findings/:findingId/dismiss', requireAuth, dismissDoctorFinding);

/**
 * @swagger
 * /api/v1/regression/doctor/findings/{findingId}/apply:
 *   post:
 *     summary: Apply a Regression Doctor finding's proposed patch
 *     description: |
 *       Applies the finding's `proposed_patch` to every affected test case
 *       (or a caller-supplied subset). Each test case is processed with
 *       optimistic concurrency — if the user edited the test between the
 *       finding being created and Apply being clicked, that specific test
 *       is skipped with `concurrent_edit` and the rest proceed.
 *
 *       Per-test outcomes are returned so the UI can render a mixed
 *       summary. The finding flips to `applied` iff at least one test
 *       case was patched. A pre-apply snapshot is written to
 *       `regression_doctor_apply_snapshots` for each successful patch.
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: findingId
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
 *               testCaseIds:
 *                 type: array
 *                 description: Optional subset of affected test case ids.
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       200:
 *         description: Apply result with per-test outcomes.
 *       400:
 *         description: Invalid payload.
 *       403:
 *         description: Finding not owned by user.
 *       404:
 *         description: Finding not found.
 *       409:
 *         description: Finding not in an applicable state (already applied / dismissed / no patch / no affected tests).
 */
router.post('/doctor/findings/:findingId/apply', requireAuth, applyDoctorFindingHandler);

/**
 * @swagger
 * /api/v1/regression/doctor/findings/{findingId}/snapshots:
 *   get:
 *     summary: List pre-apply snapshots for a Doctor finding
 *     description: |
 *       Returns the list of snapshots captured when Bulk Apply ran on
 *       this finding. Each row includes the exact `steps_before` /
 *       `steps_after` JSON so the frontend can render a step-level
 *       diff without a second round-trip. Also hydrates test case names.
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: findingId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Snapshots (may be empty for findings never applied).
 *       403:
 *         description: Finding not owned by user.
 *       404:
 *         description: Finding not found.
 */
router.get(
  '/doctor/findings/:findingId/snapshots',
  requireAuth,
  getDoctorFindingSnapshots,
);

/**
 * @swagger
 * /api/v1/regression/doctor/findings/{findingId}/revert:
 *   post:
 *     summary: Revert an applied Regression Doctor finding
 *     description: |
 *       Restores the pre-apply `steps_json` on each patched test case
 *       using the snapshots written by the original Bulk Apply. Tests
 *       that the user edited manually after Apply are skipped with
 *       `modified_after_apply` — we never overwrite manual work. Per-test
 *       outcomes are returned for UI summary.
 *
 *       Full revert (every snapshot reverted) flips the finding back to
 *       `open`; partial revert leaves it in `applied` state.
 *     tags: [Regression]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: findingId
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
 *               snapshotIds:
 *                 type: array
 *                 description: Optional subset of snapshot ids to revert.
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       200:
 *         description: Revert result with per-snapshot outcomes.
 *       400:
 *         description: Invalid payload.
 *       403:
 *         description: Finding not owned by user.
 *       404:
 *         description: Finding not found.
 *       409:
 *         description: Finding is not in an applied state, or no snapshots to revert.
 */
router.post(
  '/doctor/findings/:findingId/revert',
  requireAuth,
  revertDoctorFindingHandler,
);

// ============================================================================
// NEGATIVE TESTING
// ============================================================================

// Toggle negative testing on a plan item
router.patch('/plans/:planId/items/:itemId/negative-testing', requireAuth, toggleNegativeTesting);

// Generate negative test cases for a plan
router.post('/plans/:planId/generate-negatives', requireAuth, generateNegatives);

// List negative test cases for a plan
router.get('/plans/:planId/negatives', requireAuth, getNegatives);

// Get generation status (for reconnecting users)
router.get('/plans/:planId/negatives/status', requireAuth, getNegativesStatus);

// Pre-run estimate of extra test count / minutes from negatives
router.get('/plans/:planId/negatives/estimate', requireAuth, getNegativesEstimate);

// Regenerate negatives for one source test case in the plan
router.post('/plans/:planId/sources/:testCaseId/regenerate-negatives', requireAuth, regenerateNegatives);

// Bulk control (enable/disable / delete many). Plan-scoped route; authorized
// per-negative by project in the service.
router.patch('/plans/:planId/negatives/bulk', requireAuth, bulkSetNegativesEnabled);
router.delete('/plans/:planId/negatives/bulk', requireAuth, bulkDeleteNegatives);

// Per-negative control (enable/disable, delete)
router.patch('/negatives/:negativeId', requireAuth, setNegativeEnabled);
router.delete('/negatives/:negativeId', requireAuth, deleteNegative);

export default router;
