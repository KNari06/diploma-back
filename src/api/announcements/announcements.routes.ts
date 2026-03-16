import { requireAuth, requireAdmin } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import {
  getActiveAnnouncements,
  dismissAnnouncement,
  listAllAnnouncements,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from './announcements.controller';

const router = Router();

// ── User-facing endpoints ──

/**
 * @swagger
 * /api/v1/announcements/active:
 *   get:
 *     summary: Get the latest active announcement for the current user
 *     description: Returns the most recent active, non-dismissed announcement. Empty if already dismissed.
 *     tags: [Announcements]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active announcement retrieved (or empty array if none)
 *       401:
 *         description: Unauthorized
 */
router.get('/active', requireAuth, asyncHandler(getActiveAnnouncements));

/**
 * @swagger
 * /api/v1/announcements/{id}/dismiss:
 *   post:
 *     summary: Dismiss an announcement (mark as "Got it")
 *     tags: [Announcements]
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
 *         description: Announcement dismissed
 *       401:
 *         description: Unauthorized
 */
router.post('/:id/dismiss', requireAuth, asyncHandler(dismissAnnouncement));

// ── Admin endpoints ──

/**
 * @swagger
 * /api/v1/announcements/admin:
 *   get:
 *     summary: List all announcements with stats (admin)
 *     tags: [Announcements]
 *     security:
 *       - bearerAuth: []
 */
router.get('/admin', requireAuth, requireAdmin, asyncHandler(listAllAnnouncements));

/**
 * @swagger
 * /api/v1/announcements/admin/{id}:
 *   get:
 *     summary: Get announcement by ID (admin)
 *     tags: [Announcements]
 *     security:
 *       - bearerAuth: []
 */
router.get('/admin/:id', requireAuth, requireAdmin, asyncHandler(getAnnouncementById));

/**
 * @swagger
 * /api/v1/announcements/admin:
 *   post:
 *     summary: Create a new announcement (admin)
 *     tags: [Announcements]
 *     security:
 *       - bearerAuth: []
 */
router.post('/admin', requireAuth, requireAdmin, asyncHandler(createAnnouncement));

/**
 * @swagger
 * /api/v1/announcements/admin/{id}:
 *   put:
 *     summary: Update an announcement (admin)
 *     tags: [Announcements]
 *     security:
 *       - bearerAuth: []
 */
router.put('/admin/:id', requireAuth, requireAdmin, asyncHandler(updateAnnouncement));

/**
 * @swagger
 * /api/v1/announcements/admin/{id}:
 *   delete:
 *     summary: Delete an announcement (admin)
 *     tags: [Announcements]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/admin/:id', requireAuth, requireAdmin, asyncHandler(deleteAnnouncement));

export default router;
