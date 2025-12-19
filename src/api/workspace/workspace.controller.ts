import { supabaseAdmin } from '@/db/supabase';
import { WorkspaceService } from '@/services/core/workspace.service';
import { WorkspaceCreateRequest } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if user owns workspace
 */
async function verifyWorkspaceOwnership(workspaceId: string, userId: string): Promise<boolean> {
  try {
    // Validate UUIDs
    if (!UUID_REGEX.test(workspaceId) || !UUID_REGEX.test(userId)) {
      return false;
    }

    const { data, error } = await supabaseAdmin
      .from('workspaces')
      .select('user_id')
      .eq('id', workspaceId)
      .maybeSingle();

    if (error || !data) {
      return false;
    }

    return data.user_id === userId;
  } catch (error) {
    logger.error('[WORKSPACE_API] Error verifying ownership', { error, workspaceId, userId });
    return false;
  }
}

/**
 * POST /api/v1/workspaces
 * Create a new workspace
 */
export const createWorkspace = async (req: Request, res: Response): Promise<void> => {
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

    // Validate userId format (UUID)
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
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
    if (!workspaceData.name || typeof workspaceData.name !== 'string' || workspaceData.name.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: project_name',
        message: 'Field project_name is required and must be a non-empty string',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate name length
    if (workspaceData.name.length > 255) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: project_name',
        message: 'Field project_name is too long (max 255 characters)',
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

    // Validate platforms array
    const validPlatforms = ['web', 'mobile', 'api'];
    const invalidPlatforms = workspaceData.platforms.filter(p => !validPlatforms.includes(p));
    if (invalidPlatforms.length > 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid field: platforms',
        message: `Invalid platforms: ${invalidPlatforms.join(', ')}. Must be one of: ${validPlatforms.join(', ')}`,
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

    // Validate URL format
    try {
      new URL(workspaceData.devBaseUrl);
    } catch {
      res.status(400).json({
        success: false,
        error: 'Invalid field: devBaseUrl',
        message: 'Field devBaseUrl must be a valid URL',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate prodBaseUrl if provided
    if (workspaceData.prodBaseUrl) {
      try {
        new URL(workspaceData.prodBaseUrl);
      } catch {
        res.status(400).json({
          success: false,
          error: 'Invalid field: prodBaseUrl',
          message: 'Field prodBaseUrl must be a valid URL',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    logger.info('[WORKSPACE_API] Creating workspace', {
      userId,
      workspaceData
    });

    const finalWorkspaceName = workspaceData.name.trim() || 'Untitled';
    const workspaceId = await WorkspaceService.createWorkspace(userId, finalWorkspaceName);

    // Fetch created workspace for response
    const workspace = await WorkspaceService.getWorkspace(workspaceId);

    res.status(201).json({
      success: true,
      data: workspace,
      message: 'Workspace created successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_API] Error creating workspace', { error });

    if (res.headersSent) {
      logger.warn('[WORKSPACE_API] Response already sent, cannot send error response');
      return;
    }

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

    if (!userId || userId === 'unknown') {
      res.status(400).json({
        success: false,
        error: 'Unable to identify user',
        message: 'Failed to identify user',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate userId format (UUID)
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[WORKSPACE_API] Getting workspaces', {
      userId: userId,
      requestHeaders: {
        'user-agent': req.headers['user-agent'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'x-real-ip': req.headers['x-real-ip']
      }
    });

    let workspaces = await WorkspaceService.getUserWorkspaces(userId);

    // Auto-create workspace if none found (for both authenticated and anonymous users)
    if (!workspaces || workspaces.length === 0) {
      logger.info('[WORKSPACE_API] No workspaces found, creating default workspace', {
        userId: userId,
      });

      const { workspace_id } = await WorkspaceService.checkOrCreateWorkspace(userId);

      // Fetch the newly created workspace
      workspaces = await WorkspaceService.getUserWorkspaces(userId);

      logger.info('[WORKSPACE_API] Created default workspace', {
        userId: userId,
        workspaceId: workspace_id,
        count: workspaces?.length || 0
      });
    }

    logger.info('[WORKSPACE_API] Found workspaces', {
      userId: userId,
      count: workspaces?.length || 0,
      workspaceIds: workspaces?.map(w => w.id) || []
    });

    res.json({
      success: true,
      data: workspaces,
      count: workspaces.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_API] Error getting workspaces', { error });

    if (res.headersSent) {
      logger.warn('[WORKSPACE_API] Response already sent, cannot send error response');
      return;
    }

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
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate userId format (UUID)
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Missing workspace ID',
        message: 'Workspace ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate workspaceId format (UUID)
    if (!UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID format',
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
        message: 'Workspace not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify workspace ownership
    const isOwner = await verifyWorkspaceOwnership(workspaceId, userId);
    if (!isOwner) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'Access denied to this workspace',
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

    if (res.headersSent) {
      logger.warn('[WORKSPACE_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get workspace',
      message: 'Failed to get workspace',
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
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate userId format (UUID)
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Missing workspace ID',
        message: 'Workspace ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate workspaceId format (UUID)
    if (!UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify workspace ownership
    const isOwner = await verifyWorkspaceOwnership(workspaceId, userId);
    if (!isOwner) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'Access denied to this workspace',
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

    if (updates.platforms !== undefined) {
      if (!Array.isArray(updates.platforms) || updates.platforms.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid field: platforms',
          message: 'Field platforms must be a non-empty array',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const validPlatforms = ['web', 'mobile', 'api'];
      const invalidPlatforms = updates.platforms.filter((p: any) => !validPlatforms.includes(p));
      if (invalidPlatforms.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid field: platforms',
          message: `Invalid platforms: ${invalidPlatforms.join(', ')}. Must be one of: ${validPlatforms.join(', ')}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    if (updates.devBaseUrl !== undefined) {
      try {
        new URL(updates.devBaseUrl);
      } catch {
        res.status(400).json({
          success: false,
          error: 'Invalid field: devBaseUrl',
          message: 'Field devBaseUrl must be a valid URL',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    if (updates.prodBaseUrl !== undefined) {
      try {
        new URL(updates.prodBaseUrl);
      } catch {
        res.status(400).json({
          success: false,
          error: 'Invalid field: prodBaseUrl',
          message: 'Field prodBaseUrl must be a valid URL',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    logger.info('[WORKSPACE_API] Updating workspace', { userId, workspaceId, updates });

    const workspace = await WorkspaceService.updateWorkspace(workspaceId, updates);

    if (!workspace) {
      res.status(404).json({
        success: false,
        error: 'Workspace not found',
        message: 'Workspace not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: workspace,
      message: 'Workspace updated successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_API] Error updating workspace', { error });

    if (res.headersSent) {
      logger.warn('[WORKSPACE_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update workspace',
      message: 'Failed to update workspace',
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
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate userId format (UUID)
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Missing workspace ID',
        message: 'Workspace ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate workspaceId format (UUID)
    if (!UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID format',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify workspace ownership before deletion
    const isOwner = await verifyWorkspaceOwnership(workspaceId, userId);
    if (!isOwner) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'Access denied to this workspace',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[WORKSPACE_API] Deleting workspace', { userId, workspaceId });

    await WorkspaceService.deleteWorkspace(workspaceId);

    res.json({
      success: true,
      message: 'Workspace deleted successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_API] Error deleting workspace', { error });

    if (res.headersSent) {
      logger.warn('[WORKSPACE_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete workspace',
      message: 'Failed to delete workspace',
      timestamp: new Date().toISOString(),
    });
  }
};
