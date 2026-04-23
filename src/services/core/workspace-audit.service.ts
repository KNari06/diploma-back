import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

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

  // Resource events (optional but recommended)
  RESOURCE_CREATED: 'resource.created',
  RESOURCE_UPDATED: 'resource.updated',
  RESOURCE_DELETED: 'resource.deleted',
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

export class WorkspaceAuditService {
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
        actor_user_id: actorUserId,
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
