import { ProjectService } from '@/services/core/project.service';
import { ProjectCreateRequest } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/projects
 * Create a new project
 */
export const createProject = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate userId format
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const body = req.body as any;

    // Support both snake_case and camelCase
    const projectData: ProjectCreateRequest = {
      name: body.name || body.project_name,
      description: body.description,
      workspace_id: body.workspace_id || body.workspaceId,
      settings: body.settings || {},
    };

    // Validate required fields
    if (!projectData.name || typeof projectData.name !== 'string' || projectData.name.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: name',
        message: 'Field name is required and must be a non-empty string',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (projectData.name.length > 255) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: name',
        message: 'Field name is too long (max 255 characters)',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!projectData.workspace_id) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: workspace_id',
        message: 'Field workspace_id is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!UUID_REGEX.test(projectData.workspace_id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: workspace_id',
        message: 'Field workspace_id must be a valid UUID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate main_url if provided
    if (projectData.settings?.main_url) {
      try {
        new URL(projectData.settings.main_url);
      } catch {
        res.status(400).json({
          success: false,
          error: 'Invalid field: settings.main_url',
          message: 'Field settings.main_url must be a valid URL',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    logger.info('[PROJECT_API] Creating project', {
      userId,
      workspaceId: projectData.workspace_id,
      projectName: projectData.name,
    });

    const project = await ProjectService.createProject(userId, projectData);

    res.status(201).json({
      success: true,
      data: project,
      message: 'Project created successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[PROJECT_API] Error creating project', { error });

    if (res.headersSent) {
      logger.warn('[PROJECT_API] Response already sent, cannot send error response');
      return;
    }

    const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 500;
    const errorMessage = error instanceof Error ? error.message : 'Failed to create project';

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      message: 'Failed to create project',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/projects
 * Get all projects for the current user (optionally filtered by workspace)
 */
export const getProjects = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.query.workspace_id as string | undefined;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    let projects;

    if (workspaceId) {
      if (!UUID_REGEX.test(workspaceId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid workspace ID format',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      projects = await ProjectService.getProjectsByWorkspace(workspaceId, userId);
    } else {
      // Get all projects for user (across all workspaces)
      projects = await ProjectService.getUserProjects(userId);
    }

    res.json({
      success: true,
      data: projects,
      count: projects.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[PROJECT_API] Error getting projects', { error });

    if (res.headersSent) {
      logger.warn('[PROJECT_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get projects',
      message: 'Failed to get projects',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/projects/:id
 * Get project by ID
 */
export const getProject = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const projectId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!projectId || !UUID_REGEX.test(projectId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const project = await ProjectService.getProject(projectId, userId);

    if (!project) {
      res.status(404).json({
        success: false,
        error: 'Project not found',
        message: 'Project not found or access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: project,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[PROJECT_API] Error getting project', { error });

    if (res.headersSent) {
      logger.warn('[PROJECT_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get project',
      message: 'Failed to get project',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * PUT /api/v1/projects/:id
 * Update project
 */
export const updateProject = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const projectId = req.params.id;
    const updates = req.body as Partial<ProjectCreateRequest>;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!projectId || !UUID_REGEX.test(projectId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate updates
    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string' || updates.name.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid field: name',
          message: 'Field name must be a non-empty string',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (updates.name.length > 255) {
        res.status(400).json({
          success: false,
          error: 'Invalid field: name',
          message: 'Field name is too long (max 255 characters)',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    // Prevent changing workspace_id (project belongs to workspace)
    if (updates.workspace_id !== undefined) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: workspace_id',
        message: 'Cannot change workspace_id. Project belongs to its workspace.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (updates.settings?.main_url) {
      try {
        new URL(updates.settings.main_url);
      } catch {
        res.status(400).json({
          success: false,
          error: 'Invalid field: settings.main_url',
          message: 'Field settings.main_url must be a valid URL',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    logger.info('[PROJECT_API] Updating project', { userId, projectId, updates });

    const project = await ProjectService.updateProject(projectId, userId, updates);

    res.json({
      success: true,
      data: project,
      message: 'Project updated successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[PROJECT_API] Error updating project', { error });

    if (res.headersSent) {
      logger.warn('[PROJECT_API] Response already sent, cannot send error response');
      return;
    }

    const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 500;
    const errorMessage = error instanceof Error ? error.message : 'Failed to update project';

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      message: 'Failed to update project',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * DELETE /api/v1/projects/:id
 * Delete project
 */
export const deleteProject = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const projectId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!projectId || !UUID_REGEX.test(projectId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[PROJECT_API] Deleting project', { userId, projectId });

    await ProjectService.deleteProject(projectId, userId);

    res.json({
      success: true,
      message: 'Project deleted successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[PROJECT_API] Error deleting project', { error });

    if (res.headersSent) {
      logger.warn('[PROJECT_API] Response already sent, cannot send error response');
      return;
    }

    const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 500;
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete project';

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      message: 'Failed to delete project',
      timestamp: new Date().toISOString(),
    });
  }
};
