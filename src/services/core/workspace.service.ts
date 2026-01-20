import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

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

      // 1) Latest chat session workspace
      const { data: chatSession, error: chatSessionError } = await supabaseAdmin
        .from('chat_sessions')
        .select('workspace_id, updated_at, created_at')
        .eq('user_id', userId)
        .not('workspace_id', 'is', null)
        .order('updated_at', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1);

      if (chatSessionError) {
        logger.warn('[WORKSPACE] Failed to resolve active workspace from chat_sessions', {
          userId,
          code: (chatSessionError as any)?.code,
          message: (chatSessionError as any)?.message,
          details: (chatSessionError as any)?.details,
        });
      } else if (Array.isArray(chatSession) && chatSession[0]?.workspace_id) {
        return String(chatSession[0].workspace_id);
      }

      // 2) Latest project workspace
      const { data: project, error: projectError } = await supabaseAdmin
        .from('projects')
        .select('workspace_id, updated_at, created_at')
        .eq('user_id', userId)
        .not('workspace_id', 'is', null)
        .order('updated_at', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1);

      if (projectError) {
        logger.warn('[WORKSPACE] Failed to resolve active workspace from projects', {
          userId,
          code: (projectError as any)?.code,
          message: (projectError as any)?.message,
          details: (projectError as any)?.details,
        });
      } else if (Array.isArray(project) && project[0]?.workspace_id) {
        return String(project[0].workspace_id);
      }

      // 3) Fallback to oldest workspace
      const { data: workspace, error: workspaceError } = await supabaseAdmin
        .from('workspaces')
        .select('id, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(1);

      if (workspaceError) {
        logger.warn('[WORKSPACE] Failed to resolve fallback workspace', {
          userId,
          code: (workspaceError as any)?.code,
          message: (workspaceError as any)?.message,
          details: (workspaceError as any)?.details,
        });
        return null;
      }

      if (Array.isArray(workspace) && workspace[0]?.id) {
        return String(workspace[0].id);
      }

      return null;
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
