/**
 * Preview Routes
 * API routes for step editor preview and intent test cases
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import multer from 'multer';
import { uploadTestFile } from './upload.controller';
import {
  batchRunIntentTestCases,
  cancelIntentTestCase,
  createIntentTestCase,
  deleteIntentTestCase,
  getIntentTestCase,
  getPreconditions,
  listIntentTestCases,
  runIntentTestCase,
  startPreview,
  stopPreview,
  updateIntentTestCase,
} from './preview.controller';
import { saveDraftRunAsTestCase } from './draft.controller';

const router = Router();

// ============================================================================
// PREVIEW SESSION ROUTES
// ============================================================================

/**
 * @swagger
 * components:
 *   schemas:
 *     PreviewSimpleError:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *       required: [error]
 *
 *     PreviewIntentStep:
 *       type: object
 *       description: |
 *         Draft step structure used by Step Editor (V3: added ai_check support).
 *         Shape is flexible; backend supports extra fields. This schema documents the common subset.
 *       properties:
 *         id:
 *           type: string
 *         type:
 *           type: string
 *           description: Action type (type, click, wait, assert, navigate, select, hover, scroll, press, check, uncheck, toggle, open, close, ai_check)
 *           enum: [type, click, wait, assert, navigate, select, hover, scroll, press, check, uncheck, toggle, open, close, ai_check]
 *         description:
 *           type: string
 *         value:
 *           type: string
 *           description: Optional value for type/assert/etc
 *         assertionText:
 *           type: string
 *           description: |
 *             (V3) Natural language assertion for ai_check type.
 *             Example: "There is a black nav bar with five links"
 *             Required when type === 'ai_check'
 *         bindingHints:
 *           type: object
 *           properties:
 *             role: { type: string }
 *             label: { type: string }
 *             placeholder: { type: string }
 *             nearText: { type: string }
 *             autocomplete: { type: string }
 *             type: { type: string }
 *         options:
 *           type: object
 *           properties:
 *             timeout: { type: number, description: 'Timeout in milliseconds' }
 *             humanLike: { type: boolean, description: 'Human-like execution mode (gradual typing, hover before click)' }
 *             replaceContent: { type: boolean, description: 'Replace content instead of appending (type action)' }
 *             pressEnter: { type: boolean, description: 'Press Enter after type' }
 *             keyPressDelay: { type: number, description: 'Delay between keystrokes in ms' }
 *             aiContextMode:
 *               type: string
 *               enum: [html, screenshot, 'html+a11y', 'html+screenshot', 'html+a11y+screenshot']
 *               description: |
 *                 (V3) AI context mode for ai_check assertions.
 *                 Specifies what context to provide to the LLM:
 *                 - 'html': HTML content only
 *                 - 'screenshot': Screenshot only
 *                 - 'html+a11y': HTML + accessibility tree (no screenshot)
 *                 - 'html+screenshot': HTML + screenshot
 *                 - 'html+a11y+screenshot': HTML + accessibility tree + screenshot (default, most comprehensive)
 *           additionalProperties: true
 *       additionalProperties: true
 *
 *     PreviewBoundingBox:
 *       type: object
 *       properties:
 *         x: { type: number }
 *         y: { type: number }
 *         width: { type: number }
 *         height: { type: number }
 *
 *     PreviewLintCandidate:
 *       type: object
 *       properties:
 *         ref: { type: string, nullable: true }
 *         label: { type: string }
 *         reason: { type: string }
 *         confidence: { type: number }
 *         boundingBox:
 *           $ref: '#/components/schemas/PreviewBoundingBox'
 *
 *     PreviewHighlight:
 *       type: object
 *       properties:
 *         ref: { type: string, nullable: true }
 *         boundingBox:
 *           $ref: '#/components/schemas/PreviewBoundingBox'
 *         type:
 *           type: string
 *           enum: [success, warning, error]
 *
 *     PreviewStepLintRequest:
 *       type: object
 *       required: [previewSessionId, stepDraft]
 *       properties:
 *         previewSessionId: { type: string }
 *         stepDraft:
 *           $ref: '#/components/schemas/PreviewIntentStep'
 *         pageRef:
 *           type: string
 *           description: Optional page reference (client cache hint)
 *         includeAlternatives:
 *           type: boolean
 *           description: When true, include full candidates list even for needs_clarification
 *
 *     PreviewStepApplyRequest:
 *       type: object
 *       required: [previewSessionId, stepDraft]
 *       properties:
 *         previewSessionId: { type: string }
 *         stepDraft:
 *           $ref: '#/components/schemas/PreviewIntentStep'
 *         pageRef: { type: string }
 *         intentTestCaseId:
 *           type: string
 *           description: Optional. If provided, auto-persist appliedStep to this test case after successful apply.
 *
 *     PreviewClarifySelectRequest:
 *       type: object
 *       required: [previewSessionId, stepId, selectedRef]
 *       properties:
 *         previewSessionId: { type: string }
 *         stepId: { type: string }
 *         selectedRef: { type: string }
 *
 *     PreviewStepLintResultPayload:
 *       type: object
 *       required: [status, message, confidence, candidates, highlight, timestamp]
 *       properties:
 *         status:
 *           type: string
 *           enum: [resolved, ambiguous, not_found, needs_clarification, error]
 *         message: { type: string }
 *         confidence: { type: number }
 *         candidates:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/PreviewLintCandidate'
 *         highlight:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/PreviewHighlight'
 *         interpretation: { type: string }
 *         clarificationQuestion: { type: string }
 *         alternativesIncluded: { type: boolean }
 *         applyDisabled: { type: boolean }
 *         timestamp: { type: string, format: date-time }
 *
 *     PreviewStepApplyResultPayload:
 *       type: object
 *       required: [success, timestamp]
 *       properties:
 *         success: { type: boolean }
 *         error: { type: string }
 *         appliedStep:
 *           $ref: '#/components/schemas/PreviewIntentStep'
 *         urlChanged: { type: boolean }
 *         url: { type: string }
 *         highlight:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/PreviewHighlight'
 *         attempts: { type: integer }
 *         timestamp: { type: string, format: date-time }
 *
 *     PreviewClarifyPayload:
 *       type: object
 *       required: [previewSessionId, stepId, candidates, interpretation, message, timestamp]
 *       properties:
 *         previewSessionId: { type: string }
 *         stepId: { type: string }
 *         candidates:
 *           type: array
 *           items:
 *             type: object
 *             required: [ref, label, reason]
 *             properties:
 *               ref: { type: string }
 *               label: { type: string }
 *               reason: { type: string }
 *               boundingBox:
 *                 $ref: '#/components/schemas/PreviewBoundingBox'
 *         interpretation: { type: string }
 *         message: { type: string }
 *         timestamp: { type: string, format: date-time }
 *
 *     PreviewMouseMoveRequest:
 *       type: object
 *       required: [previewSessionId, x, y]
 *       properties:
 *         previewSessionId: { type: string }
 *         x: { type: number }
 *         y: { type: number }
 *
 *     PreviewMouseClickRequest:
 *       type: object
 *       required: [previewSessionId, x, y]
 *       properties:
 *         previewSessionId: { type: string }
 *         x: { type: number }
 *         y: { type: number }
 *         button:
 *           type: string
 *           enum: [left, right, middle]
 *         clickCount:
 *           type: integer
 *           description: 1=single, 2=double
 *
 *     PreviewMouseButtonRequest:
 *       type: object
 *       required: [previewSessionId, x, y]
 *       properties:
 *         previewSessionId: { type: string }
 *         x: { type: number }
 *         y: { type: number }
 *         button:
 *           type: string
 *           enum: [left, right, middle]
 *
 *     PreviewMouseWheelRequest:
 *       type: object
 *       required: [previewSessionId, deltaX, deltaY]
 *       properties:
 *         previewSessionId: { type: string }
 *         deltaX: { type: number }
 *         deltaY: { type: number }
 *
 *     PreviewKeyboardTypeRequest:
 *       type: object
 *       required: [previewSessionId, text]
 *       properties:
 *         previewSessionId: { type: string }
 *         text: { type: string }
 *
 *     PreviewKeyboardPressRequest:
 *       type: object
 *       required: [previewSessionId, key]
 *       properties:
 *         previewSessionId: { type: string }
 *         key: { type: string }
 *         modifiers:
 *           type: array
 *           items:
 *             type: string
 *             enum: [Control, Shift, Alt, Meta]
 *
 *     PreviewViewportPayload:
 *       type: object
 *       required: [previewSessionId, viewport, devicePixelRatio, timestamp]
 *       properties:
 *         previewSessionId: { type: string }
 *         viewport:
 *           $ref: '#/components/schemas/PreviewViewport'
 *         devicePixelRatio: { type: number }
 *         timestamp: { type: string, format: date-time }
 *
 *     PreviewMouseResultPayload:
 *       type: object
 *       required: [previewSessionId, success, action, timestamp]
 *       properties:
 *         previewSessionId: { type: string }
 *         success: { type: boolean }
 *         action:
 *           type: string
 *           enum: [move, click, down, up, wheel, type, press]
 *         error: { type: string }
 *         timestamp: { type: string, format: date-time }
 *
 *     PreviewMouseProbeRequest:
 *       type: object
 *       required: [previewSessionId, x, y]
 *       properties:
 *         previewSessionId: { type: string }
 *         x: { type: number }
 *         y: { type: number }
 *
 *     PreviewMouseProbeResultPayload:
 *       type: object
 *       required: [previewSessionId, x, y, timestamp]
 *       properties:
 *         previewSessionId: { type: string }
 *         x: { type: number }
 *         y: { type: number }
 *         element:
 *           type: object
 *           additionalProperties: true
 *         timestamp: { type: string, format: date-time }
 *
 *     PreviewPageActionResultPayload:
 *       type: object
 *       required: [previewSessionId, action, success, timestamp]
 *       properties:
 *         previewSessionId: { type: string }
 *         action:
 *           type: string
 *           enum: [refresh, reset]
 *         success: { type: boolean }
 *         error: { type: string }
 *         timestamp: { type: string, format: date-time }
 *
 *     PreviewNetworkDetailRequest:
 *       type: object
 *       required: [previewSessionId, id]
 *       properties:
 *         previewSessionId: { type: string }
 *         id: { type: string }
 *
 *     PreviewHtmlRequest:
 *       type: object
 *       required: [previewSessionId]
 *       properties:
 *         previewSessionId: { type: string }
 *         domVersion: { type: integer }
 *
 *     PreviewAccessibilityRequest:
 *       type: object
 *       required: [previewSessionId]
 *       properties:
 *         previewSessionId: { type: string }
 *         domVersion: { type: integer }
 *
 *     PreviewContextSetRequest:
 *       type: object
 *       required: [previewSessionId, data]
 *       properties:
 *         previewSessionId: { type: string }
 *         data:
 *           type: object
 *           additionalProperties: true
 *
 *     PreviewContextUpdatePayload:
 *       type: object
 *       required: [previewSessionId, version, data, timestamp]
 *       properties:
 *         previewSessionId: { type: string }
 *         version: { type: integer }
 *         data:
 *           type: object
 *           additionalProperties: true
 *         timestamp: { type: string, format: date-time }
 *
 *     PreviewStartRequest:
 *       type: object
 *       required: [projectId, startUrl]
 *       properties:
 *         projectId:
 *           type: string
 *           format: uuid
 *           description: Project ID (owner scope)
 *         startUrl:
 *           type: string
 *           format: uri
 *           description: URL to open in headless browser for Step Editor preview
 *     PreviewViewport:
 *       type: object
 *       properties:
 *         width:
 *           type: integer
 *           example: 1280
 *         height:
 *           type: integer
 *           example: 720
 *     PreviewStartResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: true
 *         data:
 *           type: object
 *           properties:
 *             previewSessionId:
 *               type: string
 *               description: Unique preview session id (used for WebSocket subscription)
 *               example: preview_35f2ea87-935d-4cb1-b6f4-7e059246c619
 *             url:
 *               type: string
 *               format: uri
 *               description: Final URL after redirects (page.url())
 *             domNodes:
 *               type: array
 *               description: Interactive nodes extracted from initial snapshot (used by Step Editor lint/highlight)
 *               items:
 *                 type: object
 *                 additionalProperties: true
 *             viewport:
 *               $ref: '#/components/schemas/PreviewViewport'
 *             devicePixelRatio:
 *               type: number
 *               example: 1
 *
 * /api/v1/preview/start:
 *   post:
 *     summary: Start a preview session
 *     description: |
 *       Starts a server-side Step Editor Preview session:
 *       - Launches headless Chromium (Playwright)
 *       - Navigates to `startUrl`
 *       - Collects initial DOM snapshot and extracts interactive nodes
 *       - Returns `previewSessionId` that the frontend uses to subscribe via WebSocket
 *
 *       WebSocket flow after successful start:
 *
 *       Client → Server events (what frontend sends):
 *       - `subscribe:preview` — subscribe to room `preview:<previewSessionId>` `{ previewSessionId }`
 *       - `unsubscribe:preview` — unsubscribe `{ previewSessionId }`
 *       - `preview:step:lint` — lint/resolve draft step `{ previewSessionId, stepDraft, pageRef?, includeAlternatives? }`
 *       - `preview:step:clarify:select` — user selects candidate `{ previewSessionId, stepId, selectedRef }`
 *       - `preview:step:apply` — execute step in preview browser `{ previewSessionId, stepDraft, pageRef? }`
 *       - `preview:mouse:move` — hover by coords `{ previewSessionId, x, y }`
 *       - `preview:mouse:click` — click by coords `{ previewSessionId, x, y, button?, clickCount? }`
 *       - `preview:mouse:down` / `preview:mouse:up` — drag support `{ previewSessionId, x, y, button? }`
 *       - `preview:mouse:wheel` — scroll `{ previewSessionId, deltaX, deltaY }`
 *       - `preview:keyboard:type` — type text `{ previewSessionId, text }`
 *       - `preview:keyboard:press` — key press `{ previewSessionId, key, modifiers? }`
 *       - `preview:page:refresh` — reload page `{ previewSessionId }`
 *       - `preview:page:reset` — reset context/page and return to startUrl `{ previewSessionId }`
 *       - `preview:network:detail:request` — request network item detail `{ previewSessionId, id }`
 *       - `preview:html:request` — request HTML `{ previewSessionId, domVersion? }`
 *       - `preview:accessibility:request` — request accessibility tree `{ previewSessionId, domVersion? }`
 *       - `preview:context:set` — update editor context vars `{ previewSessionId, data }`
 *       - `preview:mouse:probe` — debug: element under point `{ previewSessionId, x, y }`
 *
 *       Server → Client events (what backend emits):
 *       - `preview:page` — DOM state updates `{ previewSessionId, url, domVersion, pageSignature, domNodes?, timestamp }`
 *       - `preview:video:frame` — JPEG frames (base64) `{ previewSessionId, seq, format, data, width, height, domVersion, timestamp }`
 *       - `preview:viewport` — viewport metadata `{ previewSessionId, viewport, devicePixelRatio, timestamp }`
 *       - `preview:mouse:result` — lightweight ACK for input `{ previewSessionId, success, action, error?, timestamp }`
 *       - `preview:mouse:probe:result` — debug probe result `{ previewSessionId, x, y, element?, timestamp }`
 *       - `preview:page:action:result` — refresh/reset result `{ previewSessionId, action, success, error?, timestamp }`
 *       - `preview:step:lint:result` — lint outcome (candidates/highlights) `{ status, message, confidence, candidates, highlight, ... }`
 *       - `preview:step:clarify` — ask user to pick element `{ previewSessionId, stepId, candidates, interpretation, message, timestamp }`
 *       - `preview:step:apply:result` — step execution result `{ success, error?, appliedStep?, urlChanged?, url?, highlight?, attempts?, timestamp }`
 *       - DevTools: `preview:console:update`, `preview:network:update`, `preview:network:detail`, `preview:html:update`, `preview:accessibility:update`, `preview:context:update`
 *     tags: [Preview]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PreviewStartRequest'
 *     responses:
 *       200:
 *         description: Preview session started
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PreviewStartResponse'
 *       400:
 *         description: Invalid input (missing projectId/startUrl)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PreviewSimpleError'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PreviewSimpleError'
 *       500:
 *         description: Failed to start preview (browser launch/goto/snapshot failed)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PreviewSimpleError'
 */
router.post('/start', requireAuth, startPreview);

/**
 * @swagger
 * /api/v1/preview/stop:
 *   post:
 *     summary: Stop a preview session
 *     description: |
 *       Stops a Step Editor Preview session and closes server-side browser resources.
 *       After stop:
 *       - `previewSessionId` becomes invalid (WS subscribe will be rejected)
 *       - Frontend should unsubscribe from `preview:<previewSessionId>` (best effort)
 *
 *       Note: Preview sessions also have TTL auto-cleanup on the backend.
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
 *       400:
 *         description: Missing previewSessionId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PreviewSimpleError'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PreviewSimpleError'
 *       403:
 *         description: Forbidden (session not owned by user)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PreviewSimpleError'
 *       500:
 *         description: Failed to stop preview (cleanup error)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PreviewSimpleError'
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
 * /api/v1/preview/intent-test-cases/{id}/preconditions:
 *   get:
 *     summary: Transitive precondition (dependency) steps grouped by dependency
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
 *         description: Ordered precondition groups (testCaseId, name, steps)
 */
router.get('/intent-test-cases/:id/preconditions', requireAuth, getPreconditions);

/**
 * @swagger
 * /api/v1/preview/intent-test-cases/{id}:
 *   patch:
 *     summary: Update an intent test case
 *     description: |
 *       Update an intent test case. The backend may auto-insert `wait_for` steps
 *       between steps where navigation was detected (based on compiled.context.pageUrl diff).
 *       
 *       **IMPORTANT for Frontend**: After successful PATCH, frontend MUST replace local
 *       `editorSteps` with `response.data.stepsJson` to include any auto-inserted
 *       `wait_for` steps. Otherwise, the user will see a stale step list.
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
 *                 description: Array of IntentStep objects. May be modified by backend (auto-inserted wait_for steps).
 *     responses:
 *       200:
 *         description: Test case updated. Response includes data.stepsJson with potentially auto-inserted wait_for steps.
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

/**
 * @swagger
 * /api/v1/preview/intent-test-cases/{id}/run:
 *   post:
 *     summary: Run an intent test case
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
 *               browsers:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [chromium, firefox, webkit]
 *                 default: [chromium]
 *               projectId:
 *                 type: string
 *                 description: Optional override project ID
 *     responses:
 *       200:
 *         description: Test run started
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
 *                     testId:
 *                       type: string
 *                     intentTestCaseId:
 *                       type: string
 *                     browsers:
 *                       type: array
 *                       items:
 *                         type: string
 *                     stepsCount:
 *                       type: integer
 *                     commandsCount:
 *                       type: integer
 *       404:
 *         description: Test case not found
 *       400:
 *         description: No steps to run
 */
/**
 * @swagger
 * /api/v1/preview/intent-test-cases/batch-run:
 *   post:
 *     summary: Run multiple intent test cases in parallel
 *     description: Start execution of multiple test cases with controlled concurrency
 *     tags: [Preview - Intent Test Cases]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - testCaseIds
 *             properties:
 *               testCaseIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 description: Array of intent test case IDs to run (max 20)
 *               browsers:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [chromium, firefox, webkit]
 *                 default: [chromium]
 *               concurrency:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *                 default: 3
 *                 description: Maximum number of parallel test runs
 *     responses:
 *       200:
 *         description: Batch run started
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
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           intentTestCaseId:
 *                             type: string
 *                           testId:
 *                             type: string
 *                           success:
 *                             type: boolean
 *                           error:
 *                             type: string
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: integer
 *                         started:
 *                           type: integer
 *                         failed:
 *                           type: integer
 *                         notFound:
 *                           type: integer
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 */
// IMPORTANT: batch-run MUST be before :id/run to avoid route conflict
router.post('/intent-test-cases/batch-run', requireAuth, batchRunIntentTestCases);

router.post('/intent-test-cases/:id/run', requireAuth, runIntentTestCase);

/**
 * @swagger
 * /api/v1/preview/intent-test-cases/{id}/cancel:
 *   post:
 *     summary: Cancel a running intent test case
 *     tags: [Intent Test Cases]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Intent test case ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [testId]
 *             properties:
 *               testId:
 *                 type: string
 *                 format: uuid
 *                 description: Test run ID returned by the run endpoint
 *     responses:
 *       200:
 *         description: Test cancelled successfully
 *       400:
 *         description: Test already completed or testId missing
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Test not found
 */
router.post('/intent-test-cases/:id/cancel', requireAuth, cancelIntentTestCase);

// ============================================================================
// FILE UPLOAD FOR UPLOAD STEPS (V6)
// ============================================================================

const uploadStorage = multer.memoryStorage();
const uploadFile = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

/**
 * @swagger
 * /api/v1/preview/upload-file:
 *   post:
 *     summary: Upload a file for use in upload steps
 *     tags: [Preview]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: File uploaded successfully
 *       400:
 *         description: Missing file
 *       401:
 *         description: Unauthorized
 */
router.post('/upload-file', requireAuth, uploadFile.single('file'), uploadTestFile);

// ============================================================================
// DRAFT RUN ROUTES (Quick Action framework)
// ============================================================================
//
// These routes power the universal Quick Action framework for in-chat draft
// runs. They are consumed by the frontend QuickActions component (see
// apps/web/src/components/quickActions/) via descriptors emitted from the
// backend quick-actions injector. Every endpoint added here MUST also be
// registered in src/api/preview/quick-action-endpoints.ts (the security
// whitelist) — actions whose endpoint string is missing from the whitelist
// are silently rejected by the frontend dispatcher.

/**
 * @swagger
 * /api/v1/preview/draft/save-as-test-case:
 *   post:
 *     summary: Persist a cached draft run as an intent_test_case
 *     description: |
 *       Reads steps from DraftStepsCache (keyed by chatSessionId), resolves
 *       a name via the waterfall (override → AI suggested → first navigate
 *       URL → default), and creates an intent_test_case in the database.
 *
 *       The cache is cleared after a successful save. Failures leave the
 *       cache intact so the user can retry.
 *
 *       Triggered by the "Save as test case" Quick Action button below
 *       successful draft runs in editor mode.
 *     tags: [Preview - Draft]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [previewSessionId, chatSessionId]
 *             properties:
 *               previewSessionId:
 *                 type: string
 *                 description: Preview session ID owned by the caller
 *               chatSessionId:
 *                 type: string
 *                 description: Chat session ID under which steps are cached
 *               nameOverride:
 *                 type: string
 *                 description: Optional user-supplied name (highest priority)
 *     responses:
 *       200:
 *         description: Test case created
 *       400:
 *         description: Missing fields or empty cached steps
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Preview session not owned, or cached steps belong to a different user
 *       404:
 *         description: Preview session or cached steps not found
 *       500:
 *         description: Internal error (cache is preserved so user can retry)
 */
router.post('/draft/save-as-test-case', requireAuth, saveDraftRunAsTestCase);

export default router;
