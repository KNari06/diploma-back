import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import {
  WorkspaceAccessService,
  WorkspaceMembership,
  WorkspaceRole,
} from './workspace-access.service';
import { WorkspaceAuditService } from './workspace-audit.service';
import { EmailService } from './email.service';

// ============================================================================
// WORKSPACE INVITE INTERFACE
// ============================================================================

export interface WorkspaceInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: WorkspaceRole;
  status: 'invited' | 'accepted' | 'revoked' | 'expired';
  invited_by_user_id: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  supabase_invite_user_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// WORKSPACE MEMBERS SERVICE
// ============================================================================

export class WorkspaceMembersService {
  // ============================================================================
  // MEMBER MANAGEMENT
  // ============================================================================

  /**
   * Get all members of a workspace (with user info)
   */
  static async getMembers(workspaceId: string): Promise<
    Array<
      WorkspaceMembership & {
        user?: { email: string; name: string | null };
      }
    >
  > {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspace_members')
        .select(
          `
          *,
          user:users!workspace_members_user_id_fkey (
            email,
            name
          )
        `
        )
        .eq('workspace_id', workspaceId)
        .eq('status', 'active')
        .order('created_at', { ascending: true });

      if (error) {
        logger.error('[WORKSPACE_MEMBERS] Error getting members', {
          error: error.message,
          workspaceId,
        });
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception getting members', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return [];
    }
  }

  /**
   * Change a member's role
   * Only owner can change roles, and cannot change own role
   */
  static async changeRole(
    workspaceId: string,
    targetUserId: string,
    newRole: WorkspaceRole,
    actorUserId: string,
    auditContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Cannot change to owner - must use transferOwnership
      if (newRole === 'owner') {
        return { success: false, error: 'Cannot change role to owner. Use transfer ownership instead.' };
      }

      // Get current membership
      const currentMembership = await WorkspaceAccessService.getMembership(targetUserId, workspaceId);
      if (!currentMembership) {
        return { success: false, error: 'Target user is not a member of this workspace' };
      }

      // Cannot change owner's role - must transfer first
      if (currentMembership.role === 'owner') {
        return { success: false, error: 'Cannot change owner role. Transfer ownership first.' };
      }

      const oldRole = currentMembership.role;

      // Update role
      const { error } = await supabaseAdmin
        .from('workspace_members')
        .update({ role: newRole, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
        .eq('user_id', targetUserId)
        .eq('status', 'active');

      if (error) {
        logger.error('[WORKSPACE_MEMBERS] Error changing role', {
          error: error.message,
          workspaceId,
          targetUserId,
        });
        return { success: false, error: 'Failed to change role' };
      }

      // Log audit
      await WorkspaceAuditService.logMemberRoleChanged({
        workspaceId,
        actorUserId,
        targetUserId,
        oldRole,
        newRole,
        ...auditContext,
      });

      logger.info('[WORKSPACE_MEMBERS] Role changed', {
        workspaceId,
        targetUserId,
        oldRole,
        newRole,
        actorUserId,
      });

      return { success: true };
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception changing role', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        targetUserId,
      });
      return { success: false, error: 'Failed to change role' };
    }
  }

  /**
   * Remove a member (soft delete - set status to 'removed')
   * Cannot remove the last owner
   */
  static async removeMember(
    workspaceId: string,
    targetUserId: string,
    actorUserId: string,
    auditContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Get current membership
      const currentMembership = await WorkspaceAccessService.getMembership(targetUserId, workspaceId);
      if (!currentMembership) {
        return { success: false, error: 'Target user is not a member of this workspace' };
      }

      // Cannot remove owner - must transfer first
      if (currentMembership.role === 'owner') {
        return { success: false, error: 'Cannot remove owner. Transfer ownership first.' };
      }

      // Soft delete - set status to 'removed'
      const { error } = await supabaseAdmin
        .from('workspace_members')
        .update({ status: 'removed', updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
        .eq('user_id', targetUserId)
        .eq('status', 'active');

      if (error) {
        logger.error('[WORKSPACE_MEMBERS] Error removing member', {
          error: error.message,
          workspaceId,
          targetUserId,
        });
        return { success: false, error: 'Failed to remove member' };
      }

      // Log audit
      await WorkspaceAuditService.logMemberRemoved({
        workspaceId,
        actorUserId,
        targetUserId,
        previousRole: currentMembership.role,
        ...auditContext,
      });

      logger.info('[WORKSPACE_MEMBERS] Member removed', {
        workspaceId,
        targetUserId,
        previousRole: currentMembership.role,
        actorUserId,
      });

      return { success: true };
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception removing member', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        targetUserId,
      });
      return { success: false, error: 'Failed to remove member' };
    }
  }

  /**
   * Transfer ownership to another member
   * Atomic operation: new owner gets 'owner' role, old owner gets 'full_access'
   */
  static async transferOwnership(
    workspaceId: string,
    newOwnerUserId: string,
    currentOwnerUserId: string,
    auditContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Verify new owner is an active member
      const newOwnerMembership = await WorkspaceAccessService.getMembership(
        newOwnerUserId,
        workspaceId
      );
      if (!newOwnerMembership) {
        return { success: false, error: 'Target user is not a member of this workspace' };
      }

      // Cannot transfer to self
      if (newOwnerUserId === currentOwnerUserId) {
        return { success: false, error: 'Cannot transfer ownership to yourself' };
      }

      // IMPORTANT:
      // We have a partial unique index enforcing at most one active owner per workspace.
      // Therefore we MUST demote the current owner FIRST, then promote the new owner.
      // (Promote-first would temporarily create 2 owners and violate the unique index.)
      //
      // Using a transaction would be ideal, but Supabase JS doesn't support multi-statement
      // transactions. We do it sequentially with rollback on failure.

      // 1. Demote current owner first
      const { error: demoteError } = await supabaseAdmin
        .from('workspace_members')
        .update({ role: 'full_access', updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
        .eq('user_id', currentOwnerUserId)
        .eq('status', 'active');

      if (demoteError) {
        logger.error('[WORKSPACE_MEMBERS] Error demoting current owner', {
          error: demoteError.message,
          workspaceId,
          currentOwnerUserId,
        });
        return { success: false, error: 'Failed to transfer ownership' };
      }

      // 2. Promote new owner
      const { error: promoteError } = await supabaseAdmin
        .from('workspace_members')
        .update({ role: 'owner', updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
        .eq('user_id', newOwnerUserId)
        .eq('status', 'active');

      if (promoteError) {
        logger.error(
          '[WORKSPACE_MEMBERS] Error promoting new owner, attempting rollback (re-promote previous owner)',
          {
            error: promoteError.message,
            workspaceId,
            newOwnerUserId,
            currentOwnerUserId,
          }
        );

        // Rollback: restore current owner to 'owner'
        const { error: rollbackError } = await supabaseAdmin
          .from('workspace_members')
          .update({ role: 'owner', updated_at: new Date().toISOString() })
          .eq('workspace_id', workspaceId)
          .eq('user_id', currentOwnerUserId)
          .eq('status', 'active');

        if (rollbackError) {
          // CRITICAL: workspace is now ownerless. Log as critical for immediate alerting.
          logger.error('[WORKSPACE_MEMBERS] CRITICAL: Rollback failed - workspace has no owner!', {
            workspaceId,
            currentOwnerUserId,
            rollbackError: rollbackError.message,
          });
        }

        return { success: false, error: 'Failed to transfer ownership' };
      }

      // Log audit
      await WorkspaceAuditService.logOwnerTransferred({
        workspaceId,
        fromUserId: currentOwnerUserId,
        toUserId: newOwnerUserId,
        ...auditContext,
      });

      logger.info('[WORKSPACE_MEMBERS] Ownership transferred', {
        workspaceId,
        fromUserId: currentOwnerUserId,
        toUserId: newOwnerUserId,
      });

      return { success: true };
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception transferring ownership', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        newOwnerUserId,
      });
      return { success: false, error: 'Failed to transfer ownership' };
    }
  }

  // ============================================================================
  // INVITE MANAGEMENT
  // ============================================================================

  /**
   * Create an invite
   */
  static async createInvite(
    workspaceId: string,
    email: string,
    role: 'full_access' | 'view',
    invitedByUserId: string,
    auditContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<{
    success: boolean;
    invite?: WorkspaceInvite;
    error?: string;
    emailSent?: boolean;
    userExists?: boolean;
    inviteUrl?: string;
  }> {
    try {
      const normalizedEmail = email.trim().toLowerCase();

      // Check by email in users table
      const { data: existingUser } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (existingUser) {
        // Check if this user is already a member
        const { data: memberCheck } = await supabaseAdmin
          .from('workspace_members')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('user_id', existingUser.id)
          .eq('status', 'active')
          .maybeSingle();

        if (memberCheck) {
          return { success: false, error: 'User is already a member of this workspace' };
        }
      }

      // Check if there's a pending invite for this email
      const { data: existingInvite } = await supabaseAdmin
        .from('workspace_invites')
        .select('id, status')
        .eq('workspace_id', workspaceId)
        .eq('email', normalizedEmail)
        .eq('status', 'invited')
        .maybeSingle();

      if (existingInvite) {
        return { success: false, error: 'An invite for this email is already pending' };
      }

      // Create invite
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

      const { data: invite, error } = await supabaseAdmin
        .from('workspace_invites')
        .insert({
          workspace_id: workspaceId,
          email: normalizedEmail,
          role,
          status: 'invited',
          invited_by_user_id: invitedByUserId,
          expires_at: expiresAt.toISOString(),
        })
        .select()
        .single();

      if (error) {
        logger.error('[WORKSPACE_MEMBERS] Error creating invite', {
          error: error.message,
          workspaceId,
          email: normalizedEmail,
        });
        return { success: false, error: 'Failed to create invite' };
      }

      // Send email notification
      let emailSent = false;
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const redirectTo = `${frontendUrl}/invite/accept?token=${invite.id}&workspaceId=${workspaceId}`;

      try {
        logger.info('[WORKSPACE_MEMBERS] Sending invite email', {
          email: normalizedEmail,
          redirectTo,
          frontendUrl,
          userExists: !!existingUser,
        });

        if (existingUser) {
          // For existing users: send custom email via nodemailer
          // Supabase Auth doesn't send emails to existing users via inviteUserByEmail
          logger.info('[WORKSPACE_MEMBERS] User exists - sending custom email', {
            email: normalizedEmail,
            userId: existingUser.id,
          });

          // Update invite with existing user ID
          await supabaseAdmin
            .from('workspace_invites')
            .update({ supabase_invite_user_id: existingUser.id })
            .eq('id', invite.id);

          // Get workspace name for email
          const { data: workspace } = await supabaseAdmin
            .from('workspaces')
            .select('name')
            .eq('id', workspaceId)
            .single();

          // Send custom email
          const emailResult = await EmailService.sendWorkspaceInvite({
            inviteId: invite.id,
            workspaceId,
            workspaceName: workspace?.name,
            recipientEmail: normalizedEmail,
            role,
            frontendUrl,
          });

          emailSent = emailResult.success;

          if (!emailSent) {
            logger.warn('[WORKSPACE_MEMBERS] Custom email failed for existing user', {
              email: normalizedEmail,
              error: emailResult.error,
            });
          }
        } else {
          // For new users, use inviteUserByEmail
          const { data: authInvite, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
            normalizedEmail,
            { redirectTo }
          );

          if (authError) {
            logger.error('[WORKSPACE_MEMBERS] Supabase auth invite failed', {
              error: authError.message,
              errorCode: authError.code,
              email: normalizedEmail,
              redirectTo,
            });
          } else if (authInvite?.user?.id) {
            emailSent = true;
            // Update invite with Supabase user ID
            await supabaseAdmin
              .from('workspace_invites')
              .update({ supabase_invite_user_id: authInvite.user.id })
              .eq('id', invite.id);

            logger.info('[WORKSPACE_MEMBERS] Invite email sent successfully', {
              email: normalizedEmail,
              userId: authInvite.user.id,
              inviteId: invite.id,
            });
          } else {
            logger.warn('[WORKSPACE_MEMBERS] Invite email response unclear', {
              email: normalizedEmail,
              hasData: !!authInvite,
              hasUserId: !!authInvite?.user?.id,
            });
          }
        }
      } catch (authError) {
        logger.error('[WORKSPACE_MEMBERS] Exception sending email', {
          error: authError instanceof Error ? authError.message : String(authError),
          stack: authError instanceof Error ? authError.stack : undefined,
          email: normalizedEmail,
        });
      }

      // Log audit
      await WorkspaceAuditService.logInviteCreated({
        workspaceId,
        actorUserId: invitedByUserId,
        inviteId: invite.id,
        email: normalizedEmail,
        role,
        ...auditContext,
      });

      logger.info('[WORKSPACE_MEMBERS] Invite created', {
        workspaceId,
        inviteId: invite.id,
        email: normalizedEmail,
        role,
        emailSent,
        userExists: !!existingUser,
      });

      return {
        success: true,
        invite,
        emailSent,
        userExists: !!existingUser,
        inviteUrl: redirectTo,
      };
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception creating invite', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        email,
      });
      return { success: false, error: 'Failed to create invite' };
    }
  }

  /**
   * Get all invites for a workspace
   * Returns only pending (invited) invites by default
   */
  static async getInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
    try {
      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('workspace_invites')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('status', 'invited') // Only return pending invites
        .gt('expires_at', now) // Exclude expired invites
        .order('created_at', { ascending: false });

      if (error) {
        logger.error('[WORKSPACE_MEMBERS] Error getting invites', {
          error: error.message,
          workspaceId,
        });
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception getting invites', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return [];
    }
  }

  /**
   * Get an invite by ID
   */
  static async getInvite(inviteId: string): Promise<WorkspaceInvite | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspace_invites')
        .select('*')
        .eq('id', inviteId)
        .maybeSingle();

      if (error) {
        logger.error('[WORKSPACE_MEMBERS] Error getting invite', {
          error: error.message,
          inviteId,
        });
        return null;
      }

      return data;
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception getting invite', {
        error: error instanceof Error ? error.message : String(error),
        inviteId,
      });
      return null;
    }
  }

  /**
   * Revoke an invite
   */
  static async revokeInvite(
    inviteId: string,
    workspaceId: string,
    actorUserId: string,
    auditContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Get invite
      const invite = await this.getInvite(inviteId);
      if (!invite) {
        return { success: false, error: 'Invite not found' };
      }

      // Ensure invite belongs to the specified workspace (prevent IDOR)
      if (invite.workspace_id !== workspaceId) {
        return { success: false, error: 'Invite not found' };
      }

      if (invite.status !== 'invited') {
        return { success: false, error: 'Invite cannot be revoked (already accepted, revoked, or expired)' };
      }

      // Revoke
      const { error } = await supabaseAdmin
        .from('workspace_invites')
        .update({ status: 'revoked', updated_at: new Date().toISOString() })
        .eq('id', inviteId);

      if (error) {
        logger.error('[WORKSPACE_MEMBERS] Error revoking invite', {
          error: error.message,
          inviteId,
        });
        return { success: false, error: 'Failed to revoke invite' };
      }

      // Log audit
      await WorkspaceAuditService.logInviteRevoked({
        workspaceId: invite.workspace_id,
        actorUserId,
        inviteId,
        email: invite.email,
        ...auditContext,
      });

      logger.info('[WORKSPACE_MEMBERS] Invite revoked', {
        inviteId,
        email: invite.email,
      });

      return { success: true };
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception revoking invite', {
        error: error instanceof Error ? error.message : String(error),
        inviteId,
      });
      return { success: false, error: 'Failed to revoke invite' };
    }
  }

  /**
   * Resend an invite
   */
  static async resendInvite(
    inviteId: string,
    workspaceId: string,
    actorUserId: string,
    auditContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ success: boolean; error?: string; emailSent?: boolean }> {
    try {
      // Get invite
      const invite = await this.getInvite(inviteId);
      if (!invite) {
        return { success: false, error: 'Invite not found' };
      }

      // Ensure invite belongs to the specified workspace (prevent IDOR)
      if (invite.workspace_id !== workspaceId) {
        return { success: false, error: 'Invite not found' };
      }

      if (invite.status !== 'invited') {
        return { success: false, error: 'Invite cannot be resent (already accepted, revoked, or expired)' };
      }

      // Extend expiry
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const { error } = await supabaseAdmin
        .from('workspace_invites')
        .update({
          expires_at: expiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', inviteId);

      if (error) {
        logger.error('[WORKSPACE_MEMBERS] Error resending invite', {
          error: error.message,
          inviteId,
        });
        return { success: false, error: 'Failed to resend invite' };
      }

      // Resend email - branch on whether the user already exists (same logic as createInvite)
      let emailResent = false;
      try {
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const redirectTo = `${frontendUrl}/invite/accept?token=${invite.id}&workspaceId=${invite.workspace_id}`;

        logger.info('[WORKSPACE_MEMBERS] Resending invite email', {
          email: invite.email,
          redirectTo,
          inviteId,
        });

        // Check if user already exists in our system
        const { data: existingUser } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('email', invite.email)
          .maybeSingle();

        if (existingUser) {
          // Existing user: send custom email (Supabase won't re-invite confirmed users)
          const { data: workspace } = await supabaseAdmin
            .from('workspaces')
            .select('name')
            .eq('id', invite.workspace_id)
            .single();

          const emailResult = await EmailService.sendWorkspaceInvite({
            inviteId: invite.id,
            workspaceId: invite.workspace_id,
            workspaceName: workspace?.name,
            recipientEmail: invite.email,
            role: invite.role,
            frontendUrl,
          });

          emailResent = emailResult.success;

          if (!emailResent) {
            logger.warn('[WORKSPACE_MEMBERS] Custom email resend failed for existing user', {
              email: invite.email,
              error: emailResult.error,
            });
          } else {
            logger.info('[WORKSPACE_MEMBERS] Invite email resent successfully (existing user)', {
              email: invite.email,
              inviteId,
            });
          }
        } else {
          // New user: use Supabase auth invite
          const { data: authInvite, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
            invite.email,
            { redirectTo }
          );

          if (authError) {
            logger.error('[WORKSPACE_MEMBERS] Supabase auth resend failed', {
              error: authError.message,
              errorCode: authError.code,
              email: invite.email,
            });
          } else if (authInvite?.user?.id) {
            emailResent = true;
            logger.info('[WORKSPACE_MEMBERS] Invite email resent successfully (new user)', {
              email: invite.email,
              inviteId,
            });
          }
        }
      } catch (authError) {
        logger.error('[WORKSPACE_MEMBERS] Exception resending invite email', {
          error: authError instanceof Error ? authError.message : String(authError),
          stack: authError instanceof Error ? authError.stack : undefined,
          email: invite.email,
        });
      }

      // Log audit
      await WorkspaceAuditService.logInviteResent({
        workspaceId: invite.workspace_id,
        actorUserId,
        inviteId,
        email: invite.email,
        ...auditContext,
      });

      logger.info('[WORKSPACE_MEMBERS] Invite resent', {
        inviteId,
        email: invite.email,
        emailResent,
      });

      return { success: true, emailSent: emailResent };
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception resending invite', {
        error: error instanceof Error ? error.message : String(error),
        inviteId,
      });
      return { success: false, error: 'Failed to resend invite' };
    }
  }

  /**
   * Accept an invite
   * Creates membership and marks invite as accepted
   */
  static async acceptInvite(
    inviteId: string,
    userId: string,
    userEmail: string,
    auditContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ success: boolean; membership?: WorkspaceMembership; error?: string }> {
    try {
      // Get invite
      const invite = await this.getInvite(inviteId);
      if (!invite) {
        return { success: false, error: 'Invite not found' };
      }

      // Validate status
      if (invite.status === 'revoked') {
        return { success: false, error: 'This invite has been revoked' };
      }

      if (invite.status === 'accepted') {
        // Idempotent - check if user is already a member
        const existingMembership = await WorkspaceAccessService.getMembership(
          userId,
          invite.workspace_id
        );
        if (existingMembership) {
          return { success: true, membership: existingMembership };
        }
        return { success: false, error: 'This invite has already been accepted' };
      }

      if (invite.status === 'expired' || new Date(invite.expires_at) < new Date()) {
        // Mark as expired if not already
        if (invite.status !== 'expired') {
          await supabaseAdmin
            .from('workspace_invites')
            .update({ status: 'expired' })
            .eq('id', inviteId);
        }
        return { success: false, error: 'This invite has expired' };
      }

      // Validate email match (case-insensitive)
      if (userEmail.toLowerCase() !== invite.email.toLowerCase()) {
        return {
          success: false,
          error: 'This invite was sent to a different email address',
        };
      }

      // Check if user is already a member
      const existingMembership = await WorkspaceAccessService.getMembership(
        userId,
        invite.workspace_id
      );
      if (existingMembership) {
        // Mark invite as accepted and return existing membership
        await supabaseAdmin
          .from('workspace_invites')
          .update({
            status: 'accepted',
            accepted_at: new Date().toISOString(),
            accepted_by_user_id: userId,
          })
          .eq('id', inviteId);

        return { success: true, membership: existingMembership };
      }

      // Create or reactivate membership (UPSERT handles re-invite after removal)
      const { data: membership, error: memberError } = await supabaseAdmin
        .from('workspace_members')
        .upsert(
          {
            workspace_id: invite.workspace_id,
            user_id: userId,
            role: invite.role,
            status: 'active',
            invited_by_user_id: invite.invited_by_user_id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'workspace_id,user_id' }
        )
        .select()
        .single();

      if (memberError) {
        logger.error('[WORKSPACE_MEMBERS] Error creating membership', {
          error: memberError.message,
          inviteId,
          userId,
        });
        return { success: false, error: 'Failed to accept invite' };
      }

      // Mark invite as accepted
      await supabaseAdmin
        .from('workspace_invites')
        .update({
          status: 'accepted',
          accepted_at: new Date().toISOString(),
          accepted_by_user_id: userId,
        })
        .eq('id', inviteId);

      // Log audit
      await WorkspaceAuditService.logInviteAccepted({
        workspaceId: invite.workspace_id,
        userId,
        inviteId,
        email: invite.email,
        role: invite.role,
        ...auditContext,
      });

      logger.info('[WORKSPACE_MEMBERS] Invite accepted', {
        inviteId,
        userId,
        workspaceId: invite.workspace_id,
        role: invite.role,
      });

      return { success: true, membership };
    } catch (error) {
      logger.error('[WORKSPACE_MEMBERS] Exception accepting invite', {
        error: error instanceof Error ? error.message : String(error),
        inviteId,
        userId,
      });
      return { success: false, error: 'Failed to accept invite' };
    }
  }
}
