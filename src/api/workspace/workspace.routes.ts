import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/error-handler';
import { Router } from 'express';
import {
  getOnboarding,
  saveOnboarding,
} from './onboarding.controller';
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  getWorkspaces,
  updateWorkspace,
} from './workspace.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/workspaces:
 *   post:
 *     summary: Create a new workspace
 *     description: Creates a new workspace for the current user (authenticated or anonymous via IP)
 *     tags: [Workspaces]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - project_name
 *               - platforms
 *             properties:
 *               project_name:
 *                 type: string
 *                 example: "My Test Project"
 *               platforms:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [web, mobile, api]
 *                 example: ["web", "api"]
 *               api_testing:
 *                 type: boolean
 *                 example: true
 *               dev_base_url:
 *                 type: string
 *                 example: "https://dev.example.com"
 *               prod_base_url:
 *                 type: string
 *                 example: "https://example.com"
 *               settings:
 *                 type: object
 *     responses:
 *       201:
 *         description: Workspace created successfully
 *       400:
 *         description: Invalid request
 */
router.post(
  '/',
  requireAuth,
  asyncHandler(createWorkspace)
);

/**
 * @swagger
 * /api/v1/workspaces:
 *   get:
 *     summary: Get all workspaces for current user
 *     description: Returns list of workspaces (authenticated or anonymous via IP)
 *     tags: [Workspaces]
 *     responses:
 *       200:
 *         description: List of workspaces
 */
router.get(
  '/',
  requireAuth,
  asyncHandler(getWorkspaces)
);

/**
 * @swagger
 * /api/v1/workspaces/onboarding:
 *   post:
 *     summary: Save onboarding data
 *     description: Saves onboarding data (project name, base URLs, environments, browser type) for the user's workspace
 *     tags: [Workspaces]
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
 *               - baseUrls
 *               - environments
 *               - browserType
 *             properties:
 *               name:
 *                 type: string
 *                 example: "My Test Project"
 *               baseUrls:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["https://dev.example.com", "https://staging.example.com"]
 *               environments:
 *                 type: object
 *                 properties:
 *                   dev:
 *                     type: string
 *                     example: "https://dev.example.com"
 *                   predprod:
 *                     type: string
 *                     example: "https://staging.example.com"
 *                   prod:
 *                     type: string
 *                     example: "https://prod.example.com"
 *               browserType:
 *                 type: string
 *                 enum: [chrome, firefox, safari, edge]
 *                 default: chrome
 *                 example: "chrome"
 *     responses:
 *       200:
 *         description: Onboarding data saved successfully
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/onboarding',
  requireAuth,
  asyncHandler(saveOnboarding)
);

/**
 * @swagger
 * /api/v1/workspaces/onboarding:
 *   get:
 *     summary: Get onboarding data
 *     description: |
 *       Returns onboarding data if already completed, or completed: false if not
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: |
 *           Onboarding data or completed: false
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   oneOf:
 *                     - type: object
 *                       properties:
 *                         completed:
 *                           type: boolean
 *                           example: false
 *                     - type: object
 *                       properties:
 *                         name:
 *                           type: string
 *                           example: "My Test Project"
 *                         baseUrls:
 *                           type: array
 *                           items:
 *                             type: string
 *                           example: ["https://dev.example.com", "https://prod.example.com"]
 *                         environments:
 *                           type: object
 *                           properties:
 *                             dev:
 *                               type: string
 *                             predprod:
 *                               type: string
 *                             prod:
 *                               type: string
 *                         browserType:
 *                           type: string
 *                           enum: [chrome, firefox, safari, edge]
 *                         completed:
 *                           type: boolean
 *                           example: true
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/onboarding',
  requireAuth,
  asyncHandler(getOnboarding)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}:
 *   get:
 *     summary: Get workspace by ID
 *     description: Returns a specific workspace
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Workspace details
 *       404:
 *         description: Workspace not found
 */
router.get(
  '/:id',
  requireAuth,
  asyncHandler(getWorkspace)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}:
 *   put:
 *     summary: Update workspace
 *     description: Updates an existing workspace
 *     tags: [Workspaces]
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
 *     responses:
 *       200:
 *         description: Workspace updated
 *       404:
 *         description: Workspace not found
 */
router.put(
  '/:id',
  requireAuth,
  asyncHandler(updateWorkspace)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}:
 *   delete:
 *     summary: Delete workspace
 *     description: Deletes a workspace
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Workspace deleted
 *       404:
 *         description: Workspace not found
 */
router.delete(
  '/:id',
  requireAuth,
  asyncHandler(deleteWorkspace)
);

export default router;
