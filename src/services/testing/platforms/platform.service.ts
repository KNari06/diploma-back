/**
 * Platform Service
 * CRUD operations for test platforms
 */

import { supabaseAdmin } from '@/db/supabase';
import type {
  CreateTestPlatformParams,
  PlatformKey,
  TestPlatform,
} from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';

/**
 * Service for managing test platforms
 * Platforms represent top-level test categories (Web UI tests / API tests)
 */
export class PlatformService {
  /**
   * Get all platforms for a project
   * @param projectId - Project ID
   * @param userId - User ID for access control
   * @returns List of platforms (typically 2: web_ui and api)
   */
  static async listByProject(
    projectId: string,
    userId: string
  ): Promise<TestPlatform[]> {
    const { data, error } = await supabaseAdmin
      .from('test_platforms')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('platform_key', { ascending: true });

    if (error) {
      logger.error('[PLATFORM_SERVICE] Failed to list platforms', { error, projectId });
      throw new Error(`Failed to list platforms: ${error.message}`);
    }

    return (data || []).map(this.mapToTestPlatform);
  }

  /**
   * Get a platform by key for a project
   * @param projectId - Project ID
   * @param userId - User ID for access control
   * @param platformKey - Platform key (web_ui or api)
   * @returns Platform or null if not found
   */
  static async getByKey(
    projectId: string,
    userId: string,
    platformKey: PlatformKey
  ): Promise<TestPlatform | null> {
    const { data, error } = await supabaseAdmin
      .from('test_platforms')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .eq('platform_key', platformKey)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('[PLATFORM_SERVICE] Failed to get platform', { error, projectId, platformKey });
      throw new Error(`Failed to get platform: ${error.message}`);
    }

    return this.mapToTestPlatform(data);
  }

  /**
   * Get a platform by ID
   * @param id - Platform ID
   * @param userId - User ID for access control
   * @returns Platform or null if not found
   */
  static async getById(id: string, userId: string): Promise<TestPlatform | null> {
    const { data, error } = await supabaseAdmin
      .from('test_platforms')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('[PLATFORM_SERVICE] Failed to get platform by ID', { error, id });
      throw new Error(`Failed to get platform: ${error.message}`);
    }

    return this.mapToTestPlatform(data);
  }

  /**
   * Ensure all platforms exist for a project (seed if missing)
   * Called when creating first module or on project setup
   * @param projectId - Project ID
   * @param userId - User ID
   * @returns Object with web_ui, api, and mobile platform IDs
   */
  static async ensurePlatformsExist(
    projectId: string,
    userId: string
  ): Promise<{ webUi: TestPlatform; api: TestPlatform; mobile: TestPlatform }> {
    // Try to get existing platforms
    const existing = await this.listByProject(projectId, userId);

    let webUi = existing.find(p => p.platformKey === 'web_ui');
    let api = existing.find(p => p.platformKey === 'api');
    let mobile = existing.find(p => p.platformKey === 'mobile');

    // Create missing platforms
    if (!webUi) {
      webUi = await this.create({
        projectId,
        userId,
        platformKey: 'web_ui',
        name: 'Web UI tests',
        description: 'Web UI/UX test modules',
      });
    }

    if (!api) {
      api = await this.create({
        projectId,
        userId,
        platformKey: 'api',
        name: 'API tests',
        description: 'API test modules',
      });
    }

    if (!mobile) {
      mobile = await this.create({
        projectId,
        userId,
        platformKey: 'mobile',
        name: 'Mobile UI tests',
        description: 'Mobile UI test modules',
      });
    }

    return { webUi, api, mobile };
  }

  /**
   * Create a new platform (internal use, typically auto-seeded)
   * @param params - Platform creation parameters
   * @returns Created platform
   */
  static async create(params: CreateTestPlatformParams): Promise<TestPlatform> {
    const { projectId, userId, platformKey, name, description } = params;

    logger.info('[PLATFORM_SERVICE] Creating platform', {
      projectId,
      userId,
      platformKey,
    });

    const { data, error } = await supabaseAdmin
      .from('test_platforms')
      .insert({
        project_id: projectId,
        user_id: userId,
        platform_key: platformKey,
        name,
        description: description || null,
      })
      .select('*')
      .single();

    if (error) {
      // Handle duplicate key gracefully
      if (error.code === '23505') {
        logger.info('[PLATFORM_SERVICE] Platform already exists, fetching', { projectId, platformKey });
        const existing = await this.getByKey(projectId, userId, platformKey);
        if (existing) return existing;
      }
      logger.error('[PLATFORM_SERVICE] Failed to create platform', { error });
      throw new Error(`Failed to create platform: ${error.message}`);
    }

    // Invalidate platform tree cache
    await cache.delByPattern(`qait:cache:ptree:base:${projectId}:*`);

    return this.mapToTestPlatform(data);
  }

  /**
   * Update platform metadata (name, description)
   * @param id - Platform ID
   * @param userId - User ID for access control
   * @param updates - Fields to update
   * @returns Updated platform
   */
  static async update(
    id: string,
    userId: string,
    updates: { name?: string; description?: string }
  ): Promise<TestPlatform> {
    const updateFields: Record<string, any> = {};
    if (updates.name !== undefined) updateFields.name = updates.name;
    if (updates.description !== undefined) updateFields.description = updates.description;

    if (Object.keys(updateFields).length === 0) {
      throw new Error('No fields to update');
    }

    logger.info('[PLATFORM_SERVICE] Updating platform', { id, updates: Object.keys(updateFields) });

    const { data, error } = await supabaseAdmin
      .from('test_platforms')
      .update(updateFields)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) {
      logger.error('[PLATFORM_SERVICE] Failed to update platform', { error, id });
      throw new Error(`Failed to update platform: ${error.message}`);
    }

    // Invalidate platform tree cache
    if (data?.project_id) {
      await cache.delByPattern(`qait:cache:ptree:base:${data.project_id}:*`);
    }

    return this.mapToTestPlatform(data);
  }

  /**
   * Map database row to TestPlatform type
   */
  private static mapToTestPlatform(row: any): TestPlatform {
    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      platformKey: row.platform_key,
      name: row.name,
      description: row.description || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
