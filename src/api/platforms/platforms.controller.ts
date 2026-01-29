/**
 * Platforms Controller
 * API endpoints for test platforms
 */

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
 * List platforms for a project
 * Returns both web_ui and api platforms, auto-seeds if missing
 *
 * @route GET /api/v1/platforms?projectId=<uuid>
 */
export async function listPlatforms(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }

    const userId = getUserId(req);

    // Ensure platforms exist (auto-seed if missing)
    await PlatformService.ensurePlatformsExist(projectId, userId);

    // List all platforms
    const platforms = await PlatformService.listByProject(projectId, userId);

    res.json({
      success: true,
      data: platforms,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[PLATFORMS_API] Failed to list platforms', { error });
    handleError(res, error, 'Failed to list platforms');
  }
}

/**
 * Get a platform by ID
 *
 * @route GET /api/v1/platforms/:id
 */
export async function getPlatform(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const platform = await PlatformService.getById(id, userId);
    if (!platform) {
      res.status(404).json({ success: false, error: 'Platform not found' });
      return;
    }

    res.json({ success: true, data: platform, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLATFORMS_API] Failed to get platform', { error });
    handleError(res, error, 'Failed to get platform');
  }
}

/**
 * Update a platform (name/description only)
 *
 * @route PATCH /api/v1/platforms/:id
 */
export async function updatePlatform(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const userId = getUserId(req);

    const platform = await PlatformService.update(id, userId, { name, description });

    res.json({ success: true, data: platform, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLATFORMS_API] Failed to update platform', { error });
    handleError(res, error, 'Failed to update platform');
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

  res.status(500).json({
    success: false,
    error: defaultMessage,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}
