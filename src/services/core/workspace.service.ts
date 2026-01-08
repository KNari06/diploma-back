import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * Workspace Service
 * Manages user workspaces (parent container for all projects/tests)
 */
export class WorkspaceService {
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

      // 1. Check if workspace exists
      const { data: existing, error: selectError } = await supabaseAdmin
        .from('workspaces')
        .select('id, name')
        .eq('user_id', userId)
        .maybeSingle();

      if (selectError) {
        logger.error('[WORKSPACE] Error checking workspace', {
          error: selectError,
          userId,
        });
        throw selectError;
      }

      if (existing) {
        logger.info('[WORKSPACE] Found existing workspace', {
          workspace_id: existing.id,
          name: existing.name,
        });
        return {
          workspace_id: existing.id,
          is_new: false,
        };
      }

      // 2. Create new workspace
      logger.info('[WORKSPACE] Creating new workspace for user', { userId });

      const workspaceName = this.generateWorkspaceName(userId);

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

      return {
        workspace_id: newWorkspace.id,
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
      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        logger.error('[WORKSPACE] Error getting workspace', { error, userId });
        return null;
      }

      return data?.id || null;
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

      return data.id;
    } catch (error) {
      logger.error('[WORKSPACE] Failed to create workspace', { error, userId, name });
      throw error;
    }
  }

  /**
   * Generate workspace name - default to "Untitled"
   */
  private static generateWorkspaceName(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _userId: string
  ): string {
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

  static async updateWorkspace(workspaceId: string, updates: any): Promise<any> {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .update(updates)
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
