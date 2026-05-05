import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';

/**
 * Workspace Service
 * Manages user workspaces (parent container for all projects/tests)
 */
export class WorkspaceService {
  /**
   * Resolve "active workspace" for a user.
   *
   * Priority:
   * 1) Latest chat session workspace (most recent activity)
   * 2) Latest project workspace
   * 3) Oldest workspace (fallback if user has workspaces but no activity)
   */
  static async getActiveWorkspaceForUser(userId: string): Promise<string | null> {
    try {
      if (!userId || typeof userId !== 'string') {
        return null;
      }

      // 1) Get workspaces user is a member of (workspace membership model)
      const { data: memberships, error: membershipError } = await supabaseAdmin
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', userId)
        .eq('status', 'active');

      if (membershipError) {
        logger.warn('[WORKSPACE] Failed to resolve workspaces from membership', {
          userId,
          code: (membershipError as any)?.code,
          message: (membershipError as any)?.message,
        });
        return null;
      }

      if (!memberships || memberships.length === 0) {
        // Fallback: check if user owns a workspace directly (owner who may not have membership row)
        const { data: ownedWorkspace } = await supabaseAdmin
          .from('workspaces')
          .select('id')
          .eq('user_id', userId)
          .order('created_at', { ascending: true })
          .limit(1);

        if (Array.isArray(ownedWorkspace) && ownedWorkspace[0]?.id) {
          return String(ownedWorkspace[0].id);
        }
        return null;
      }

      // If only one workspace, return it directly
      if (memberships.length === 1) {
        return String(memberships[0].workspace_id);
      }

      // Multiple workspaces — pick the one with most recent chat activity for THIS user
      const workspaceIds = memberships.map(m => m.workspace_id);
      const { data: recentSession } = await supabaseAdmin
        .from('chat_sessions')
        .select('workspace_id, updated_at')
        .eq('user_id', userId)
        .in('workspace_id', workspaceIds)
        .not('workspace_id', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (Array.isArray(recentSession) && recentSession[0]?.workspace_id) {
        return String(recentSession[0].workspace_id);
      }

      // Fallback: return first workspace from membership
      return String(memberships[0].workspace_id);
    } catch (error) {
      logger.error('[WORKSPACE] Exception resolving active workspace', { error, userId });
      return null;
    }
  }

  /**
   * Create a workspace for a user.
   */
  static async createWorkspaceForUser(
    userId: string
  ): Promise<{
    workspace_id: string;
  }> {
    logger.info('[WORKSPACE] Creating new workspace for user', { userId });

    const workspaceName = this.generateWorkspaceName();

    const { data: newWorkspace, error: insertError } = await supabaseAdmin
      .from('workspaces')
      .insert({
        name: workspaceName,
        user_id: userId,
        platforms: [],
        api_testing: true,
        settings: {
          created_from_chat: true,
          created_at: new Date().toISOString(),
        },
      })
      .select('id, name')
      .single();

    if (insertError) {
      logger.error('[WORKSPACE] Error creating workspace', {
        error: insertError,
        userId,
      });
      throw insertError;
    }

    logger.info('[WORKSPACE] Created new workspace', {
      workspace_id: newWorkspace.id,
      name: newWorkspace.name,
    });

    // Invalidate onboarding cache — workspace creation changes onboarding state
    await cache.del(`qait:cache:onboarding:${userId}`);

    return { workspace_id: newWorkspace.id };
  }

  /**
   * Check if user has a workspace, create if not
   * Every user MUST have a workspace
   */
  static async checkOrCreateWorkspace(
    userId: string
  ): Promise<{
    workspace_id: string;
    is_new: boolean;
  }> {
    try {
      logger.info('[WORKSPACE] Checking workspace for user', { userId });

      // Multi-workspace: resolve active workspace (do NOT use maybeSingle by user_id)
      const activeWorkspaceId = await this.getActiveWorkspaceForUser(userId);

      if (activeWorkspaceId) {
        logger.info('[WORKSPACE] Resolved active workspace', {
          workspace_id: activeWorkspaceId,
        });
        return {
          workspace_id: activeWorkspaceId,
          is_new: false,
        };
      }

      // No active workspace found -> create one
      const { workspace_id } = await this.createWorkspaceForUser(userId);

      return {
        workspace_id,
        is_new: true,
      };
    } catch (error) {
      logger.error('[WORKSPACE] Failed to check/create workspace', {
        error,
        userId,
      });
      throw error;
    }
  }

  /**
   * Get workspace by user ID
   */
  static async getWorkspaceByUserId(userId: string): Promise<string | null> {
    try {
      // Multi-workspace: return active workspace
      return await this.getActiveWorkspaceForUser(userId);
    } catch (error) {
      logger.error('[WORKSPACE] Failed to get workspace', { error, userId });
      return null;
    }
  }

  /**
   * Create workspace with custom name
   */
  static async createWorkspace(
    userId: string,
    name: string
  ): Promise<string> {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .insert({
          name,
          user_id: userId,
          platforms: [],
          api_testing: true,
        })
        .select('id')
        .single();

      if (error) {
        logger.error('[WORKSPACE] Error creating workspace', { error, userId, name });
        throw error;
      }

      // Invalidate onboarding cache — workspace creation changes onboarding state
      await cache.del(`qait:cache:onboarding:${userId}`);

      return data.id;
    } catch (error) {
      logger.error('[WORKSPACE] Failed to create workspace', { error, userId, name });
      throw error;
    }
  }

  /**
   * Generate workspace name - default to "Untitled"
   * Note: Can be extended in future to generate unique names per user if needed
   */
  private static generateWorkspaceName(): string {
    return 'Untitled';
  }

  /**
   * Update workspace settings
   */
  static async updateWorkspaceSettings(
    workspaceId: string,
    settings: Record<string, any>
  ): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from('workspaces')
        .update({ settings })
        .eq('id', workspaceId);

      if (error) {
        logger.error('[WORKSPACE] Error updating settings', {
          error,
          workspaceId,
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.error('[WORKSPACE] Failed to update settings', {
        error,
        workspaceId,
      });
      return false;
    }
  }

  /**
   * Legacy/Compatibility methods for workspace.controller.ts
   */

  static async getOrCreateDefaultWorkspace(userId: string): Promise<{ workspace_id: string; is_new: boolean }> {
    return this.checkOrCreateWorkspace(userId);
  }

  static async getUserWorkspaces(userId: string): Promise<any[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .select('*')
        .eq('user_id', userId);

      if (error) {
        logger.error('[WORKSPACE] Error getting user workspaces', { error, userId });
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('[WORKSPACE] Failed to get user workspaces', { error, userId });
      throw error;
    }
  }

  static async getWorkspace(workspaceId: string): Promise<any> {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .select('*')
        .eq('id', workspaceId)
        .maybeSingle();

      if (error) {
        logger.error('[WORKSPACE] Error getting workspace', { error, workspaceId });
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('[WORKSPACE] Failed to get workspace', { error, workspaceId });
      throw error;
    }
  }

  /** Columns that may be updated via the public API. */
  private static readonly UPDATABLE_COLUMNS = new Set([
    'name',
    'platforms',
    'api_testing',
    'settings',
    // dev_base_url / prod_base_url are top-level columns kept for backward
    // compatibility with `settings.baseUrls`. They were previously dropped
    // here, so updates from the public API silently no-op'd while
    // `settings.baseUrls` got rewritten — leaving the two views of "the
    // workspace's URLs" out of sync. Whitelisting them lets the controller
    // keep both halves consistent in a single round-trip.
    'dev_base_url',
    'prod_base_url',
  ]);

  /**
   * Map of camelCase request keys → snake_case DB columns. Lets callers send
   * `{ devBaseUrl, prodBaseUrl }` (consistent with the auth/onboarding API
   * shape) without us silently dropping them as unknown columns.
   */
  private static readonly COLUMN_ALIASES: Record<string, string> = {
    devBaseUrl: 'dev_base_url',
    prodBaseUrl: 'prod_base_url',
    apiTesting: 'api_testing',
  };

  static async updateWorkspace(workspaceId: string, updates: any): Promise<any> {
    try {
      // Only keep fields that map to actual DB columns to prevent
      // Supabase "column not found" errors (e.g. frontend sending `description`).
      const sanitised: Record<string, any> = {};
      for (const key of Object.keys(updates)) {
        const dbKey = WorkspaceService.COLUMN_ALIASES[key] ?? key;
        if (WorkspaceService.UPDATABLE_COLUMNS.has(dbKey)) {
          sanitised[dbKey] = updates[key];
        }
      }

      if (Object.keys(sanitised).length === 0) {
        logger.warn('[WORKSPACE] No valid columns to update, skipping', { workspaceId, receivedKeys: Object.keys(updates) });
        return await this.getWorkspace(workspaceId);
      }

      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .update(sanitised)
        .eq('id', workspaceId)
        .select()
        .single();

      if (error) {
        logger.error('[WORKSPACE] Error updating workspace', { error, workspaceId });
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('[WORKSPACE] Failed to update workspace', { error, workspaceId });
      throw error;
    }
  }

  static async deleteWorkspace(workspaceId: string): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('workspaces')
        .delete()
        .eq('id', workspaceId);

      if (error) {
        logger.error('[WORKSPACE] Error deleting workspace', { error, workspaceId });
        throw error;
      }
    } catch (error) {
      logger.error('[WORKSPACE] Failed to delete workspace', { error, workspaceId });
      throw error;
    }
  }
}
