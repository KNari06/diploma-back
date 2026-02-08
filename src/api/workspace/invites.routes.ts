import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import { acceptInvite } from './workspace-members.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/invites/{inviteId}/accept:
 *   post:
 *     summary: Accept invite
 *     description: Accept a workspace invite. Authenticated user only. Email must match invite email.
 *     tags: [Workspace Invites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: inviteId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Invite ID
 *     responses:
 *       200:
 *         description: Invite accepted successfully
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
 *                     id:
 *                       type: string
 *                     workspace_id:
 *                       type: string
 *                     user_id:
 *                       type: string
 *                     role:
 *                       type: string
 *                       enum: [owner, full_access, view]
 *                     status:
 *                       type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid invite or email mismatch
 *       401:
 *         description: Authentication required
 */
router.post(
  '/:inviteId/accept',
  requireAuth,
  asyncHandler(acceptInvite)
);

export default router;
