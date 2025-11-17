import { Router } from 'express';
import { asyncHandler } from '@/utils/error-handler';
import { requireAuth } from '@/middleware/auth.middleware';
import {
  generateReport,
  getReport,
  createJiraIssue,
  downloadCode,
} from './reports.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/reports/generate/{testId}:
 *   post:
 *     summary: Generate comprehensive test report with code and artifacts
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *         description: Test ID
 *     responses:
 *       200:
 *         description: Report generated successfully
 *       404:
 *         description: Test not found
 *       500:
 *         description: Server error
 */
router.post('/generate/:testId', requireAuth, asyncHandler(generateReport));

/**
 * @swagger
 * /api/v1/reports/{testId}:
 *   get:
 *     summary: Get existing test report
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *         description: Test ID
 *     responses:
 *       200:
 *         description: Report found
 *       404:
 *         description: Report not found
 *       500:
 *         description: Server error
 */
router.get('/:testId', requireAuth, asyncHandler(getReport));

/**
 * @swagger
 * /api/v1/reports/{testId}/jira:
 *   post:
 *     summary: Create Jira issue from test report
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *         description: Test ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectKey
 *             properties:
 *               projectKey:
 *                 type: string
 *                 description: Jira project key (e.g., "PROJ")
 *               issueType:
 *                 type: string
 *                 enum: [Bug, Task, Story]
 *                 default: Bug
 *               priority:
 *                 type: string
 *                 enum: [Highest, High, Medium, Low, Lowest]
 *                 description: Issue priority (auto-determined if not specified)
 *     responses:
 *       200:
 *         description: Jira issue created successfully
 *       401:
 *         description: Jira not connected
 *       404:
 *         description: Test not found
 *       500:
 *         description: Server error
 */
router.post('/:testId/jira', requireAuth, asyncHandler(createJiraIssue));

/**
 * @swagger
 * /api/v1/reports/{testId}/code:
 *   get:
 *     summary: Download generated Playwright test code
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *         description: Test ID
 *     responses:
 *       200:
 *         description: Code file download
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       404:
 *         description: Report not found
 *       500:
 *         description: Server error
 */
router.get('/:testId/code', requireAuth, asyncHandler(downloadCode));

export default router;
