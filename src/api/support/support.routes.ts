import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { submitReport, getUserReports, getReportById } from './support.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/support/report:
 *   post:
 *     summary: Submit a user report
 *     description: |
 *       Submit a report for bugs, UI issues, feature requests, or other problems.
 *       The report will be saved to the database and admin users will be notified.
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - category
 *               - details
 *             properties:
 *               title:
 *                 type: string
 *                 maxLength: 200
 *                 description: Report title (max 200 characters)
 *                 example: "Button not working on test results page"
 *               category:
 *                 type: string
 *                 enum: [bug, ui, feature, other]
 *                 description: Report category
 *                 example: "bug"
 *               details:
 *                 type: string
 *                 maxLength: 500
 *                 description: Detailed description (max 500 characters)
 *                 example: "When I click the 'Export' button on test results page, nothing happens. Expected to download a CSV file."
 *               workspace_name:
 *                 type: string
 *                 maxLength: 255
 *                 description: Optional workspace name for context
 *                 example: "My Workspace"
 *               view:
 *                 type: string
 *                 maxLength: 255
 *                 description: Optional view/screen where the issue occurred
 *                 example: "Test Results"
 *     responses:
 *       201:
 *         description: Report submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 id:
 *                   type: string
 *                   format: uuid
 *                   example: "123e4567-e89b-12d3-a456-426614174000"
 *                 status:
 *                   type: string
 *                   enum: [pending, in_progress, resolved, closed]
 *                   example: "pending"
 *                 message:
 *                   type: string
 *                   example: "Report submitted successfully"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Validation error
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
 *                   example: "Validation error"
 *                 message:
 *                   type: string
 *                   example: "Title is required"
 *                 field:
 *                   type: string
 *                   example: "title"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized
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
 *                   example: "Unauthorized"
 *                 message:
 *                   type: string
 *                   example: "Authorization required"
 *       500:
 *         description: Internal server error
 */
router.post('/report', requireAuth, asyncHandler(submitReport));

/**
 * @swagger
 * /api/v1/support/reports:
 *   get:
 *     summary: Get user's own reports
 *     description: Get all reports submitted by the authenticated user with pagination
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Number of reports per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Number of reports to skip
 *     responses:
 *       200:
 *         description: Reports retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       user_id:
 *                         type: string
 *                         format: uuid
 *                       title:
 *                         type: string
 *                       category:
 *                         type: string
 *                         enum: [bug, ui, feature, other]
 *                       details:
 *                         type: string
 *                       workspace_name:
 *                         type: string
 *                         nullable: true
 *                       view:
 *                         type: string
 *                         nullable: true
 *                       status:
 *                         type: string
 *                         enum: [pending, in_progress, resolved, closed]
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                       updated_at:
 *                         type: string
 *                         format: date-time
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.get('/reports', requireAuth, asyncHandler(getUserReports));

/**
 * @swagger
 * /api/v1/support/reports/{id}:
 *   get:
 *     summary: Get a specific report by ID
 *     description: Get details of a specific report submitted by the authenticated user
 *     tags: [Support]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Report ID
 *     responses:
 *       200:
 *         description: Report retrieved successfully
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
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     user_id:
 *                       type: string
 *                       format: uuid
 *                     title:
 *                       type: string
 *                     category:
 *                       type: string
 *                       enum: [bug, ui, feature, other]
 *                     details:
 *                       type: string
 *                     workspace_name:
 *                       type: string
 *                       nullable: true
 *                     view:
 *                       type: string
 *                       nullable: true
 *                     status:
 *                       type: string
 *                       enum: [pending, in_progress, resolved, closed]
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *                     updated_at:
 *                       type: string
 *                       format: date-time
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Report not found
 *       500:
 *         description: Internal server error
 */
router.get('/reports/:id', requireAuth, asyncHandler(getReportById));

export default router;
