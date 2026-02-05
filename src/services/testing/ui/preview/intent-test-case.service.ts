/**
 * Intent Test Case Service
 * CRUD operations for user-authored intent-based test cases
 * V2: Added step-level updates for runtime heal persistence
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import type { CompiledStepPlan, IntentStep, IntentTestCase, StepEvidence } from './preview.types';
import { injectAutoWaitForSteps } from './auto-wait-for.utils';

/**
 * Service for managing intent test cases
 */
export class IntentTestCaseService {
  /**
   * Create a new intent test case
   * This is the unified table for UI test cases - both draft and published.
   */
  static async create(params: {
    projectId: string;
    userId: string;
    name: string;
    description?: string;
    startUrl?: string;
    steps: IntentStep[];
    flowId?: string;
    status?: 'draft' | 'published' | 'archived';
    kind?: 'standalone' | 'regression_member';
  }): Promise<IntentTestCase> {
    const { projectId, userId, name, description, startUrl, steps, flowId, status = 'draft', kind = 'standalone' } = params;

    logger.info('[INTENT_TEST_CASE] Creating test case', {
      projectId,
      userId,
      name,
      stepsCount: steps.length,
      flowId,
      status,
      kind,
    });

    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .insert({
        project_id: projectId,
        user_id: userId,
        name,
        description: description || null,
        start_url: startUrl || null,
        steps_json: this.normalizeSteps(steps),
        flow_id: flowId || null,
        status,
        kind,
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
   * Supports updating lifecycle status, kind, and other unified fields.
   */
  static async update(params: {
    id: string;
    userId: string;
    name?: string;
    description?: string;
    startUrl?: string | null;
    url?: string | null;
    steps?: IntentStep[];
    flowId?: string;
    status?: 'draft' | 'published' | 'archived';
    kind?: 'standalone' | 'regression_member';
    tags?: string[];
    priority?: 'critical' | 'high' | 'medium' | 'low';
  }): Promise<IntentTestCase> {
    const { id, userId, name, description, startUrl, url, steps, flowId, status, kind, tags, priority } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (startUrl !== undefined) updates.start_url = startUrl;
    if (url !== undefined) updates.url = url;
    if (steps !== undefined) updates.steps_json = this.normalizeSteps(steps);
    if (flowId !== undefined) updates.flow_id = flowId;
    if (status !== undefined) updates.status = status;
    if (kind !== undefined) updates.kind = kind;
    if (tags !== undefined) updates.tags = tags;
    if (priority !== undefined) updates.priority = priority;

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
   * Normalize legacy steps: replace 'fill' with 'type' (server-side migration)
   */
  private static normalizeSteps(steps: IntentStep[]): IntentStep[] {
    return steps.map(step => {
      if ((step.type as any) === 'fill') {
        return {
          ...step,
          type: 'type' as any,
        };
      }
      return step;
    });
  }

  /**
   * Map database row to IntentTestCase type
   * Supports all unified fields including status, kind, replay data, etc.
   */
  private static mapToIntentTestCase(row: any): IntentTestCase {
    // Normalize steps on read (migrate-on-read strategy)
    const stepsJson = this.normalizeSteps(row.steps_json || []);

    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      name: row.name,
      description: row.description || undefined,

      // URL fields
      startUrl: row.start_url || undefined,
      url: row.url || undefined,

      // Steps
      stepsJson,

      // Lifecycle
      status: row.status || 'draft',
      kind: row.kind || 'standalone',

      // Replay data
      replayStrategy: row.replay_strategy || undefined,
      commands: row.commands || undefined,
      graphRef: row.graph_ref || undefined,
      parametersSchema: row.parameters_schema || undefined,

      // Organization
      flowId: row.flow_id || undefined,
      dependsOn: row.depends_on || undefined,

      // Metadata
      tags: row.tags || undefined,
      priority: row.priority || undefined,
      preconditions: row.preconditions || undefined,
      setupSteps: row.setup_steps || undefined,
      teardownSteps: row.teardown_steps || undefined,
      expectedResult: row.expected_result || undefined,

      // Provenance
      sourceTestId: row.source_test_id || undefined,
      sourceIntelligentSessionId: row.source_intelligent_session_id || undefined,

      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Step-level updates for runtime heal persistence
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update a single step's compiled plan after successful high-confidence heal
   * Called from runtime when heal succeeds with confidence ≥ 0.9
   *
   * @param intentTestCaseId The test case ID
   * @param stepId The step ID within the test case
   * @param compiled New compiled plan from healed selector
   * @param evidence Updated evidence with new lastSuccessRef
   */
  static async updateStepAfterHeal(params: {
    intentTestCaseId: string;
    stepId: string;
    compiled: CompiledStepPlan;
    evidence: StepEvidence;
  }): Promise<boolean> {
    const { intentTestCaseId, stepId, compiled, evidence } = params;

    logger.info('[INTENT_TEST_CASE] Updating step after successful heal', {
      intentTestCaseId,
      stepId,
      newLocatorCount: compiled.locatorPlan?.length,
    });

    try {
      // Get current test case (without userId check - this is internal runtime call)
      const { data: row, error: fetchError } = await supabaseAdmin
        .from('intent_test_cases')
        .select('steps_json')
        .eq('id', intentTestCaseId)
        .single();

      if (fetchError || !row) {
        logger.warn('[INTENT_TEST_CASE] Test case not found for heal update', {
          intentTestCaseId,
          error: fetchError?.message,
        });
        return false;
      }

      const steps: IntentStep[] = row.steps_json || [];
      const stepIndex = steps.findIndex(s => s.id === stepId);

      if (stepIndex === -1) {
        logger.warn('[INTENT_TEST_CASE] Step not found for heal update', {
          intentTestCaseId,
          stepId,
        });
        return false;
      }

      // Update the step with new compiled and evidence
      // Merge compiled to preserve action and other fields if not provided
      const existingCompiled = steps[stepIndex].compiled;
      const mergedCompiled: CompiledStepPlan = {
        ...existingCompiled,
        ...compiled,
        // Ensure action is preserved
        action: compiled.action || existingCompiled?.action || { type: 'click' },
        // Merge context
        context: {
          ...existingCompiled?.context,
          ...compiled.context,
        },
        // Merge meta with required fields
        meta: compiled.meta || existingCompiled?.meta || {
          compiledVersion: '1.0.0',
          resolverVersion: '3.0.0',
        },
      };

      steps[stepIndex] = {
        ...steps[stepIndex],
        compiled: mergedCompiled,
        evidence: {
          ...steps[stepIndex].evidence,
          ...evidence,
        },
      };

      // Save back to DB
      const { error: updateError } = await supabaseAdmin
        .from('intent_test_cases')
        .update({ steps_json: steps })
        .eq('id', intentTestCaseId);

      if (updateError) {
        logger.error('[INTENT_TEST_CASE] Failed to update step after heal', {
          intentTestCaseId,
          stepId,
          error: updateError.message,
        });
        return false;
      }

      logger.info('[INTENT_TEST_CASE] Step updated after heal', {
        intentTestCaseId,
        stepId,
      });

      return true;
    } catch (error) {
      logger.error('[INTENT_TEST_CASE] Exception updating step after heal', {
        intentTestCaseId,
        stepId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Update a single step after successful preview apply
   * Replaces the step with appliedStep (which has compiled/evidence/bindingHints)
   *
   * @param intentTestCaseId The test case ID
   * @param appliedStep The full IntentStep from preview:step:apply:result
   */
  static async updateStepFromPreviewApply(params: {
    intentTestCaseId: string;
    appliedStep: IntentStep;
  }): Promise<boolean> {
    const { intentTestCaseId, appliedStep } = params;

    logger.info('[INTENT_TEST_CASE] Updating step from preview apply', {
      intentTestCaseId,
      stepId: appliedStep.id,
      hasCompiled: !!appliedStep.compiled,
      hasEvidence: !!appliedStep.evidence,
      hasBindingHints: !!appliedStep.bindingHints,
    });

    try {
      // Get current test case (without userId check - this is internal call from preview)
      const { data: row, error: fetchError } = await supabaseAdmin
        .from('intent_test_cases')
        .select('steps_json')
        .eq('id', intentTestCaseId)
        .single();

      if (fetchError || !row) {
        logger.warn('[INTENT_TEST_CASE] Test case not found for preview apply update', {
          intentTestCaseId,
          error: fetchError?.message,
        });
        return false;
      }

      const steps: IntentStep[] = row.steps_json || [];
      const stepIndex = steps.findIndex(s => s.id === appliedStep.id);

      if (stepIndex === -1) {
        logger.warn('[INTENT_TEST_CASE] Step not found for preview apply update', {
          intentTestCaseId,
          stepId: appliedStep.id,
        });
        return false;
      }

      // Replace the step entirely with appliedStep
      steps[stepIndex] = appliedStep;

      // V5: Auto-inject wait_for steps where navigation occurred
      // This ensures stability during background runs without requiring user to add waits manually
      const stepsWithAutoWaits = injectAutoWaitForSteps(steps);

      // Save back to DB
      const { error: updateError } = await supabaseAdmin
        .from('intent_test_cases')
        .update({
          steps_json: stepsWithAutoWaits,
          updated_at: new Date().toISOString(),
        })
        .eq('id', intentTestCaseId);

      if (updateError) {
        logger.error('[INTENT_TEST_CASE] Failed to update step from preview apply', {
          intentTestCaseId,
          stepId: appliedStep.id,
          error: updateError.message,
        });
        return false;
      }

      logger.info('[INTENT_TEST_CASE] Step updated from preview apply', {
        intentTestCaseId,
        stepId: appliedStep.id,
        locatorCount: appliedStep.compiled?.locatorPlan?.length,
      });

      return true;
    } catch (error) {
      logger.error('[INTENT_TEST_CASE] Exception updating step from preview apply', {
        intentTestCaseId,
        stepId: appliedStep.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Get test case by ID without user check (for internal runtime use)
   * Use with caution - only for system-level operations
   */
  static async getByIdInternal(id: string): Promise<IntentTestCase | null> {
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('[INTENT_TEST_CASE] Failed to get by ID (internal)', { error, id });
      return null;
    }

    return this.mapToIntentTestCase(data);
  }
}
