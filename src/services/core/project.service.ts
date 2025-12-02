import { supabaseAdmin } from '@/db/supabase';
import { ProjectCreateRequest } from '@/types';
import { logger } from '@/utils/logger';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Project Service
 * Manages projects within workspaces
 */
export class ProjectService {
  /**
   * Verify workspace ownership
   */
  private static async verifyWorkspaceOwnership(
    workspaceId: string,
    userId: string
  ): Promise<boolean> {
    try {
      if (!UUID_REGEX.test(workspaceId) || !UUID_REGEX.test(userId)) {
        return false;
      }

      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .select('user_id')
        .eq('id', workspaceId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error || !data) {
        return false;
      }

      return true;
    } catch (error) {
      logger.error('[PROJECT] Error verifying workspace ownership', {
        error,
        workspaceId,
        userId,
      });
      return false;
    }
  }

  /**
   * Create a new project
   */
  static async createProject(
    userId: string,
    projectData: ProjectCreateRequest
  ): Promise<any> {
    try {
      // Validate inputs
      if (!UUID_REGEX.test(userId)) {
        throw new Error('Invalid user ID format');
      }

      if (!UUID_REGEX.test(projectData.workspace_id)) {
        throw new Error('Invalid workspace ID format');
      }

      if (!projectData.name || typeof projectData.name !== 'string' || projectData.name.trim().length === 0) {
        throw new Error('Project name is required and must be a non-empty string');
      }

      if (projectData.name.length > 255) {
        throw new Error('Project name is too long (max 255 characters)');
      }

      // Verify workspace ownership
      const isOwner = await this.verifyWorkspaceOwnership(projectData.workspace_id, userId);
      if (!isOwner) {
        throw new Error('Workspace not found or access denied');
      }

      // Prepare settings
      const settings = {
        main_url: projectData.settings?.main_url,
        tested_pages: projectData.settings?.tested_pages || [],
        common_elements: projectData.settings?.common_elements || {},
        common_scope: projectData.settings?.common_scope,
        defaultBrowsers: projectData.settings?.defaultBrowsers || ['chrome'],
        ...projectData.settings,
      };

      // Create project
      const { data, error } = await supabaseAdmin
        .from('projects')
        .insert({
          name: projectData.name.trim(),
          description: projectData.description?.trim() || null,
          user_id: userId,
          workspace_id: projectData.workspace_id,
          settings,
        })
        .select('*')
        .single();

      if (error) {
        logger.error('[PROJECT] Error creating project', {
          error,
          userId,
          workspaceId: projectData.workspace_id,
        });
        throw error;
      }

      logger.info('[PROJECT] Created project successfully', {
        projectId: data.id,
        name: data.name,
        workspaceId: projectData.workspace_id,
      });

      return data;
    } catch (error) {
      logger.error('[PROJECT] Failed to create project', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        workspaceId: projectData.workspace_id,
      });
      throw error;
    }
  }

  /**
   * Get project by ID
   */
  static async getProject(projectId: string, userId: string): Promise<any> {
    try {
      if (!UUID_REGEX.test(projectId) || !UUID_REGEX.test(userId)) {
        throw new Error('Invalid ID format');
      }

      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        logger.error('[PROJECT] Error getting project', { error, projectId, userId });
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('[PROJECT] Failed to get project', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        userId,
      });
      throw error;
    }
  }

  /**
   * Get all projects for a user (across all workspaces)
   */
  static async getUserProjects(userId: string): Promise<any[]> {
    try {
      if (!UUID_REGEX.test(userId)) {
        throw new Error('Invalid user ID format');
      }

      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        logger.error('[PROJECT] Error getting user projects', { error, userId });
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('[PROJECT] Failed to get user projects', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      throw error;
    }
  }

  /**
   * Get all projects for a workspace
   */
  static async getProjectsByWorkspace(workspaceId: string, userId: string): Promise<any[]> {
    try {
      if (!UUID_REGEX.test(workspaceId) || !UUID_REGEX.test(userId)) {
        throw new Error('Invalid ID format');
      }

      // Verify workspace ownership
      const isOwner = await this.verifyWorkspaceOwnership(workspaceId, userId);
      if (!isOwner) {
        throw new Error('Workspace not found or access denied');
      }

      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        logger.error('[PROJECT] Error getting projects', { error, workspaceId, userId });
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('[PROJECT] Failed to get projects', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        userId,
      });
      throw error;
    }
  }

  /**
   * Update project
   */
  static async updateProject(
    projectId: string,
    userId: string,
    updates: Partial<ProjectCreateRequest>
  ): Promise<any> {
    try {
      if (!UUID_REGEX.test(projectId) || !UUID_REGEX.test(userId)) {
        throw new Error('Invalid ID format');
      }

      // Verify project ownership
      const project = await this.getProject(projectId, userId);
      if (!project) {
        throw new Error('Project not found or access denied');
      }

      const updateData: any = {};

      if (updates.name !== undefined) {
        if (typeof updates.name !== 'string' || updates.name.trim().length === 0) {
          throw new Error('Project name must be a non-empty string');
        }
        if (updates.name.length > 255) {
          throw new Error('Project name is too long (max 255 characters)');
        }
        updateData.name = updates.name.trim();
      }

      if (updates.description !== undefined) {
        updateData.description = updates.description?.trim() || null;
      }

      if (updates.settings !== undefined) {
        updateData.settings = {
          ...project.settings,
          ...updates.settings,
        };
      }

      const { data, error } = await supabaseAdmin
        .from('projects')
        .update(updateData)
        .eq('id', projectId)
        .eq('user_id', userId)
        .select('*')
        .single();

      if (error) {
        logger.error('[PROJECT] Error updating project', { error, projectId, userId });
        throw error;
      }

      return data;
    } catch (error) {
      logger.error('[PROJECT] Failed to update project', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        userId,
      });
      throw error;
    }
  }

  /**
   * Delete project
   */
  static async deleteProject(projectId: string, userId: string): Promise<void> {
    try {
      if (!UUID_REGEX.test(projectId) || !UUID_REGEX.test(userId)) {
        throw new Error('Invalid ID format');
      }

      // Verify project ownership
      const project = await this.getProject(projectId, userId);
      if (!project) {
        throw new Error('Project not found or access denied');
      }

      const { error } = await supabaseAdmin
        .from('projects')
        .delete()
        .eq('id', projectId)
        .eq('user_id', userId);

      if (error) {
        logger.error('[PROJECT] Error deleting project', { error, projectId, userId });
        throw error;
      }

      logger.info('[PROJECT] Deleted project', { projectId, userId });
    } catch (error) {
      logger.error('[PROJECT] Failed to delete project', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        userId,
      });
      throw error;
    }
  }
}
