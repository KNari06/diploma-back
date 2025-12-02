import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/error-handler';
import { Router } from 'express';
import {
    createProject,
    deleteProject,
    getProject,
    getProjects,
    updateProject,
} from './project.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/projects:
 *   post:
 *     summary: Create a new project
 *     description: Creates a new project within a workspace
 *     tags: [Projects]
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
 *               - workspace_id
 *             properties:
 *               name:
 *                 type: string
 *                 example: "My Test Project"
 *               description:
 *                 type: string
 *                 example: "Project description"
 *               workspace_id:
 *                 type: string
 *                 format: uuid
 *                 example: "123e4567-e89b-12d3-a456-426614174000"
 *               settings:
 *                 type: object
 *                 properties:
 *                   main_url:
 *                     type: string
 *                     format: uri
 *                     example: "https://example.com"
 *                   defaultBrowsers:
 *                     type: array
 *                     items:
 *                       type: string
 *                       enum: [chrome, firefox, safari, edge]
 *                     example: ["chrome", "firefox"]
 *     responses:
 *       201:
 *         description: Project created successfully
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/',
  requireAuth,
  asyncHandler(createProject)
);

/**
 * @swagger
 * /api/v1/projects:
 *   get:
 *     summary: Get all projects for current user
 *     description: Returns list of projects. Can be filtered by workspace_id query parameter
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Optional workspace ID to filter projects
 *     responses:
 *       200:
 *         description: List of projects
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  requireAuth,
  asyncHandler(getProjects)
);

/**
 * @swagger
 * /api/v1/projects/{id}:
 *   get:
 *     summary: Get project by ID
 *     description: Returns a specific project
 *     tags: [Projects]
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
 *         description: Project details
 *       404:
 *         description: Project not found
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/:id',
  requireAuth,
  asyncHandler(getProject)
);

/**
 * @swagger
 * /api/v1/projects/{id}:
 *   put:
 *     summary: Update project
 *     description: Updates an existing project. Note: workspace_id cannot be changed.
 *     tags: [Projects]
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
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Updated Project Name"
 *               description:
 *                 type: string
 *                 example: "Updated project description"
 *               settings:
 *                 type: object
 *                 properties:
 *                   main_url:
 *                     type: string
 *                     format: uri
 *                     example: "https://example.com"
 *                   defaultBrowsers:
 *                     type: array
 *                     items:
 *                       type: string
 *                       enum: [chrome, firefox, safari, edge]
 *                     example: ["chrome", "firefox"]
 *     responses:
 *       200:
 *         description: Project updated successfully
 *       400:
 *         description: Invalid request (e.g., trying to change workspace_id)
 *       404:
 *         description: Project not found
 *       401:
 *         description: Unauthorized
 */
router.put(
  '/:id',
  requireAuth,
  asyncHandler(updateProject)
);

/**
 * @swagger
 * /api/v1/projects/{id}:
 *   delete:
 *     summary: Delete project
 *     description: Deletes a project
 *     tags: [Projects]
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
 *         description: Project deleted
 *       404:
 *         description: Project not found
 *       401:
 *         description: Unauthorized
 */
router.delete(
  '/:id',
  requireAuth,
  asyncHandler(deleteProject)
);

export default router;
