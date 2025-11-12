import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/error-handler';
import {
  createWorkspace,
  getWorkspaces,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
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
