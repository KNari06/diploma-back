/**
 * Intent Test Case Service
 * CRUD operations for user-authored intent-based test cases
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import type { IntentStep, IntentTestCase } from './preview.types';

/**
 * Service for managing intent test cases
 */
export class IntentTestCaseService {
  /**
   * Create a new intent test case
   */
  static async create(params: {
    projectId: string;
    userId: string;
    name: string;
    description?: string;
    startUrl: string;
    steps: IntentStep[];
    flowId?: string;
    savedTestCaseId?: string;
  }): Promise<IntentTestCase> {
    const { projectId, userId, name, description, startUrl, steps, flowId, savedTestCaseId } = params;

    logger.info('[INTENT_TEST_CASE] Creating test case', {
      projectId,
      userId,
      name,
      stepsCount: steps.length,
      flowId,
      savedTestCaseId,
    });

    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .insert({
        project_id: projectId,
        user_id: userId,
        name,
        description: description || null,
        start_url: startUrl,
        steps_json: steps,
        flow_id: flowId || null,
        saved_test_case_id: savedTestCaseId || null,
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[INTENT_TEST_CASE] Failed to create', { error });
      throw new Error(`Failed to create test case: ${error.message}`);
    }

    return this.mapToIntentTestCase(data);
  }

  /**
   * Get a test case by ID
   */
  static async getById(id: string, userId: string): Promise<IntentTestCase | null> {
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      logger.error('[INTENT_TEST_CASE] Failed to get by ID', { error, id });
      throw new Error(`Failed to get test case: ${error.message}`);
    }

    return this.mapToIntentTestCase(data);
  }

  /**
   * List test cases for a project
   */
  static async listByProject(params: {
    projectId: string;
    userId: string;
    flowId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: IntentTestCase[]; total: number }> {
    const { projectId, userId, flowId, limit = 50, offset = 0 } = params;

    // Build base query
    let countQuery = supabaseAdmin
      .from('intent_test_cases')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('user_id', userId);

    let dataQuery = supabaseAdmin
      .from('intent_test_cases')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId);

    // Add optional flowId filter
    if (flowId) {
      countQuery = countQuery.eq('flow_id', flowId);
      dataQuery = dataQuery.eq('flow_id', flowId);
    }

    // Get total count
    const { count, error: countError } = await countQuery;

    if (countError) {
      logger.error('[INTENT_TEST_CASE] Failed to count', { error: countError });
      throw new Error(`Failed to list test cases: ${countError.message}`);
    }

    // Get items
    const { data, error } = await dataQuery
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('[INTENT_TEST_CASE] Failed to list', { error });
      throw new Error(`Failed to list test cases: ${error.message}`);
    }

    return {
      items: (data || []).map(this.mapToIntentTestCase),
      total: count || 0,
    };
  }

  /**
   * Update a test case
   */
  static async update(params: {
    id: string;
    userId: string;
    name?: string;
    description?: string;
    startUrl?: string;
    steps?: IntentStep[];
    flowId?: string;
    savedTestCaseId?: string;
  }): Promise<IntentTestCase> {
    const { id, userId, name, description, startUrl, steps, flowId, savedTestCaseId } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (startUrl !== undefined) updates.start_url = startUrl;
    if (steps !== undefined) updates.steps_json = steps;
    if (flowId !== undefined) updates.flow_id = flowId;
    if (savedTestCaseId !== undefined) updates.saved_test_case_id = savedTestCaseId;

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update');
    }

    logger.info('[INTENT_TEST_CASE] Updating test case', {
      id,
      updatedFields: Object.keys(updates),
    });

    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) {
      logger.error('[INTENT_TEST_CASE] Failed to update', { error, id });
      throw new Error(`Failed to update test case: ${error.message}`);
    }

    return this.mapToIntentTestCase(data);
  }

  /**
   * Delete a test case
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[INTENT_TEST_CASE] Deleting test case', { id });

    const { error } = await supabaseAdmin
      .from('intent_test_cases')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('[INTENT_TEST_CASE] Failed to delete', { error, id });
      throw new Error(`Failed to delete test case: ${error.message}`);
    }

    return true;
  }

  /**
   * Map database row to IntentTestCase type
   */
  private static mapToIntentTestCase(row: any): IntentTestCase {
    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      name: row.name,
      description: row.description || undefined,
      startUrl: row.start_url,
      stepsJson: row.steps_json || [],
      flowId: row.flow_id || undefined,
      savedTestCaseId: row.saved_test_case_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
