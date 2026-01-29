/**
 * Platforms Tree Controller
 * GET /api/v1/platforms/tree - Returns nested hierarchy with pagination support
 *
 * Modes (based on scope params, precedence order):
 * - flowId: return flow + paginated testCases
 * - suiteId: return suite + paginated flows
 * - moduleId: return module + paginated suites
 * - none: return platforms + paginated modules (per platform)
 */

import { PlatformTreeService } from '@/services/testing/platforms/platform-tree.service';
import { PlatformService } from '@/services/testing/platforms/platform.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string; role: string };
}

/**
 * Extract and validate user ID from request
 */
function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new Error('User ID not found');
  return userId;
}

/**
 * Get platform tree with pagination support
 *
 * Query params:
 * - projectId (required for base mode)
 * - flowId, suiteId, moduleId (scope params - mutually exclusive)
 * - limit (default 20)
 * - offset (default 0)
 * - depth (1-4, for future nested expansion)
 *
 * @route GET /api/v1/platforms/tree
 */
export async function getPlatformTree(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, flowId, suiteId, moduleId } = req.query;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const userId = getUserId(req);

    // Determine mode based on scope params (precedence order)
    if (flowId && typeof flowId === 'string') {
      // Flow mode: return flow + paginated testCases
      logger.info('[PLATFORM_TREE_API] Flow mode', { flowId, userId, limit, offset });

      const result = await PlatformTreeService.getFlowModeTree(flowId, userId, { limit, offset });

      res.json({
        success: true,
        mode: 'flow',
        data: result,
        timestamp: new Date(),
      });
      return;
    }

    if (suiteId && typeof suiteId === 'string') {
      // Suite mode: return suite + paginated flows
      logger.info('[PLATFORM_TREE_API] Suite mode', { suiteId, userId, limit, offset });

      const result = await PlatformTreeService.getSuiteModeTree(suiteId, userId, { limit, offset });

      res.json({
        success: true,
        mode: 'suite',
        data: result,
        timestamp: new Date(),
      });
      return;
    }

    if (moduleId && typeof moduleId === 'string') {
      // Module mode: return module + paginated suites
      logger.info('[PLATFORM_TREE_API] Module mode', { moduleId, userId, limit, offset });

      const result = await PlatformTreeService.getModuleModeTree(moduleId, userId, { limit, offset });

      res.json({
        success: true,
        mode: 'module',
        data: result,
        timestamp: new Date(),
      });
      return;
    }

    // Base mode: platforms + paginated modules (requires projectId)
    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'projectId is required for base mode (when no scope params provided)',
      });
      return;
    }

    logger.info('[PLATFORM_TREE_API] Base mode', { projectId, userId, limit, offset });

    // Ensure platforms exist (auto-seed if missing)
    await PlatformService.ensurePlatformsExist(projectId, userId);

    const result = await PlatformTreeService.getBaseModeTree(projectId, userId, { limit, offset });

    res.json({
      success: true,
      mode: 'base',
      data: result,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[PLATFORM_TREE_API] Failed to get platform tree', { error });
    handleError(res, error, 'Failed to get platform tree');
  }
}

/**
 * Centralized error handler
 */
function handleError(res: Response, error: unknown, defaultMessage: string): void {
  if (res.headersSent) return;

  if (error instanceof NotFoundError) {
    res.status(404).json({ success: false, error: 'Not found', message: error.message });
    return;
  }

  if (error instanceof ValidationError) {
    res.status(422).json({ success: false, error: 'Validation error', message: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : 'Unknown error';

  // Handle "not found" style errors from service
  if (message.includes('not found') || message.includes('access denied')) {
    res.status(404).json({ success: false, error: 'Not found', message });
    return;
  }

  res.status(500).json({
    success: false,
    error: defaultMessage,
    message,
  });
}
