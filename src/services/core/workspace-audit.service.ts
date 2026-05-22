import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { resolveWorkspaceForProject } from '@/services/core/workspace-access.service';
import type { Request } from 'express';

// ============================================================================
// AUDIT EVENT TYPES
// ============================================================================

export const AUDIT_EVENTS = {
  // Invite events
  INVITE_CREATED: 'invite.created',
  INVITE_RESENT: 'invite.resent',
  INVITE_REVOKED: 'invite.revoked',
  INVITE_ACCEPTED: 'invite.accepted',
  INVITE_EXPIRED: 'invite.expired',

  // Member events
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  MEMBER_REMOVED: 'member.removed',
  MEMBER_JOINED: 'member.joined',

  // Owner events
  OWNER_TRANSFERRED: 'owner.transferred',

  // Credits events
  CREDITS_USED: 'credits.used',
  CREDITS_PURCHASED: 'credits.purchased',
  CREDITS_MIGRATED: 'credits.migrated',

  // Test resource events (auth/env/secret/etc.)
  RESOURCE_CREATED: 'resource.created',
  RESOURCE_UPDATED: 'resource.updated',
  RESOURCE_DELETED: 'resource.deleted',
  RESOURCE_CAPTURED: 'resource.captured',
  RESOURCE_MARKED_BROKEN: 'resource.marked_broken',
  RESOURCE_SNAPSHOT_CAPTURED: 'resource.snapshot_captured',
  RESOURCE_SNAPSHOT_CLEARED: 'resource.snapshot_cleared',
  RESOURCE_DEFAULT_SET: 'resource.default_set',
  RESOURCE_DEFAULT_CLEARED: 'resource.default_cleared',

  // Test case events (intent_test_cases)
  TEST_CASE_CREATED: 'test_case.created',
  TEST_CASE_UPDATED: 'test_case.updated',
  TEST_CASE_DELETED: 'test_case.deleted',
  TEST_CASE_EXECUTED: 'test_case.executed',
  TEST_CASE_ASSIGNED_TO_FLOW: 'test_case.assigned_to_flow',
  TEST_CASE_DEPENDENCIES_UPDATED: 'test_case.dependencies_updated',

  // Module events
  MODULE_CREATED: 'module.created',
  MODULE_UPDATED: 'module.updated',
  MODULE_DELETED: 'module.deleted',

  // Manual test (live UI test) events
  MANUAL_TEST_STARTED: 'manual_test.started',
  MANUAL_TEST_CANCELLED: 'manual_test.cancelled',
  MANUAL_TEST_RETRIED: 'manual_test.retried',

  // Regression run events
  REGRESSION_RUN_STARTED: 'regression.run_started',
  REGRESSION_RUN_CANCELLED: 'regression.run_cancelled',

  // Regression plan events
  REGRESSION_PLAN_CREATED: 'regression_plan.created',
  REGRESSION_PLAN_UPDATED: 'regression_plan.updated',
  REGRESSION_PLAN_DELETED: 'regression_plan.deleted',
  REGRESSION_PLAN_ITEM_ADDED: 'regression_plan.item_added',
  REGRESSION_PLAN_ITEM_REMOVED: 'regression_plan.item_removed',

  // Jira ("tasks") events — actions we initiate against Jira
  JIRA_ISSUE_CREATED: 'jira.issue_created',
  JIRA_ISSUE_UPDATED: 'jira.issue_updated',
  JIRA_ISSUE_STATUS_CHANGED: 'jira.issue_status_changed',
  JIRA_DISCONNECTED: 'jira.disconnected',

  // Account-deletion lifecycle (Phase 1 / May 2026). Logged into the
  // workspace audit log of every workspace the user is/was a member of,
  // so the audit trail survives the user-row purge — workspace owners
  // can later see "X left / was hard-deleted" entries even after the
  // FK SET NULL on actor_user_id.
  ACCOUNT_DELETION_REQUESTED: 'account.deletion_requested',
  ACCOUNT_DELETION_CANCELLED: 'account.deletion_cancelled',
  ACCOUNT_DELETION_COMPLETED: 'account.deletion_completed',
  ACCOUNT_DELETION_FAILED: 'account.deletion_failed',
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

// ============================================================================
// AUDIT LOG ENTRY INTERFACE
// ============================================================================

export interface AuditLogEntry {
  id: string;
  workspace_id: string;
  actor_user_id: string | null;
  event_type: AuditEventType;
  target_type: string | null;
  target_id: string | null;
  success: boolean;
  metadata: Record<string, any>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface CreateAuditLogParams {
  workspaceId: string;
  actorUserId: string | null;
  eventType: AuditEventType;
  targetType?: string; // 'user', 'invite', 'project', etc.
  targetId?: string; // UUID or email
  success?: boolean;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

// ============================================================================
// WORKSPACE AUDIT SERVICE
// ============================================================================

/**
 * Extract IP + user-agent from an Express request for audit metadata.
 * Shared so every controller writes the same shape.
 */
export function getAuditContext(req: Request): { ipAddress?: string; userAgent?: string } {
  return {
    ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || undefined,
    userAgent: req.headers['user-agent'] || undefined,
  };
}

export class WorkspaceAuditService {
  /**
   * Resolve workspace_id from a project_id. Delegates to the shared cache in
   * workspace-access.service so audit and access checks share one source of
   * truth.
   */
  static async resolveWorkspaceFromProject(projectId: string): Promise<string | null> {
    return resolveWorkspaceForProject(projectId);
  }

  /**
   * Resolve a user's workspace for events that aren't naturally scoped by a
   * project (e.g. Jira issue actions). Picks the most recently joined active
   * workspace. If the user is a member of multiple, this is lossy by design —
   * the alternative is forcing every Jira request to carry workspaceId, which
   * we don't want until the Activity page becomes a hot codepath.
   */
  static async resolveWorkspaceForUser(userId: string): Promise<string | null> {
    if (!userId) return null;
    try {
      const { data, error } = await supabaseAdmin
        .from('workspace_members')
        .select('workspace_id, created_at')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        logger.warn('[WORKSPACE_AUDIT] Failed to resolve workspace for user', {
          userId,
          error: error.message,
        });
        return null;
      }
      return (data as any)?.workspace_id ?? null;
    } catch (error) {
      logger.warn('[WORKSPACE_AUDIT] Exception resolving workspace for user', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Convenience: log an event scoped by user (no project context). Resolves
   * workspace via `resolveWorkspaceForUser`. Use for actions like Jira issue
   * mutations that aren't tied to a single QAIT project.
   */
  static async logForUser(params: {
    actorUserId: string;
    eventType: AuditEventType;
    targetType?: string;
    targetId?: string;
    success?: boolean;
    metadata?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    const workspaceId = await this.resolveWorkspaceForUser(params.actorUserId);
    if (!workspaceId) return;
    await this.log({
      workspaceId,
      actorUserId: params.actorUserId,
      eventType: params.eventType,
      targetType: params.targetType,
      targetId: params.targetId,
      success: params.success,
      metadata: params.metadata,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Convenience: log an event scoped by project. Resolves workspace_id from
   * `projects.workspace_id`, then delegates to `log()`. Silent on resolution
   * miss — audit is best-effort and must never block the main flow.
   */
  static async logForProject(params: {
    projectId: string;
    actorUserId: string | null;
    eventType: AuditEventType;
    targetType?: string;
    targetId?: string;
    success?: boolean;
    metadata?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    const workspaceId = await this.resolveWorkspaceFromProject(params.projectId);
    if (!workspaceId) return;

    await this.log({
      workspaceId,
      actorUserId: params.actorUserId,
      eventType: params.eventType,
      targetType: params.targetType,
      targetId: params.targetId,
      success: params.success,
      metadata: { ...(params.metadata ?? {}), project_id: params.projectId },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Write an audit log entry
   */
  static async log(params: CreateAuditLogParams): Promise<void> {
    try {
      const {
        workspaceId,
        actorUserId,
        eventType,
        targetType,
        targetId,
        success = true,
        metadata = {},
        ipAddress,
        userAgent,
      } = params;

      if (!workspaceId || !eventType) {
        logger.warn('[WORKSPACE_AUDIT] Missing required fields for audit log', {
          workspaceId,
          eventType,
        });
        return;
      }

      const { error } = await supabaseAdmin.from('workspace_audit_log').insert({
        workspace_id: workspaceId,
        actor_user_id: actorUserId ?? null,
        event_type: eventType,
        target_type: targetType || null,
        target_id: targetId || null,
        success,
        metadata,
        ip_address: ipAddress || null,
        user_agent: userAgent || null,
      });

      if (error) {
        // Don't throw - audit logging should not break the main flow
        logger.error('[WORKSPACE_AUDIT] Failed to write audit log', {
          error: error.message,
          workspaceId,
          eventType,
        });
      } else {
        logger.debug('[WORKSPACE_AUDIT] Audit log written', {
          workspaceId,
          eventType,
          targetType,
          targetId,
        });
      }
    } catch (error) {
      // Never throw from audit logging
      logger.error('[WORKSPACE_AUDIT] Exception writing audit log', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId: params.workspaceId,
        eventType: params.eventType,
      });
    }
  }

  /**
   * Log invite created
   */
  static async logInviteCreated(params: {
    workspaceId: string;
    actorUserId: string;
    inviteId: string;
    email: string;
    role: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.log({
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
      eventType: AUDIT_EVENTS.INVITE_CREATED,
      targetType: 'invite',
      targetId: params.email,
      metadata: {
        invite_id: params.inviteId,
        role: params.role,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Log invite accepted
   */
  static async logInviteAccepted(params: {
    workspaceId: string;
    userId: string;
    inviteId: string;
    email: string;
    role: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.log({
      workspaceId: params.workspaceId,
      actorUserId: params.userId,
      eventType: AUDIT_EVENTS.INVITE_ACCEPTED,
      targetType: 'invite',
      targetId: params.inviteId,
      metadata: {
        email: params.email,
        role: params.role,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Log invite revoked
   */
  static async logInviteRevoked(params: {
    workspaceId: string;
    actorUserId: string;
    inviteId: string;
    email: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.log({
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
      eventType: AUDIT_EVENTS.INVITE_REVOKED,
      targetType: 'invite',
      targetId: params.inviteId,
      metadata: {
        email: params.email,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Log invite resent
   */
  static async logInviteResent(params: {
    workspaceId: string;
    actorUserId: string;
    inviteId: string;
    email: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.log({
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
      eventType: AUDIT_EVENTS.INVITE_RESENT,
      targetType: 'invite',
      targetId: params.inviteId,
      metadata: {
        email: params.email,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Log member removed
   */
  static async logMemberRemoved(params: {
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    previousRole: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.log({
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
      eventType: AUDIT_EVENTS.MEMBER_REMOVED,
      targetType: 'user',
      targetId: params.targetUserId,
      metadata: {
        previous_role: params.previousRole,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Log member role changed
   */
  static async logMemberRoleChanged(params: {
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    oldRole: string;
    newRole: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.log({
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
      eventType: AUDIT_EVENTS.MEMBER_ROLE_CHANGED,
      targetType: 'user',
      targetId: params.targetUserId,
      metadata: {
        old_role: params.oldRole,
        new_role: params.newRole,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Log owner transferred
   */
  static async logOwnerTransferred(params: {
    workspaceId: string;
    fromUserId: string;
    toUserId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.log({
      workspaceId: params.workspaceId,
      actorUserId: params.fromUserId,
      eventType: AUDIT_EVENTS.OWNER_TRANSFERRED,
      targetType: 'user',
      targetId: params.toUserId,
      metadata: {
        from_user_id: params.fromUserId,
        to_user_id: params.toUserId,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Log credits used
   */
  static async logCreditsUsed(params: {
    workspaceId: string;
    userId: string;
    amount: number;
    balanceAfter: number;
    description: string;
    testType?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.log({
      workspaceId: params.workspaceId,
      actorUserId: params.userId,
      eventType: AUDIT_EVENTS.CREDITS_USED,
      targetType: 'credits',
      metadata: {
        amount: params.amount,
        balance_after: params.balanceAfter,
        description: params.description,
        test_type: params.testType,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  /**
   * Get audit logs for a workspace
   */
  static async getAuditLogs(
    workspaceId: string,
    options: {
      limit?: number;
      offset?: number;
      eventTypes?: AuditEventType[];
    } = {}
  ): Promise<AuditLogEntry[]> {
    try {
      const { limit = 100, offset = 0, eventTypes } = options;

      let query = supabaseAdmin
        .from('workspace_audit_log')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (eventTypes && eventTypes.length > 0) {
        query = query.in('event_type', eventTypes);
      }

      const { data, error } = await query;

      if (error) {
        logger.error('[WORKSPACE_AUDIT] Error getting audit logs', {
          error: error.message,
          workspaceId,
        });
        return [];
      }

      return (data || []) as AuditLogEntry[];
    } catch (error) {
      logger.error('[WORKSPACE_AUDIT] Exception getting audit logs', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return [];
    }
  }

  /**
   * Paginated audit log query enriched with actor name/email.
   * Response shape matches what the Activity settings UI expects:
   *   { entries, total, page, total_pages }
   */
  static async getAuditLogsPaginated(
    workspaceId: string,
    options: {
      page?: number;
      limit?: number;
      eventTypes?: AuditEventType[];
    } = {}
  ): Promise<{
    entries: Array<AuditLogEntry & {
      actor_name: string | null;
      actor_email: string | null;
      action: AuditEventType;
      timestamp: string;
    }>;
    total: number;
    page: number;
    total_pages: number;
  }> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const offset = (page - 1) * limit;
    const { eventTypes } = options;

    try {
      let query = supabaseAdmin
        .from('workspace_audit_log')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (eventTypes && eventTypes.length > 0) {
        query = query.in('event_type', eventTypes);
      }

      const { data, error, count } = await query;

      if (error) {
        logger.error('[WORKSPACE_AUDIT] Error getting paginated audit logs', {
          error: error.message,
          workspaceId,
        });
        return { entries: [], total: 0, page, total_pages: 0 };
      }

      const rows = (data || []) as AuditLogEntry[];
      const actorIds = Array.from(
        new Set(rows.map((r) => r.actor_user_id).filter((id): id is string => !!id))
      );

      const actorsById = new Map<string, { email: string | null; name: string | null }>();
      if (actorIds.length > 0) {
        const { data: users, error: usersError } = await supabaseAdmin
          .from('users')
          .select('id, email, name')
          .in('id', actorIds);

        if (usersError) {
          logger.warn('[WORKSPACE_AUDIT] Failed to enrich actors', {
            error: usersError.message,
            workspaceId,
          });
        } else {
          for (const u of users || []) {
            actorsById.set(u.id, { email: u.email ?? null, name: u.name ?? null });
          }
        }
      }

      const entries = rows.map((row) => {
        const actor = row.actor_user_id ? actorsById.get(row.actor_user_id) : null;
        return {
          ...row,
          action: row.event_type,
          timestamp: row.created_at,
          actor_name: actor?.name ?? null,
          actor_email: actor?.email ?? null,
        };
      });

      const total = count ?? 0;
      const total_pages = total > 0 ? Math.ceil(total / limit) : 0;

      return { entries, total, page, total_pages };
    } catch (error) {
      logger.error('[WORKSPACE_AUDIT] Exception getting paginated audit logs', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return { entries: [], total: 0, page, total_pages: 0 };
    }
  }
}
