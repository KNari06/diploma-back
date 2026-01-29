/**
 * Fixture Service
 * CRUD operations for test fixtures
 */

import { supabaseAdmin } from '@/db/supabase';
import type {
    CreateTestFixtureParams,
    FixtureScope,
    TestFixture,
    UpdateTestFixtureParams,
} from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

/**
 * Service for managing test fixtures
 * Fixtures represent reusable test data (users, cards, addresses)
 */
export class FixtureService {
  /**
   * Create a new test fixture
   * @param params - Fixture creation parameters
   * @returns Created fixture
   */
  static async create(params: CreateTestFixtureParams): Promise<TestFixture> {
    const { projectId, userId, name, description, data, scope, moduleId, tags } = params;

    logger.info('[FIXTURE_SERVICE] Creating fixture', {
      projectId,
      userId,
      name,
      scope: scope || 'project',
    });

    const { data: result, error } = await supabaseAdmin
      .from('test_fixtures')
      .insert({
        project_id: projectId,
        user_id: userId,
        name,
        description: description || null,
        data,
        scope: scope || 'project',
        module_id: moduleId || null,
        tags: tags || [],
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[FIXTURE_SERVICE] Failed to create fixture', { error });
      throw new Error(`Failed to create fixture: ${error.message}`);
    }

    return this.mapToTestFixture(result);
  }

  /**
   * Get a fixture by ID
   * @param id - Fixture ID
   * @param userId - User ID for access control
   * @returns Fixture or null if not found
   */
  static async getById(id: string, userId: string): Promise<TestFixture | null> {
    const { data, error } = await supabaseAdmin
      .from('test_fixtures')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('[FIXTURE_SERVICE] Failed to get fixture', { error, id });
      throw new Error(`Failed to get fixture: ${error.message}`);
    }

    return this.mapToTestFixture(data);
  }

  /**
   * List fixtures for a project
   * @param projectId - Project ID
   * @param userId - User ID for access control
   * @param scope - Optional scope filter
   * @returns List of fixtures
   */
  static async listByProject(
    projectId: string,
    userId: string,
    scope?: FixtureScope
  ): Promise<TestFixture[]> {
    let query = supabaseAdmin
      .from('test_fixtures')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (scope) {
      query = query.eq('scope', scope);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('[FIXTURE_SERVICE] Failed to list fixtures', { error, projectId });
      throw new Error(`Failed to list fixtures: ${error.message}`);
    }

    return (data || []).map(this.mapToTestFixture);
  }

  /**
   * Update a fixture
   * @param params - Update parameters
   * @returns Updated fixture
   */
  static async update(params: UpdateTestFixtureParams): Promise<TestFixture> {
    const { id, userId, name, description, data, scope, moduleId, tags } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (data !== undefined) updates.data = data;
    if (scope !== undefined) updates.scope = scope;
    if (moduleId !== undefined) updates.module_id = moduleId;
    if (tags !== undefined) updates.tags = tags;

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update');
    }

    logger.info('[FIXTURE_SERVICE] Updating fixture', {
      id,
      updatedFields: Object.keys(updates),
    });

    const { data: result, error } = await supabaseAdmin
      .from('test_fixtures')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) {
      logger.error('[FIXTURE_SERVICE] Failed to update fixture', { error, id });
      throw new Error(`Failed to update fixture: ${error.message}`);
    }

    return this.mapToTestFixture(result);
  }

  /**
   * Delete a fixture
   * @param id - Fixture ID
   * @param userId - User ID for access control
   * @returns True if deleted
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[FIXTURE_SERVICE] Deleting fixture', { id });

    const { error } = await supabaseAdmin
      .from('test_fixtures')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('[FIXTURE_SERVICE] Failed to delete fixture', { error, id });
      throw new Error(`Failed to delete fixture: ${error.message}`);
    }

    return true;
  }

  /**
   * Map database row to TestFixture type
   */
  private static mapToTestFixture(row: any): TestFixture {
    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      name: row.name,
      description: row.description || undefined,
      data: row.data,
      scope: row.scope,
      moduleId: row.module_id || undefined,
      tags: row.tags || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
