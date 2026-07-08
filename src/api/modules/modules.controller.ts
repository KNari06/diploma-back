/**
 * Modules Controller
 * API endpoints for test modules CRUD
 */

import { supabaseAdmin } from '@/db/supabase';
import { ModuleService } from '@/services/testing/modules/module.service';
import { PlatformService } from '@/services/testing/platforms/platform.service';
import {
  AUDIT_EVENTS,
  WorkspaceAuditService,
  getAuditContext,
} from '@/services/core/workspace-audit.service';
import { NotFoundError, ValidationError } from '@/types';
import type { PlatformKey } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { emitModuleMutated } from '@/websocket/helpers/project-mutation-emit';
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
    const { projectId, platformId, platformKey, name, description, tags, priority, parentModuleId } = req.body;

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
      parentModuleId: typeof parentModuleId === 'string' ? parentModuleId : null,
      name,
      description,
      tags,
      priority,
    });

    res.json({ success: true, data: module, timestamp: new Date() });

    emitModuleMutated({ projectId, action: 'created', id: module.id, name: module.name });

    void WorkspaceAuditService.logForProject({
      projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.MODULE_CREATED,
      targetType: 'module',
      targetId: module.id,
      metadata: {
        name: module.name,
        platform_id: module.platformId,
        platform_key: module.platformKey,
        parent_module_id: module.parentModuleId,
        priority: module.priority,
      },
      ...getAuditContext(req),
    });
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
    const { projectId, platformId, platformKey, parentModuleId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }

    const userId = getUserId(req);
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    // parentModuleId filter: "null" (literal) = top-level only, a uuid = children
    // of that folder, absent = no parent filter (all levels).
    let parentFilter: string | null | undefined;
    if (parentModuleId === 'null') parentFilter = null;
    else if (typeof parentModuleId === 'string') parentFilter = parentModuleId;

    const result = await ModuleService.listByProject(projectId, userId, {
      limit,
      offset,
      platformId: typeof platformId === 'string' ? platformId : undefined,
      platformKey: typeof platformKey === 'string' ? (platformKey as PlatformKey) : undefined,
      parentModuleId: parentFilter,
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

    // Distinguish "not provided" (leave parent unchanged) from an explicit
    // null (move to top level) or a string (move under that folder).
    const hasParentMove = Object.prototype.hasOwnProperty.call(req.body, 'parentModuleId');
    const parentModuleId = hasParentMove ? (req.body.parentModuleId ?? null) : undefined;

    const module = await ModuleService.update({
      id,
      userId,
      name,
      description,
      tags,
      priority,
      parentModuleId,
    });

    res.json({ success: true, data: module, timestamp: new Date() });

    if (module.projectId) {
      emitModuleMutated({
        projectId: module.projectId,
        action: 'updated',
        id,
        name: module.name,
      });

      const changedFields = Object.entries({ name, description, tags, priority, parentModuleId })
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      void WorkspaceAuditService.logForProject({
        projectId: module.projectId,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.MODULE_UPDATED,
        targetType: 'module',
        targetId: id,
        metadata: { name: module.name, changed_fields: changedFields },
        ...getAuditContext(req),
      });
    }
  } catch (error) {
    logger.error('[MODULES_API] Failed to update module', { error });
    handleError(res, error, 'Failed to update module');
  }
}

/**
 * Reorder modules within a platform.
 * POST /api/v1/modules/reorder — body { projectId, platformId, moduleIds }
 * Sets each module's order_index to its position in moduleIds.
 */
export async function reorderModules(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, platformId, moduleIds } = req.body;

    if (!projectId || !platformId || !moduleIds || !Array.isArray(moduleIds)) {
      res.status(400).json({
        success: false,
        error: 'projectId, platformId and moduleIds array are required',
      });
      return;
    }

    const userId = getUserId(req);

    await ModuleService.reorder(projectId, platformId, moduleIds, userId);

    // Tell the project room the tree changed so clients refetch in the new order.
    emitModuleMutated({ projectId, action: 'updated', id: platformId });

    res.json({ success: true, message: 'Modules reordered', timestamp: new Date() });
  } catch (error) {
    logger.error('[MODULES_API] Failed to reorder modules', { error });
    handleError(res, error, 'Failed to reorder modules');
  }
}

/**
 * Delete a module
 */
export async function deleteModule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    // Snapshot project_id + name BEFORE delete so we can audit afterwards.
    const { data: snapshot } = await supabaseAdmin
      .from('test_modules')
      .select('project_id, name')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();

    await ModuleService.delete(id, userId);

    res.json({ success: true, message: 'Module deleted', timestamp: new Date() });

    if (snapshot?.project_id) {
      emitModuleMutated({ projectId: snapshot.project_id, action: 'deleted', id });

      void WorkspaceAuditService.logForProject({
        projectId: snapshot.project_id,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.MODULE_DELETED,
        targetType: 'module',
        targetId: id,
        metadata: { name: (snapshot as any).name },
        ...getAuditContext(req),
      });
    }
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
