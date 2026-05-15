import {
  AccessDeniedError,
  WorkspaceAccessService,
  WorkspaceRole,
} from '@/services/core/workspace-access.service';
import { WorkspaceMembersService } from '@/services/core/workspace-members.service';
import {
  AUDIT_EVENTS,
  AuditEventType,
  WorkspaceAuditService,
  getAuditContext,
} from '@/services/core/workspace-audit.service';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// MEMBERS ENDPOINTS
// ============================================================================

/**
 * GET /api/v1/workspaces/:id/members
 * Get all members of a workspace
 */
export const getMembers = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Check membership (any active member can view members)
    try {
      await WorkspaceAccessService.requireMembership(userId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const members = await WorkspaceMembersService.getMembers(workspaceId);

    res.json({
      success: true,
      data: members,
      count: members.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error getting members', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get members',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * PATCH /api/v1/workspaces/:id/members/:userId
 * Change a member's role (owner only)
 */
export const changeMemberRole = async (req: Request, res: Response): Promise<void> => {
  try {
    const actorUserId = req.user?.id;
    const workspaceId = req.params.id;
    const targetUserId = req.params.userId;
    const { role } = req.body;

    if (!actorUserId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!targetUserId || !UUID_REGEX.test(targetUserId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid target user ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!role || !['full_access', 'view'].includes(role)) {
      res.status(400).json({
        success: false,
        error: 'Invalid role. Must be "full_access" or "view"',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Only owner can change roles
    try {
      await WorkspaceAccessService.requireOwner(actorUserId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const result = await WorkspaceMembersService.changeRole(
      workspaceId,
      targetUserId,
      role as WorkspaceRole,
      actorUserId,
      getAuditContext(req)
    );

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      message: 'Member role updated successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error changing member role', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to change member role',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * DELETE /api/v1/workspaces/:id/members/:userId
 * Remove a member (owner only)
 */
export const removeMember = async (req: Request, res: Response): Promise<void> => {
  try {
    const actorUserId = req.user?.id;
    const workspaceId = req.params.id;
    const targetUserId = req.params.userId;

    if (!actorUserId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!targetUserId || !UUID_REGEX.test(targetUserId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid target user ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Only owner can remove members
    try {
      await WorkspaceAccessService.requireOwner(actorUserId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const result = await WorkspaceMembersService.removeMember(
      workspaceId,
      targetUserId,
      actorUserId,
      getAuditContext(req)
    );

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      message: 'Member removed successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error removing member', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to remove member',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * POST /api/v1/workspaces/:id/transfer-owner
 * Transfer ownership to another member (owner only)
 */
export const transferOwnership = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentOwnerUserId = req.user?.id;
    const workspaceId = req.params.id;
    const { newOwnerUserId } = req.body;

    if (!currentOwnerUserId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!newOwnerUserId || !UUID_REGEX.test(newOwnerUserId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid new owner user ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Only current owner can transfer ownership
    try {
      await WorkspaceAccessService.requireOwner(currentOwnerUserId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const result = await WorkspaceMembersService.transferOwnership(
      workspaceId,
      newOwnerUserId,
      currentOwnerUserId,
      getAuditContext(req)
    );

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      message: 'Ownership transferred successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error transferring ownership', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to transfer ownership',
      timestamp: new Date().toISOString(),
    });
  }
};

// ============================================================================
// INVITES ENDPOINTS
// ============================================================================

/**
 * POST /api/v1/workspaces/:id/invites
 * Create an invite (owner only)
 */
export const createInvite = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;
    const { email, role } = req.body;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
      res.status(400).json({
        success: false,
        error: 'Invalid email address',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!role || !['full_access', 'view'].includes(role)) {
      res.status(400).json({
        success: false,
        error: 'Invalid role. Must be "full_access" or "view"',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Only owner can create invites
    try {
      await WorkspaceAccessService.requireOwner(userId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const result = await WorkspaceMembersService.createInvite(
      workspaceId,
      email,
      role as 'full_access' | 'view',
      userId,
      getAuditContext(req)
    );

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const message = result.userExists
      ? 'Invite created. User already registered - they should check their workspace invites in the app.'
      : 'Invite created and email sent successfully';

    res.status(201).json({
      success: true,
      data: result.invite,
      message,
      emailSent: result.emailSent,
      userExists: result.userExists,
      inviteUrl: result.inviteUrl,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error creating invite', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to create invite',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/workspaces/:id/invites
 * Get all invites for a workspace (owner only)
 */
export const getInvites = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Only owner can view invites
    try {
      await WorkspaceAccessService.requireOwner(userId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const invites = await WorkspaceMembersService.getInvites(workspaceId);

    res.json({
      success: true,
      data: invites,
      count: invites.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error getting invites', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get invites',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * POST /api/v1/workspaces/:id/invites/:inviteId/resend
 * Resend an invite (owner only)
 */
export const resendInvite = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;
    const inviteId = req.params.inviteId;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!inviteId || !UUID_REGEX.test(inviteId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid invite ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Only owner can resend invites
    try {
      await WorkspaceAccessService.requireOwner(userId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const result = await WorkspaceMembersService.resendInvite(
      inviteId,
      workspaceId,
      userId,
      getAuditContext(req)
    );

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      message: 'Invite resent successfully',
      emailSent: result.emailSent,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error resending invite', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to resend invite',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * POST /api/v1/workspaces/:id/invites/:inviteId/revoke
 * Revoke an invite (owner only)
 */
export const revokeInvite = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;
    const inviteId = req.params.inviteId;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!inviteId || !UUID_REGEX.test(inviteId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid invite ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Only owner can revoke invites
    try {
      await WorkspaceAccessService.requireOwner(userId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const result = await WorkspaceMembersService.revokeInvite(
      inviteId,
      workspaceId,
      userId,
      getAuditContext(req)
    );

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      message: 'Invite revoked successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error revoking invite', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to revoke invite',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/invites/info?token=<inviteId>
 * Get invite details for the accept/decline page (no auth required)
 */
export const getInviteInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.query.token as string;

    if (!token || !UUID_REGEX.test(token)) {
      res.status(400).json({ success: false, error: 'Invalid invite token', timestamp: new Date().toISOString() });
      return;
    }

    const invite = await WorkspaceMembersService.getInvite(token);
    if (!invite) {
      res.status(404).json({ success: false, error: 'Invite not found', timestamp: new Date().toISOString() });
      return;
    }

    if (invite.status === 'revoked') {
      res.status(400).json({ success: false, error: 'This invite has been revoked', timestamp: new Date().toISOString() });
      return;
    }
    if (invite.status === 'accepted') {
      res.status(400).json({ success: false, error: 'This invite has already been accepted', timestamp: new Date().toISOString() });
      return;
    }
    if (invite.status === 'expired' || new Date(invite.expires_at) < new Date()) {
      res.status(400).json({ success: false, error: 'This invite has expired', timestamp: new Date().toISOString() });
      return;
    }

    const [{ data: workspace }, { data: inviter }] = await Promise.all([
      supabaseAdmin.from('workspaces').select('project_name').eq('id', invite.workspace_id).single(),
      supabaseAdmin.from('users').select('name, email').eq('id', invite.invited_by_user_id).single(),
    ]);

    res.json({
      success: true,
      data: {
        workspace_name: workspace?.project_name || null,
        inviter_name: inviter?.name || inviter?.email || null,
        role: invite.role,
        email: invite.email,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error getting invite info', { error });
    res.status(500).json({ success: false, error: 'Failed to get invite info', timestamp: new Date().toISOString() });
  }
};

/**
 * POST /api/v1/invites/:inviteId/decline
 * Decline an invite (authenticated user)
 */
export const declineInvite = async (req: Request, res: Response): Promise<void> => {
  try {
    const inviteId = req.params.inviteId;

    if (!inviteId || !UUID_REGEX.test(inviteId)) {
      res.status(400).json({ success: false, error: 'Invalid invite ID', timestamp: new Date().toISOString() });
      return;
    }

    const invite = await WorkspaceMembersService.getInvite(inviteId);
    if (!invite) {
      res.status(404).json({ success: false, error: 'Invite not found', timestamp: new Date().toISOString() });
      return;
    }

    if (invite.status !== 'invited') {
      res.status(400).json({
        success: false,
        error: 'Invite cannot be declined (already accepted, revoked, or expired)',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    await supabaseAdmin
      .from('workspace_invites')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', inviteId);

    res.json({ success: true, message: 'Invite declined', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error declining invite', { error });
    res.status(500).json({ success: false, error: 'Failed to decline invite', timestamp: new Date().toISOString() });
  }
};

/**
 * POST /api/v1/invites/:inviteId/accept
 * Accept an invite (authenticated user)
 */
export const acceptInvite = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const userEmail = req.user?.email;
    const inviteId = req.params.inviteId;

    if (!userId || !userEmail) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!inviteId || !UUID_REGEX.test(inviteId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid invite ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const result = await WorkspaceMembersService.acceptInvite(
      inviteId,
      userId,
      userEmail,
      getAuditContext(req)
    );

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: result.membership,
      message: 'Invite accepted successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error accepting invite', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to accept invite',
      timestamp: new Date().toISOString(),
    });
  }
};

// ============================================================================
// AUDIT LOG ENDPOINT
// ============================================================================

const VALID_AUDIT_EVENTS = new Set<string>(Object.values(AUDIT_EVENTS));

/**
 * GET /api/v1/workspaces/:id/audit-log
 * Returns paginated workspace activity for the Settings > Activity page.
 * Query params: page (1-based), limit (1–100), action (event_type filter).
 * Only workspace owners may read — matches the RLS policy on workspace_audit_log.
 */
export const getAuditLog = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      await WorkspaceAccessService.requireOwner(userId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20)
    );

    let eventTypes: AuditEventType[] | undefined;
    const actionParam = req.query.action;
    if (actionParam && actionParam !== 'all') {
      const raw = Array.isArray(actionParam)
        ? actionParam.map((v) => String(v))
        : String(actionParam).split(',');
      const filtered = raw
        .map((v) => v.trim())
        .filter((v) => v && VALID_AUDIT_EVENTS.has(v));
      if (filtered.length > 0) eventTypes = filtered as AuditEventType[];
    }

    const result = await WorkspaceAuditService.getAuditLogsPaginated(workspaceId, {
      page,
      limit,
      eventTypes,
    });

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_MEMBERS_API] Error getting audit log', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get audit log',
      timestamp: new Date().toISOString(),
    });
  }
};
