import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import * as skillsController from './skills.controller';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * @swagger
 * /api/v1/kb/skills:
 *   get:
 *     summary: List all skills for the workspace
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID (auto-resolved if not provided)
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [fact, preference, test_pattern, bug_pattern, integration_context]
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [agent_written, auto_extracted, user_provided]
 *       - in: query
 *         name: enabled
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *     responses:
 *       200:
 *         description: List of skills
 */
router.get('/', skillsController.listSkills);

/**
 * @swagger
 * /api/v1/kb/skills:
 *   post:
 *     summary: Create a new skill
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key, content, category]
 *             properties:
 *               key:
 *                 type: string
 *                 maxLength: 200
 *               content:
 *                 type: string
 *                 maxLength: 5000
 *               category:
 *                 type: string
 *                 enum: [fact, preference, test_pattern, bug_pattern, integration_context]
 *               workspaceId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       201:
 *         description: Skill created
 */
router.post('/', skillsController.createSkill);

/**
 * @swagger
 * /api/v1/kb/skills/batch:
 *   post:
 *     summary: Create multiple skills at once (max 10)
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [skills]
 *             properties:
 *               skills:
 *                 type: array
 *                 maxItems: 10
 *                 items:
 *                   type: object
 *                   required: [key, content, category]
 *                   properties:
 *                     key:
 *                       type: string
 *                     content:
 *                       type: string
 *                     category:
 *                       type: string
 *                       enum: [fact, preference, test_pattern, bug_pattern, integration_context]
 *               workspaceId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       201:
 *         description: Skills created
 */
router.post('/batch', skillsController.batchCreateSkills);

/**
 * @swagger
 * /api/v1/kb/skills/suggest-from-test:
 *   post:
 *     summary: Get AI-generated skill suggestions from a test case
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [testCaseId]
 *             properties:
 *               testCaseId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Suggested skills
 */
router.post('/suggest-from-test', skillsController.suggestFromTest);

/**
 * @swagger
 * /api/v1/kb/skills/{id}:
 *   get:
 *     summary: Get skill details
 *     tags: [Knowledge Base]
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
 *         description: Skill details
 *       404:
 *         description: Skill not found
 */
router.get('/:id', skillsController.getSkill);

/**
 * @swagger
 * /api/v1/kb/skills/{id}:
 *   put:
 *     summary: Update a skill
 *     tags: [Knowledge Base]
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
 *               key:
 *                 type: string
 *               content:
 *                 type: string
 *               category:
 *                 type: string
 *                 enum: [fact, preference, test_pattern, bug_pattern, integration_context]
 *     responses:
 *       200:
 *         description: Skill updated
 */
router.put('/:id', skillsController.updateSkill);

/**
 * @swagger
 * /api/v1/kb/skills/{id}:
 *   delete:
 *     summary: Delete a skill
 *     tags: [Knowledge Base]
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
 *         description: Skill deleted
 */
router.delete('/:id', skillsController.deleteSkill);

/**
 * @swagger
 * /api/v1/kb/skills/{id}/toggle:
 *   patch:
 *     summary: Enable or disable a skill
 *     tags: [Knowledge Base]
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
 *             required: [enabled]
 *             properties:
 *               enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Skill toggled
 */
router.patch('/:id/toggle', skillsController.toggleSkill);

export default router;
