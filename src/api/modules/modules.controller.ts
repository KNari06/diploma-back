/**
 * Modules Controller
 * API endpoints for test modules CRUD
 */

import { ModuleService } from '@/services/testing/modules/module.service';
import { PlatformService } from '@/services/testing/platforms/platform.service';
import { NotFoundError, ValidationError } from '@/types';
import type { PlatformKey } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string; role: string };
}

function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new Error('User ID not found');
  return userId;
}

/**
 * Create a new test module
 * Requires platformId or platformKey to specify which platform the module belongs to
 */
export async function createModule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, platformId, platformKey, name, description, tags, priority } = req.body;

    if (!projectId || !name) {
      res.status(400).json({ success: false, error: 'projectId and name are required' });
      return;
    }

    if (!platformId && !platformKey) {
      res.status(400).json({ success: false, error: 'platformId or platformKey is required' });
      return;
    }

    const userId = getUserId(req);

    // Resolve platformId from platformKey if needed
    let resolvedPlatformId = platformId;
    if (!resolvedPlatformId && platformKey) {
      // Ensure platforms exist and get the one matching the key
      const platforms = await PlatformService.ensurePlatformsExist(projectId, userId);
      resolvedPlatformId = platformKey === 'web_ui'
        ? platforms.webUi.id
        : platformKey === 'mobile'
        ? platforms.mobile.id
        : platforms.api.id;
    }

    const module = await ModuleService.create({
      projectId,
      userId,
      platformId: resolvedPlatformId,
      name,
      description,
      tags,
      priority,
    });

    res.json({ success: true, data: module, timestamp: new Date() });
  } catch (error) {
    logger.error('[MODULES_API] Failed to create module', { error });
    handleError(res, error, 'Failed to create module');
  }
}

/**
 * Get a module by ID
 */
export async function getModule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const module = await ModuleService.getById(id, userId);
    if (!module) {
      res.status(404).json({ success: false, error: 'Module not found' });
      return;
    }

    res.json({ success: true, data: module, timestamp: new Date() });
  } catch (error) {
    logger.error('[MODULES_API] Failed to get module', { error });
    handleError(res, error, 'Failed to get module');
  }
}

/**
 * List modules for a project
 * Supports filtering by platformId or platformKey
 */
export async function listModules(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, platformId, platformKey } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }

    const userId = getUserId(req);
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await ModuleService.listByProject(projectId, userId, {
      limit,
      offset,
      platformId: typeof platformId === 'string' ? platformId : undefined,
      platformKey: typeof platformKey === 'string' ? (platformKey as PlatformKey) : undefined,
    });

    res.json({
      success: true,
      data: result.items,
      pagination: { limit, offset, total: result.total },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[MODULES_API] Failed to list modules', { error });
    handleError(res, error, 'Failed to list modules');
  }
}

/**
 * Update a module
 */
export async function updateModule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description, tags, priority } = req.body;
    const userId = getUserId(req);

    const module = await ModuleService.update({
      id,
      userId,
      name,
      description,
      tags,
      priority,
    });

    res.json({ success: true, data: module, timestamp: new Date() });
  } catch (error) {
    logger.error('[MODULES_API] Failed to update module', { error });
    handleError(res, error, 'Failed to update module');
  }
}

/**
 * Delete a module
 */
export async function deleteModule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    await ModuleService.delete(id, userId);

    res.json({ success: true, message: 'Module deleted', timestamp: new Date() });
  } catch (error) {
    logger.error('[MODULES_API] Failed to delete module', { error });
    handleError(res, error, 'Failed to delete module');
  }
}

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
