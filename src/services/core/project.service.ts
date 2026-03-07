import { supabaseAdmin } from '@/db/supabase';
import { ProjectCreateRequest } from '@/types';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import {
  PERMISSIONS,
  WorkspaceAccessService,
  WorkspaceRole,
} from './workspace-access.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Project Service
 * Manages projects within workspaces
 *
 * Access model (B2B org-based):
 * - owner & full_access: full CRUD on projects
 * - view: read-only access
 */
export class ProjectService {
  /**
   * Verify workspace membership (replaces legacy ownership check)
   * Returns the user's role if they are a member, null otherwise
   */
  private static async verifyWorkspaceMembership(
    workspaceId: string,
    userId: string
  ): Promise<WorkspaceRole | null> {
    try {
      if (!UUID_REGEX.test(workspaceId) || !UUID_REGEX.test(userId)) {
        return null;
      }

      return await WorkspaceAccessService.getRole(userId, workspaceId);
    } catch (error) {
      logger.error('[PROJECT] Error verifying workspace membership', {
        error,
        workspaceId,
        userId,
      });
      return null;
    }
  }

  /**
   * Check if user has write access to workspace (owner or full_access)
   */
  private static async hasWriteAccess(
    workspaceId: string,
    userId: string
  ): Promise<boolean> {
    return await WorkspaceAccessService.hasPermission(
      userId,
      workspaceId,
      PERMISSIONS.PROJECT_WRITE
    );
  }

  /**
   * Check if user has read access to workspace (any active member)
   */
  private static async hasReadAccess(
    workspaceId: string,
    userId: string
  ): Promise<boolean> {
    return await WorkspaceAccessService.hasPermission(
      userId,
      workspaceId,
      PERMISSIONS.PROJECT_READ
    );
  }

  /**
   * Create a new project
   * Requires: owner or full_access role
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

      // Verify write access (owner or full_access)
      const hasAccess = await this.hasWriteAccess(projectData.workspace_id, userId);
      if (!hasAccess) {
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

      // Invalidate project list caches
      await cache.delByPattern(`qait:cache:projects:ws:${projectData.workspace_id}:*`);
      await cache.delByPattern(`qait:cache:projects:user:*`);

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
   * Requires: any active membership (owner, full_access, or view)
   */
  static async getProject(projectId: string, userId: string): Promise<any> {
    try {
      if (!UUID_REGEX.test(projectId) || !UUID_REGEX.test(userId)) {
        throw new Error('Invalid ID format');
      }

      // First get the project to check workspace membership
      const { data: project, error } = await supabaseAdmin
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .maybeSingle();

      if (error) {
        logger.error('[PROJECT] Error getting project', { error, projectId, userId });
        throw error;
      }

      if (!project) {
        return null;
      }

      // Check membership in the workspace
      const hasAccess = await this.hasReadAccess(project.workspace_id, userId);
      if (!hasAccess) {
        return null; // Return null as if project doesn't exist (no info leak)
      }

      return project;
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
   * Get all projects for a user (across all workspaces they are a member of)
   * Returns projects from all workspaces where user has membership
   */
  static async getUserProjects(userId: string): Promise<any[]> {
    try {
      if (!UUID_REGEX.test(userId)) {
        throw new Error('Invalid user ID format');
      }

      // Get all workspaces the user is a member of
      const userWorkspaces = await WorkspaceAccessService.getUserWorkspaces(userId);

      if (userWorkspaces.length === 0) {
        return [];
      }

      const workspaceIds = userWorkspaces.map((w) => w.workspace_id);

      // Get projects from all user's workspaces
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('*')
        .in('workspace_id', workspaceIds)
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
   * Requires: any active membership
   */
  static async getProjectsByWorkspace(workspaceId: string, userId: string): Promise<any[]> {
    try {
      if (!UUID_REGEX.test(workspaceId) || !UUID_REGEX.test(userId)) {
        throw new Error('Invalid ID format');
      }

      // Verify workspace membership (any role can read)
      const hasAccess = await this.hasReadAccess(workspaceId, userId);
      if (!hasAccess) {
        throw new Error('Workspace not found or access denied');
      }

      // Get all projects in the workspace (not filtered by user_id anymore)
      const { data, error } = await supabaseAdmin
        .from('projects')
        .select('*')
        .eq('workspace_id', workspaceId)
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
   * Requires: owner or full_access role in the workspace
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

      // First get the project to check workspace membership
      const { data: project, error: fetchError } = await supabaseAdmin
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .maybeSingle();

      if (fetchError) {
        logger.error('[PROJECT] Error fetching project for update', { error: fetchError, projectId });
        throw fetchError;
      }

      if (!project) {
        throw new Error('Project not found or access denied');
      }

      // Verify write access in the workspace
      const hasAccess = await this.hasWriteAccess(project.workspace_id, userId);
      if (!hasAccess) {
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
        .select('*')
        .single();

      if (error) {
        logger.error('[PROJECT] Error updating project', { error, projectId, userId });
        throw error;
      }

      // Invalidate project list caches
      await cache.delByPattern(`qait:cache:projects:ws:${project.workspace_id}:*`);
      await cache.delByPattern(`qait:cache:projects:user:*`);

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
   * Requires: owner or full_access role in the workspace
   */
  static async deleteProject(projectId: string, userId: string): Promise<void> {
    try {
      if (!UUID_REGEX.test(projectId) || !UUID_REGEX.test(userId)) {
        throw new Error('Invalid ID format');
      }

      // First get the project to check workspace membership
      const { data: project, error: fetchError } = await supabaseAdmin
        .from('projects')
        .select('id, workspace_id')
        .eq('id', projectId)
        .maybeSingle();

      if (fetchError) {
        logger.error('[PROJECT] Error fetching project for delete', { error: fetchError, projectId });
        throw fetchError;
      }

      if (!project) {
        throw new Error('Project not found or access denied');
      }

      // Verify delete access in the workspace (requires PROJECT_DELETE permission)
      const hasAccess = await WorkspaceAccessService.hasPermission(
        userId,
        project.workspace_id,
        PERMISSIONS.PROJECT_DELETE
      );
      if (!hasAccess) {
        throw new Error('Project not found or access denied');
      }

      const { error } = await supabaseAdmin
        .from('projects')
        .delete()
        .eq('id', projectId);

      if (error) {
        logger.error('[PROJECT] Error deleting project', { error, projectId, userId });
        throw error;
      }

      logger.info('[PROJECT] Deleted project', { projectId, userId });

      // Invalidate project list caches
      await cache.delByPattern(`qait:cache:projects:ws:${project.workspace_id}:*`);
      await cache.delByPattern(`qait:cache:projects:user:*`);
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
