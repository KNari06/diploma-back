import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/error-handler';
import { Router } from 'express';
import {
  getNotifications,
  markNotificationsAsRead,
} from './notifications.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/notifications:
 *   get:
 *     summary: Get user notifications
 *     description: Get personal and general notifications for the authenticated user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [personal, general, system, all]
 *         description: |
 *           Filter by notification type (default: all)
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [test, discount, billing, system, feature, announcement]
 *         description: Filter by category
 *       - in: query
 *         name: is_read
 *         schema:
 *           type: boolean
 *         description: Filter by read status
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Number of notifications to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Number of notifications to skip
 *     responses:
 *       200:
 *         description: Notifications retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 notifications:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       type:
 *                         type: string
 *                         enum: [personal, general, system]
 *                       category:
 *                         type: string
 *                       title:
 *                         type: string
 *                       message:
 *                         type: string
 *                       metadata:
 *                         type: object
 *                       action_url:
 *                         type: string
 *                       action_label:
 *                         type: string
 *                       is_read:
 *                         type: boolean
 *                       created_at:
 *                         type: string
 *                 pagination:
 *                   type: object
 *                 unread_count:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get('/', requireAuth, asyncHandler(getNotifications));

/**
 * @swagger
 * /api/v1/notifications/read:
 *   post:
 *     summary: Mark notifications as read
 *     description: Mark specific notifications or all notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notification_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of notification IDs to mark as read
 *               mark_all_as_read:
 *                 type: boolean
 *                 description: Mark all notifications as read
 *               type:
 *                 type: string
 *                 enum: [personal, general, system, all]
 *                 description: Filter type when mark_all_as_read is true
 *     responses:
 *       200:
 *         description: Notifications marked as read successfully
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.post('/read', requireAuth, asyncHandler(markNotificationsAsRead));

export default router;
