/**
 * Module Service
 * CRUD + nesting orchestration for test modules (folders).
 * Queries live in ./db/module.db.ts — this layer holds validation, cache
 * invalidation and mapping only (no direct Supabase access).
 */

import * as moduleDb from '@/services/testing/modules/db/module.db';
import { ValidationError } from '@/types';
import {
  MAX_MODULE_DEPTH,
  type CreateTestModuleParams,
  type PlatformKey,
  type TestModule,
  type UpdateTestModuleParams,
} from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';

/**
 * Service for managing test modules.
 * Modules are folders within a project; a module may nest inside another
 * module (parent_module_id) up to MAX_MODULE_DEPTH levels. Folders are
 * platform-agnostic — platform lives on the test (flow), not the folder, so a
 * folder may hold web, mobile and api tests together (platform_id is nullable).
 */
export class ModuleService {
  /**
   * Create a new test module (optionally nested under a parent folder).
   * @param params - Module creation parameters (must include platformId)
   * @returns Created module
   */
  static async create(params: CreateTestModuleParams): Promise<TestModule> {
    const { projectId, userId, platformId, parentModuleId, name, description, tags, priority } = params;

    // Folders are platform-agnostic — platform lives on the test (flow), not the
    // folder. platformId is optional; NULL means "no platform" for the folder.
    const parentId = parentModuleId ?? null;
    if (parentId) {
      // Parent must exist, be owned by the user, and share the same project.
      const parent = await moduleDb.getModuleCore(parentId, userId);
      if (!parent) {
        throw new ValidationError('Parent module not found');
      }
      if (parent.projectId !== projectId) {
        throw new ValidationError('Parent module belongs to a different project');
      }
      // New module sits one level below its parent.
      const parentDepth = await this.computeDepth(parentId, userId);
      if (parentDepth + 1 > MAX_MODULE_DEPTH) {
        throw new ValidationError(`Maximum folder nesting depth (${MAX_MODULE_DEPTH}) exceeded`);
      }
    }

    logger.info('[MODULE_SERVICE] Creating module', { projectId, userId, platformId, parentId, name });

    // order_index stays NULL on create. NULL = "not manually ordered" → the
    // module sorts by created_at DESC (newest-first). It only gets a value when
    // the user drags to reorder (ModuleService.reorder).
    const module = await moduleDb.insertModule({
      project_id: projectId,
      user_id: userId,
      platform_id: platformId ?? null,
      parent_module_id: parentId,
      name,
      description: description || null,
      tags: tags || [],
      priority: priority || null,
    });

    await this.invalidateTreeCache(projectId);

    return module;
  }

  /**
   * Get a module by ID
   * @param id - Module ID
   * @param userId - User ID for access control
   * @returns Module or null if not found
   */
  static async getById(id: string, userId: string): Promise<TestModule | null> {
    return moduleDb.getModuleById(id, userId);
  }

  /**
   * List modules for a project
   * @param projectId - Project ID
   * @param userId - User ID for access control
   * @param options - Pagination + platform/parent filter options
   * @returns List of modules with total count
   */
  static async listByProject(
    projectId: string,
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      platformId?: string;
      platformKey?: PlatformKey;
      parentModuleId?: string | null;
    } = {},
  ): Promise<{ items: TestModule[]; total: number }> {
    return moduleDb.listModules(projectId, userId, options);
  }

  /**
   * Update a module. Supports re-parenting (move) via `parentModuleId`, which is
   * cycle- and depth-checked before applying.
   * @param params - Update parameters
   * @returns Updated module
   */
  static async update(params: UpdateTestModuleParams): Promise<TestModule> {
    const { id, userId, name, description, tags, priority, orderIndex, parentModuleId } = params;

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (tags !== undefined) updates.tags = tags;
    if (priority !== undefined) updates.priority = priority;
    if (orderIndex !== undefined) updates.order_index = orderIndex;

    if (parentModuleId !== undefined) {
      await this.validateReparent(id, parentModuleId, userId);
      updates.parent_module_id = parentModuleId;
    }

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update');
    }

    logger.info('[MODULE_SERVICE] Updating module', { id, updatedFields: Object.keys(updates) });

    const module = await moduleDb.updateModuleRow(id, userId, updates);

    if (module.projectId) {
      await this.invalidateTreeCache(module.projectId);
    }

    return module;
  }

  /**
   * Delete a module. Its subtree (child folders) and their flows/test cases
   * cascade via foreign keys.
   * @param id - Module ID
   * @param userId - User ID for access control
   * @returns True if deleted
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[MODULE_SERVICE] Deleting module', { id });

    // Fetch project_id before delete for cache invalidation.
    const projectId = await moduleDb.getModuleProjectId(id, userId);

    await moduleDb.deleteModuleRow(id, userId);

    if (projectId) {
      await this.invalidateTreeCache(projectId);
    }

    return true;
  }

  /**
   * Reorder a sibling group of modules (top-level folders, or the children of a
   * single parent). Sets each module's order_index to its position in
   * `moduleIds`. Scoped by project (folders are platform-agnostic). Invalidates
   * the tree cache so the new order is visible immediately.
   */
  static async reorder(projectId: string, moduleIds: string[], userId: string): Promise<void> {
    logger.info('[MODULE_SERVICE] Reordering modules', {
      projectId,
      count: moduleIds.length,
    });

    await moduleDb.setModuleOrderIndexes(moduleIds, projectId, userId);

    await this.invalidateTreeCache(projectId);
  }

  // ── nesting validation ──────────────────────────────────────────────────────

  /**
   * Validate a re-parent (move). Rejects self-parenting, cycles (moving a folder
   * under one of its own descendants), cross-project moves, and moves that would
   * push the moved subtree past MAX_MODULE_DEPTH. Cross-platform moves are
   * allowed — folders are platform-agnostic.
   */
  private static async validateReparent(
    moduleId: string,
    newParentId: string | null,
    userId: string,
  ): Promise<void> {
    if (newParentId === null) return; // moving to top level is always valid

    if (newParentId === moduleId) {
      throw new ValidationError('A folder cannot be its own parent');
    }

    const moduleCore = await moduleDb.getModuleCore(moduleId, userId);
    if (!moduleCore) {
      throw new ValidationError('Module not found');
    }

    const parentCore = await moduleDb.getModuleCore(newParentId, userId);
    if (!parentCore) {
      throw new ValidationError('Parent module not found');
    }
    if (parentCore.projectId !== moduleCore.projectId) {
      throw new ValidationError('Cannot move a folder to a different project');
    }

    if (await this.wouldCreateCycle(moduleId, newParentId, userId)) {
      throw new ValidationError('Cannot move a folder into one of its own sub-folders');
    }

    const parentDepth = await this.computeDepth(newParentId, userId);
    const subtreeHeight = await this.computeSubtreeHeight(moduleId, userId);
    if (parentDepth + subtreeHeight > MAX_MODULE_DEPTH) {
      throw new ValidationError(`Maximum folder nesting depth (${MAX_MODULE_DEPTH}) exceeded`);
    }
  }

  /** Depth of a module = ancestor count + 1 (top-level folder = 1). */
  private static async computeDepth(moduleId: string, userId: string): Promise<number> {
    let depth = 1;
    const visited = new Set<string>([moduleId]);
    let current = await moduleDb.getModuleCore(moduleId, userId);

    while (current?.parentModuleId) {
      if (visited.has(current.parentModuleId)) break; // defensive: broken chain
      visited.add(current.parentModuleId);
      depth += 1;
      current = await moduleDb.getModuleCore(current.parentModuleId, userId);
    }

    return depth;
  }

  /** Number of levels in a module's subtree (the module alone = 1). */
  private static async computeSubtreeHeight(moduleId: string, userId: string): Promise<number> {
    let height = 1;
    let frontier = [moduleId];
    const visited = new Set<string>([moduleId]);

    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        const children = await moduleDb.getChildModuleIds(id, userId);
        for (const child of children) {
          if (!visited.has(child)) {
            visited.add(child);
            next.push(child);
          }
        }
      }
      if (next.length === 0) break;
      height += 1;
      frontier = next;
    }

    return height;
  }

  /** True if `newParentId` is `moduleId` or one of its descendants. */
  private static async wouldCreateCycle(
    moduleId: string,
    newParentId: string,
    userId: string,
  ): Promise<boolean> {
    const visited = new Set<string>();
    let current: string | null = newParentId;

    while (current && !visited.has(current)) {
      if (current === moduleId) return true;
      visited.add(current);
      const core = await moduleDb.getModuleCore(current, userId);
      current = core?.parentModuleId ?? null;
    }

    return false;
  }

  private static async invalidateTreeCache(projectId: string): Promise<void> {
    await cache.delByPattern(`qait:cache:ptree:base:${projectId}:*`);
  }
}
