/**
 * Module Service
 * CRUD operations for test modules
 */

import { supabaseAdmin } from '@/db/supabase';
import type {
    CreateTestModuleParams,
    PlatformKey,
    TestModule,
    UpdateTestModuleParams,
} from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

/**
 * Service for managing test modules
 * Modules represent functional areas of the product (Auth, Payments, Profile)
 * Each module belongs to a platform (web_ui or api)
 */
export class ModuleService {
  /**
   * Create a new test module
   * @param params - Module creation parameters (must include platformId)
   * @returns Created module
   */
  static async create(params: CreateTestModuleParams): Promise<TestModule> {
    const { projectId, userId, platformId, name, description, tags, priority } = params;

    if (!platformId) {
      throw new Error('platformId is required to create a module');
    }

    logger.info('[MODULE_SERVICE] Creating module', {
      projectId,
      userId,
      platformId,
      name,
    });

    const { data, error } = await supabaseAdmin
      .from('test_modules')
      .insert({
        project_id: projectId,
        user_id: userId,
        platform_id: platformId,
        name,
        description: description || null,
        tags: tags || [],
        priority: priority || null,
      })
      .select('*, test_platforms!inner(platform_key)')
      .single();

    if (error) {
      logger.error('[MODULE_SERVICE] Failed to create module', { error });
      throw new Error(`Failed to create module: ${error.message}`);
    }

    return this.mapToTestModule(data);
  }

  /**
   * Get a module by ID
   * @param id - Module ID
   * @param userId - User ID for access control
   * @returns Module or null if not found
   */
  static async getById(id: string, userId: string): Promise<TestModule | null> {
    const { data, error } = await supabaseAdmin
      .from('test_modules')
      .select('*, test_platforms!inner(platform_key)')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('[MODULE_SERVICE] Failed to get module', { error, id });
      throw new Error(`Failed to get module: ${error.message}`);
    }

    return this.mapToTestModule(data);
  }

  /**
   * List modules for a project
   * @param projectId - Project ID
   * @param userId - User ID for access control
   * @param options - Pagination and filter options
   * @returns List of modules with total count
   */
  static async listByProject(
    projectId: string,
    userId: string,
    options: { limit?: number; offset?: number; platformId?: string; platformKey?: PlatformKey } = {}
  ): Promise<{ items: TestModule[]; total: number }> {
    const { limit = 50, offset = 0, platformId, platformKey } = options;

    // Build base query for count
    let countQuery = supabaseAdmin
      .from('test_modules')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('user_id', userId);

    // Apply platform filter
    if (platformId) {
      countQuery = countQuery.eq('platform_id', platformId);
    }

    const { count, error: countError } = await countQuery;

    if (countError) {
      logger.error('[MODULE_SERVICE] Failed to count modules', { error: countError });
      throw new Error(`Failed to list modules: ${countError.message}`);
    }

    // Build query for items with platform join
    let itemsQuery = supabaseAdmin
      .from('test_modules')
      .select('*, test_platforms!inner(platform_key)')
      .eq('project_id', projectId)
      .eq('user_id', userId);

    // Apply platform filters
    if (platformId) {
      itemsQuery = itemsQuery.eq('platform_id', platformId);
    }
    if (platformKey) {
      itemsQuery = itemsQuery.eq('test_platforms.platform_key', platformKey);
    }

    const { data, error } = await itemsQuery
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('[MODULE_SERVICE] Failed to list modules', { error });
      throw new Error(`Failed to list modules: ${error.message}`);
    }

    return {
      items: (data || []).map(this.mapToTestModule),
      total: count || 0,
    };
  }

  /**
   * Update a module
   * @param params - Update parameters
   * @returns Updated module
   */
  static async update(params: UpdateTestModuleParams): Promise<TestModule> {
    const { id, userId, name, description, tags, priority } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (tags !== undefined) updates.tags = tags;
    if (priority !== undefined) updates.priority = priority;

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update');
    }

    logger.info('[MODULE_SERVICE] Updating module', {
      id,
      updatedFields: Object.keys(updates),
    });

    const { data, error } = await supabaseAdmin
      .from('test_modules')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*, test_platforms!inner(platform_key)')
      .single();

    if (error) {
      logger.error('[MODULE_SERVICE] Failed to update module', { error, id });
      throw new Error(`Failed to update module: ${error.message}`);
    }

    return this.mapToTestModule(data);
  }

  /**
   * Delete a module
   * @param id - Module ID
   * @param userId - User ID for access control
   * @returns True if deleted
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[MODULE_SERVICE] Deleting module', { id });

    const { error } = await supabaseAdmin
      .from('test_modules')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('[MODULE_SERVICE] Failed to delete module', { error, id });
      throw new Error(`Failed to delete module: ${error.message}`);
    }

    return true;
  }

  /**
   * Map database row to TestModule type
   * Includes platformKey from joined test_platforms if available
   */
  private static mapToTestModule(row: any): TestModule {
    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      platformId: row.platform_id,
      platformKey: row.test_platforms?.platform_key || undefined,
      name: row.name,
      description: row.description || undefined,
      tags: row.tags || [],
      priority: row.priority || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
