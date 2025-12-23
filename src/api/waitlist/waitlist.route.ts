import { getWaitlist, joinWaitlist } from './waitlist.controller';
import { asyncHandler } from '@/utils/core/error-handler';
import { requireAdmin, requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';

const router = Router();

/**
 * @swagger
 * /api/v1/waitlist/join:
 *   post:
 *     summary: Join waitlist
 *     description: Add email to waitlist for early access
 *     tags: [Waitlist]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - role
 *             properties:
 *               name:
 *                 type: string
 *                 example: "John Doe"
 *                 description: Full name
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "john@example.com"
 *                 description: Email address
 *               role:
 *                 type: string
 *                 enum: [qa_engineer, software_engineer, founder_cto, product_manager, other]
 *                 example: "qa_engineer"
 *                 description: User role
 *     responses:
 *       200:
 *         description: Successfully joined waitlist
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Successfully joined the waitlist"
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                       example: "waitlist_123"
 *                     email:
 *                       type: string
 *                       example: "john@example.com"
 *                     name:
 *                       type: string
 *                       example: "John Doe"
 *                     role:
 *                       type: string
 *                       example: "qa_engineer"
 *                     joinedAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-12-18T12:00:00.000Z"
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
 *                 code:
 *                   type: string
 *                   example: "VALIDATION_ERROR"
 *                 details:
 *                   type: object
 *                   example:
 *                     email: "Invalid email format"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       409:
 *         description: Email already exists
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
 *                   example: "Email already registered"
 *                 code:
 *                   type: string
 *                   example: "EMAIL_ALREADY_EXISTS"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.post('/join', asyncHandler(joinWaitlist));

/**
 * @swagger
 * /api/v1/waitlist:
 *   get:
 *     summary: Get waitlist entries (admin only)
 *     description: Get paginated list of all waitlist signups. Requires admin authentication.
 *     tags: [Waitlist]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of entries per page
 *     responses:
 *       200:
 *         description: Successfully retrieved waitlist entries
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
 *                       email:
 *                         type: string
 *                       name:
 *                         type: string
 *                       role:
 *                         type: string
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
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     has_more:
 *                       type: boolean
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 *       400:
 *         description: Validation error
 */
router.get('/', requireAuth, requireAdmin, asyncHandler(getWaitlist));

export default router;
