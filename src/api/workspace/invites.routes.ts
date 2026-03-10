import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import { acceptInvite, declineInvite, getInviteInfo } from './workspace-members.controller';

const router = Router();

/**
 * GET /api/v1/invites/info?token=<inviteId>
 * Get invite details (workspace name, inviter, role) by token — no auth required.
 */
router.get('/info', asyncHandler(getInviteInfo));

/**
 * POST /api/v1/invites/:inviteId/accept
 * Accept a workspace invite. Authenticated user only.
 */
router.post('/:inviteId/accept', requireAuth, asyncHandler(acceptInvite));

/**
 * POST /api/v1/invites/:inviteId/decline
 * Decline a workspace invite. Authenticated user only.
 */
router.post('/:inviteId/decline', requireAuth, asyncHandler(declineInvite));

export default router;
