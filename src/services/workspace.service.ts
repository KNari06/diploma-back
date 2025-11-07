import { supabaseAdmin } from '@/db/supabase';
import { Workspace, WorkspaceCreateRequest } from '@/types';
import { logger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Service for managing workspaces
 */
export class WorkspaceService {
  /**
   * Create a new workspace
   */
  static async createWorkspace(
    userId: string,
    workspaceData: WorkspaceCreateRequest
  ): Promise<Workspace> {
    try {
      // Validate required fields
      if (!workspaceData.name || !workspaceData.platforms || !workspaceData.devBaseUrl) {
        throw new Error('Missing required fields: name, platforms, devBaseUrl');
      }

      // Validate platforms array
      if (!Array.isArray(workspaceData.platforms) || workspaceData.platforms.length === 0) {
        throw new Error('platforms must be a non-empty array');
      }

      const workspaceRecord = {
        id: uuidv4(),
        name: workspaceData.name,
        user_id: userId,
        platforms: workspaceData.platforms,
        api_testing: workspaceData.api_testing || false,
        dev_base_url: workspaceData.devBaseUrl,
        prod_base_url: workspaceData.prodBaseUrl || null,
        settings: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .insert(workspaceRecord)
        .select()
        .single();

      if (error) {
        logger.error('[WORKSPACE] Error creating workspace', { error, userId, workspaceData });
        throw error;
      }

      logger.info('[WORKSPACE] Workspace created successfully', {
        workspaceId: data.id,
        userId,
        name: workspaceData.name,
      });

      return this.mapToWorkspace(data);
    } catch (error) {
      logger.error('[WORKSPACE] Exception in createWorkspace', { error, userId, workspaceData });
      throw error;
    }
  }

  /**
   * Get workspace by ID
   */
  static async getWorkspace(workspaceId: string, userId: string): Promise<Workspace | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .select('*')
        .eq('id', workspaceId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        logger.error('[WORKSPACE] Error getting workspace', { error, workspaceId, userId });
        return null;
      }

      if (!data) {
        return null;
      }

      return this.mapToWorkspace(data);
    } catch (error) {
      logger.error('[WORKSPACE] Exception in getWorkspace', { error, workspaceId, userId });
      return null;
    }
  }

  /**
   * Get all workspaces for a user
   */
  static async getUserWorkspaces(userId: string): Promise<Workspace[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        logger.error('[WORKSPACE] Error getting user workspaces', { error, userId });
        return [];
      }

      return (data || []).map((w) => this.mapToWorkspace(w));
    } catch (error) {
      logger.error('[WORKSPACE] Exception in getUserWorkspaces', { error, userId });
      return [];
    }
  }

  /**
   * Get or create default workspace for user
   * Ensures user always has at least one workspace
   */
  static async getOrCreateDefaultWorkspace(userId: string): Promise<Workspace> {
    try {
      // Check if workspaces table exists
      const { error: tableError } = await supabaseAdmin
        .from('workspaces')
        .select('id')
        .limit(1)
        .maybeSingle();

      // If table doesn't exist, throw a clear error
      if (tableError && tableError.code === '42P01') {
        logger.error('[WORKSPACE] Workspaces table does not exist. Please run migration first.', { userId });
        throw new Error('Workspaces table does not exist. Please apply workspaces.sql migration first.');
      }

      // Try to get existing workspaces
      const workspaces = await this.getUserWorkspaces(userId);

      if (workspaces.length > 0) {
        // Return the first workspace (or most recent)
        return workspaces[0];
      }

      // Create default workspace
      logger.info('[WORKSPACE] Creating default workspace for user', { userId });

      return await this.createWorkspace(userId, {
        name: 'Default Workspace',
        platforms: ['web(chrome, safari, firefox)'],
        api_testing: false,
        devBaseUrl: 'http://localhost:3000',
      });
    } catch (error) {
      logger.error('[WORKSPACE] Exception in getOrCreateDefaultWorkspace', { error, userId });
      throw error;
    }
  }

  /**
   * Update workspace
   */
  static async updateWorkspace(
    workspaceId: string,
    userId: string,
    updates: Partial<WorkspaceCreateRequest>
  ): Promise<Workspace | null> {
    try {
      const updateData: any = {
        updated_at: new Date().toISOString(),
      };

      if (updates.name) updateData.name = updates.name;
      if (updates.platforms) updateData.platforms = updates.platforms;
      if (updates.api_testing !== undefined) updateData.api_testing = updates.api_testing;
      if (updates.devBaseUrl) updateData.dev_base_url = updates.devBaseUrl;
      if (updates.prodBaseUrl !== undefined) updateData.prod_base_url = updates.prodBaseUrl || null;

      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .update(updateData)
        .eq('id', workspaceId)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        logger.error('[WORKSPACE] Error updating workspace', { error, workspaceId, userId });
        return null;
      }

      if (!data) {
        return null;
      }

      logger.info('[WORKSPACE] Workspace updated successfully', { workspaceId, userId });

      return this.mapToWorkspace(data);
    } catch (error) {
      logger.error('[WORKSPACE] Exception in updateWorkspace', { error, workspaceId, userId });
      return null;
    }
  }

  /**
   * Delete workspace
   */
  static async deleteWorkspace(workspaceId: string, userId: string): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from('workspaces')
        .delete()
        .eq('id', workspaceId)
        .eq('user_id', userId);

      if (error) {
        logger.error('[WORKSPACE] Error deleting workspace', { error, workspaceId, userId });
        return false;
      }

      logger.info('[WORKSPACE] Workspace deleted successfully', { workspaceId, userId });

      return true;
    } catch (error) {
      logger.error('[WORKSPACE] Exception in deleteWorkspace', { error, workspaceId, userId });
      return false;
    }
  }

  /**
   * Map database record to Workspace type
   */
  private static mapToWorkspace(data: any): Workspace {
    return {
      id: data.id,
      name: data.name,
      userId: data.user_id,
      platforms: data.platforms || [],
      apiTesting: data.api_testing || false,
      devBaseUrl: data.dev_base_url,
      prodBaseUrl: data.prod_base_url,
      settings: data.settings || {},
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
    };
  }
}
