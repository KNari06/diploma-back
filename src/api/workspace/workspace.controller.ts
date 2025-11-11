import { WorkspaceService } from '@/services/workspace.service';
import { WorkspaceCreateRequest } from '@/types';
import { getClientIp, normalizeIpForAnonymousId } from '@/utils/ip-helper';
import { logger } from '@/utils/logger';
import { Request, Response } from 'express';

/**
 * POST /api/v1/workspaces
 * Create a new workspace
 */
export const createWorkspace = async (req: Request, res: Response): Promise<void> => {
  try {
    // Support both authenticated and anonymous users
    const userId = req.user?.id;

    // For anonymous users, use IP address as identifier
    const clientIp = getClientIp(req);
    const userIp = userId ? undefined : normalizeIpForAnonymousId(clientIp);
    const effectiveUserId = userId || userIp || 'unknown';

    if (!effectiveUserId || effectiveUserId === 'unknown') {
      res.status(400).json({
        success: false,
        error: 'Unable to identify user',
        message: 'Failed to identify user',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const body = req.body as any;

    // Use project_name as primary, fallback to name for compatibility
    const workspaceName = body.project_name || body.name;

    const workspaceData: WorkspaceCreateRequest = {
      name: workspaceName,
      platforms: body.platforms,
      api_testing: body.api_testing,
      devBaseUrl: body.devBaseUrl || body.dev_base_url, // Support both formats
      prodBaseUrl: body.prodBaseUrl || body.prod_base_url, // Support both formats
    };

    // Validate required fields
    if (!workspaceData.name) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: project_name',
        message: 'Field project_name is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceData.platforms || !Array.isArray(workspaceData.platforms) || workspaceData.platforms.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid field: platforms',
        message: 'Field platforms must be a non-empty array',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceData.devBaseUrl) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: devBaseUrl',
        message: 'Field devBaseUrl is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[WORKSPACE_API] Creating workspace', {
      userId: effectiveUserId,
      isAuthenticated: !!userId,
      workspaceData
    });

    const finalWorkspaceName = workspaceData.name || `Workspace ${effectiveUserId.slice(0, 8)}`;
    const workspace = await WorkspaceService.createWorkspace(effectiveUserId, finalWorkspaceName);

    res.status(201).json({
      success: true,
      data: workspace,
      message: 'Workspace created successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_API] Error creating workspace', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create workspace',
      message: 'Failed to create workspace',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/workspaces
 * Get all workspaces for the current user
 */
export const getWorkspaces = async (req: Request, res: Response): Promise<void> => {
  try {
    // Support both authenticated and anonymous users
    const userId = req.user?.id;

    // For anonymous users, use IP address as identifier
    const clientIp = getClientIp(req);
    const userIp = userId ? undefined : normalizeIpForAnonymousId(clientIp);
    const effectiveUserId = userId || userIp || 'unknown';

    if (!effectiveUserId || effectiveUserId === 'unknown') {
      res.status(400).json({
        success: false,
        error: 'Unable to identify user',
        message: 'Failed to identify user',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[WORKSPACE_API] Getting workspaces', {
      userId: effectiveUserId,
      isAuthenticated: !!userId
    });

    const workspaces = await WorkspaceService.getUserWorkspaces(effectiveUserId);

    res.json({
      success: true,
      data: workspaces,
      count: workspaces.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_API] Error getting workspaces', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get workspaces',
      message: 'Failed to get workspaces',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/workspaces/:id
 * Get workspace by ID
 */
export const getWorkspace = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Требуется авторизация',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Missing workspace ID',
        message: 'Не указан ID workspace',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[WORKSPACE_API] Getting workspace', { userId, workspaceId });

    const workspace = await WorkspaceService.getWorkspace(workspaceId);

    if (!workspace) {
      res.status(404).json({
        success: false,
        error: 'Workspace not found',
        message: 'Workspace не найден',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: workspace,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_API] Error getting workspace', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get workspace',
      message: 'Не удалось получить workspace',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * PUT /api/v1/workspaces/:id
 * Update workspace
 */
export const updateWorkspace = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;
    const updates = req.body as Partial<WorkspaceCreateRequest>;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Требуется авторизация',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Missing workspace ID',
        message: 'Не указан ID workspace',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[WORKSPACE_API] Updating workspace', { userId, workspaceId, updates });

    const workspace = await WorkspaceService.updateWorkspace(workspaceId, updates);

    if (!workspace) {
      res.status(404).json({
        success: false,
        error: 'Workspace not found',
        message: 'Workspace не найден',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: workspace,
      message: 'Workspace успешно обновлен',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_API] Error updating workspace', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update workspace',
      message: 'Не удалось обновить workspace',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * DELETE /api/v1/workspaces/:id
 * Delete workspace
 */
export const deleteWorkspace = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Требуется авторизация',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Missing workspace ID',
        message: 'Не указан ID workspace',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[WORKSPACE_API] Deleting workspace', { userId, workspaceId });

    await WorkspaceService.deleteWorkspace(workspaceId);

    // deleteWorkspace returns void, assume success if no error thrown
    const success = true;

    if (!success) {
      res.status(404).json({
        success: false,
        error: 'Workspace not found',
        message: 'Workspace не найден',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      message: 'Workspace успешно удален',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_API] Error deleting workspace', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete workspace',
      message: 'Не удалось удалить workspace',
      timestamp: new Date().toISOString(),
    });
  }
};
