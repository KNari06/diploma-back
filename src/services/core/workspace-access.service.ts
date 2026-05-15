import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

// ============================================================================
// PERMISSION CONSTANTS
// ============================================================================
// These are the atomic permissions that can be checked.
// Roles are mapped to sets of permissions below.

export const PERMISSIONS = {
  // Workspace-level
  WORKSPACE_READ: 'workspace:read',
  WORKSPACE_WRITE: 'workspace:write',
  WORKSPACE_DELETE: 'workspace:delete',

  // Member management
  MEMBER_VIEW: 'member:view',
  MEMBER_MANAGE: 'member:manage', // invite, change role, remove

  // Billing/credits
  BILLING_VIEW: 'billing:view',
  BILLING_MANAGE: 'billing:manage',

  // Projects
  PROJECT_READ: 'project:read',
  PROJECT_WRITE: 'project:write',
  PROJECT_DELETE: 'project:delete',

  // Tests
  TEST_READ: 'test:read',
  TEST_WRITE: 'test:write',
  TEST_DELETE: 'test:delete',

  // Owner transfer (special)
  OWNER_TRANSFER: 'owner:transfer',

  // Audit log
  AUDIT_VIEW: 'audit:view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// ============================================================================
// ROLE DEFINITIONS
// ============================================================================

export type WorkspaceRole = 'owner' | 'full_access' | 'view';

// ============================================================================
// ROLE → PERMISSIONS MAPPING
// ============================================================================
// This is the single source of truth for what each role can do.
// Easy to extend with new roles or permissions later.

const ROLE_PERMISSIONS: Record<WorkspaceRole, Set<Permission>> = {
  owner: new Set([
    // Owner has everything
    PERMISSIONS.WORKSPACE_READ,
    PERMISSIONS.WORKSPACE_WRITE,
    PERMISSIONS.WORKSPACE_DELETE,
    PERMISSIONS.MEMBER_VIEW,
    PERMISSIONS.MEMBER_MANAGE,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.BILLING_MANAGE,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.PROJECT_WRITE,
    PERMISSIONS.PROJECT_DELETE,
    PERMISSIONS.TEST_READ,
    PERMISSIONS.TEST_WRITE,
    PERMISSIONS.TEST_DELETE,
    PERMISSIONS.OWNER_TRANSFER,
    PERMISSIONS.AUDIT_VIEW,
  ]),

  full_access: new Set([
    // Full access: all product features, no billing/member management
    PERMISSIONS.WORKSPACE_READ,
    PERMISSIONS.WORKSPACE_WRITE, // can update workspace settings
    PERMISSIONS.MEMBER_VIEW, // can see who is in the org
    PERMISSIONS.BILLING_VIEW, // can see credits balance
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.PROJECT_WRITE,
    PERMISSIONS.PROJECT_DELETE,
    PERMISSIONS.TEST_READ,
    PERMISSIONS.TEST_WRITE,
    PERMISSIONS.TEST_DELETE,
  ]),

  view: new Set([
    // View: read-only
    PERMISSIONS.WORKSPACE_READ,
    PERMISSIONS.MEMBER_VIEW,
    PERMISSIONS.BILLING_VIEW, // can see credits (optional: remove if too restrictive)
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.TEST_READ,
  ]),
};

// ============================================================================
// HELPER: Check if role has permission
// ============================================================================

export function roleHasPermission(role: WorkspaceRole, permission: Permission): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  if (!permissions) {
    return false;
  }
  return permissions.has(permission);
}

// ============================================================================
// WORKSPACE MEMBERSHIP INTERFACE
// ============================================================================

export interface WorkspaceMembership {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  status: 'active' | 'removed';
  invited_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// PROJECT → WORKSPACE RESOLUTION (cached)
// ============================================================================
// Used by WorkspaceAuditService to scope audit rows to a workspace when the
// caller only carries a projectId. `projects.workspace_id` is effectively
// immutable (project.controller.ts blocks updates that change it), so a
// process-local map is safe. Exported for ProjectService to invalidate if
// that invariant ever changes.

const projectWorkspaceCache = new Map<string, string>();

export async function resolveWorkspaceForProject(projectId: string): Promise<string | null> {
  if (!projectId) return null;

  const cached = projectWorkspaceCache.get(projectId);
  if (cached) return cached;

  try {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('workspace_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error) {
      logger.warn('[WORKSPACE_ACCESS] Failed to resolve workspace for project', {
        projectId,
        error: error.message,
      });
      return null;
    }

    const workspaceId = (data as any)?.workspace_id as string | undefined;
    if (workspaceId) {
      projectWorkspaceCache.set(projectId, workspaceId);
      return workspaceId;
    }
    return null;
  } catch (error) {
    logger.warn('[WORKSPACE_ACCESS] Exception resolving workspace for project', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function invalidateProjectWorkspaceCache(projectId?: string): void {
  if (projectId) {
    projectWorkspaceCache.delete(projectId);
  } else {
    projectWorkspaceCache.clear();
  }
}

// ============================================================================
// WORKSPACE ACCESS SERVICE
// ============================================================================

export class WorkspaceAccessService {
  /**
   * Get user's active membership in a workspace
   * Returns null if user is not an active member
   */
  static async getMembership(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceMembership | null> {
    try {
      if (!userId || !workspaceId) {
        return null;
      }

      const { data, error } = await supabaseAdmin
        .from('workspace_members')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle();

      if (error) {
        logger.error('[WORKSPACE_ACCESS] Error getting membership', {
          error: error.message,
          userId,
          workspaceId,
        });
        return null;
      }

      return data as WorkspaceMembership | null;
    } catch (error) {
      logger.error('[WORKSPACE_ACCESS] Exception in getMembership', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        workspaceId,
      });
      return null;
    }
  }

  /**
   * Get user's role in a workspace
   * Returns null if user is not an active member
   */
  static async getRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const membership = await this.getMembership(userId, workspaceId);
    return membership?.role ?? null;
  }

  /**
   * Check if user is an active member of workspace
   */
  static async isMember(userId: string, workspaceId: string): Promise<boolean> {
    const membership = await this.getMembership(userId, workspaceId);
    return membership !== null && membership.status === 'active';
  }

  /**
   * Check if user has a specific permission in workspace
   */
  static async hasPermission(
    userId: string,
    workspaceId: string,
    permission: Permission
  ): Promise<boolean> {
    const role = await this.getRole(userId, workspaceId);
    if (!role) {
      return false;
    }
    return roleHasPermission(role, permission);
  }

  /**
   * Require a specific permission - throws if not allowed
   */
  static async requirePermission(
    userId: string,
    workspaceId: string,
    permission: Permission
  ): Promise<WorkspaceMembership> {
    const membership = await this.getMembership(userId, workspaceId);

    if (!membership) {
      throw new AccessDeniedError('Not a member of this workspace');
    }

    if (!roleHasPermission(membership.role, permission)) {
      throw new AccessDeniedError(
        `Permission '${permission}' requires higher access level. Current role: ${membership.role}`
      );
    }

    return membership;
  }

  /**
   * Require membership (any role) - throws if not member
   */
  static async requireMembership(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceMembership> {
    const membership = await this.getMembership(userId, workspaceId);

    if (!membership) {
      throw new AccessDeniedError('Not a member of this workspace');
    }

    return membership;
  }

  /**
   * Require owner role - throws if not owner
   */
  static async requireOwner(userId: string, workspaceId: string): Promise<WorkspaceMembership> {
    const membership = await this.getMembership(userId, workspaceId);

    if (!membership) {
      throw new AccessDeniedError('Not a member of this workspace');
    }

    if (membership.role !== 'owner') {
      throw new AccessDeniedError('Owner access required');
    }

    return membership;
  }

  /**
   * Get all workspaces the user is a member of (with role)
   */
  static async getUserWorkspaces(
    userId: string
  ): Promise<Array<{ workspace_id: string; role: WorkspaceRole }>> {
    try {
      if (!userId) {
        return [];
      }

      const { data, error } = await supabaseAdmin
        .from('workspace_members')
        .select('workspace_id, role')
        .eq('user_id', userId)
        .eq('status', 'active');

      if (error) {
        logger.error('[WORKSPACE_ACCESS] Error getting user workspaces', {
          error: error.message,
          userId,
        });
        return [];
      }

      return (data || []) as Array<{ workspace_id: string; role: WorkspaceRole }>;
    } catch (error) {
      logger.error('[WORKSPACE_ACCESS] Exception in getUserWorkspaces', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      return [];
    }
  }

  /**
   * Get all members of a workspace
   */
  static async getWorkspaceMembers(workspaceId: string): Promise<WorkspaceMembership[]> {
    try {
      if (!workspaceId) {
        return [];
      }

      const { data, error } = await supabaseAdmin
        .from('workspace_members')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('status', 'active')
        .order('created_at', { ascending: true });

      if (error) {
        logger.error('[WORKSPACE_ACCESS] Error getting workspace members', {
          error: error.message,
          workspaceId,
        });
        return [];
      }

      return (data || []) as WorkspaceMembership[];
    } catch (error) {
      logger.error('[WORKSPACE_ACCESS] Exception in getWorkspaceMembers', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return [];
    }
  }

  /**
   * Check if workspace has exactly one owner (invariant check)
   */
  static async hasExactlyOneOwner(workspaceId: string): Promise<boolean> {
    try {
      const { count, error } = await supabaseAdmin
        .from('workspace_members')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('role', 'owner')
        .eq('status', 'active');

      if (error) {
        logger.error('[WORKSPACE_ACCESS] Error checking owner count', {
          error: error.message,
          workspaceId,
        });
        return false;
      }

      return count === 1;
    } catch (error) {
      logger.error('[WORKSPACE_ACCESS] Exception in hasExactlyOneOwner', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return false;
    }
  }

  /**
   * Get the owner of a workspace
   */
  static async getOwner(workspaceId: string): Promise<WorkspaceMembership | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspace_members')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('role', 'owner')
        .eq('status', 'active')
        .maybeSingle();

      if (error) {
        logger.error('[WORKSPACE_ACCESS] Error getting owner', {
          error: error.message,
          workspaceId,
        });
        return null;
      }

      return data as WorkspaceMembership | null;
    } catch (error) {
      logger.error('[WORKSPACE_ACCESS] Exception in getOwner', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return null;
    }
  }
}

// ============================================================================
// CUSTOM ERROR CLASS
// ============================================================================

export class AccessDeniedError extends Error {
  public readonly code = 'ACCESS_DENIED';
  public readonly statusCode = 403;

  constructor(message: string = 'Access denied') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}
