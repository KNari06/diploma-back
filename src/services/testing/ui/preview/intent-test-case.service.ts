/**
 * Intent Test Case Service
 * CRUD operations for user-authored intent-based test cases
 * V2: Added step-level updates for runtime heal persistence
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import type { CompiledStepPlan, IntentStep, IntentTestCase, StepEvidence } from './preview.types';
import { injectAutoWaitForSteps } from './auto-wait-for.utils';

// ═══════════════════════════════════════════════════════════════════════════
// Per-testCase in-memory mutex (prevents concurrent read-modify-write races)
// Pattern from flow-queue.ts / budget-tracker.ts
// ═══════════════════════════════════════════════════════════════════════════
const testCaseMutexes = new Map<string, Promise<void>>();

function withTestCaseMutex<T>(testCaseId: string, fn: () => Promise<T>): Promise<T> {
  const prev = testCaseMutexes.get(testCaseId) || Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  testCaseMutexes.set(testCaseId, next);
  return prev.then(fn).finally(() => {
    resolve!();
    // Clean up if this is the last waiter
    if (testCaseMutexes.get(testCaseId) === next) {
      testCaseMutexes.delete(testCaseId);
    }
  });
}

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
    platform?: 'web' | 'mobile_android' | 'mobile_ios';
  }): Promise<IntentTestCase> {
    const { projectId, userId, name, description, startUrl, steps, flowId, status = 'draft', kind = 'standalone', platform = 'web' } = params;

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
        platform,
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[INTENT_TEST_CASE] Failed to create', { error });
      throw new Error(`Failed to create test case: ${error.message}`);
    }

    // Invalidate flow mode cache (test case list changed)
    if (flowId) {
      await cache.delByPattern(`qait:cache:ptree:flow:${flowId}:*`);
    }

    return this.mapToIntentTestCase(data);
  }

  /**
   * Get a test case by ID
   */
  static async getById(id: string, userId: string): Promise<IntentTestCase | null> {
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('*, test_flows(name)')
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

    const item = this.mapToIntentTestCase(data);

    // Resolve dependency names in a single query
    if (item.dependsOn && item.dependsOn.length > 0) {
      const { data: depRows } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name')
        .in('id', item.dependsOn);

      item.resolvedDependencies = (item.dependsOn || []).map((depId) => {
        const dep = depRows?.find((r: any) => r.id === depId);
        return { id: depId, name: dep?.name || 'Unknown' };
      });
    }

    return item;
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

    // Build base query — join test_flows to get flow name
    let countQuery = supabaseAdmin
      .from('intent_test_cases')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('user_id', userId);

    let dataQuery = supabaseAdmin
      .from('intent_test_cases')
      .select('*, test_flows(name)')
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

    const items = (data || []).map((row) => this.mapToIntentTestCase(row));

    // Batch resolve dependency names
    const allDepIds = new Set<string>();
    for (const item of items) {
      for (const depId of item.dependsOn || []) {
        allDepIds.add(depId);
      }
    }

    if (allDepIds.size > 0) {
      const { data: depRows } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name')
        .in('id', [...allDepIds]);

      const depNameMap = new Map<string, string>();
      for (const row of depRows || []) {
        depNameMap.set(row.id, row.name);
      }

      for (const item of items) {
        if (item.dependsOn && item.dependsOn.length > 0) {
          item.resolvedDependencies = item.dependsOn
            .map((depId) => ({ id: depId, name: depNameMap.get(depId) || 'Unknown' }));
        }
      }
    }

    return { items, total: count || 0 };
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
    if (steps !== undefined) {
      updates.steps_json = this.normalizeSteps(steps);

      // V7: Log warning for targeting steps lacking compiled/evidence
      // This helps identify steps that may be unreliable in background runs
      const targetingActions = ['click', 'type', 'hover', 'select', 'check', 'uncheck'];
      const stepsWithoutCompiled = steps.filter(step => 
        targetingActions.includes(step.type) && (!step.compiled || !step.evidence)
      );

      if (stepsWithoutCompiled.length > 0) {
        logger.warn('[INTENT_TEST_CASE] Saving steps without compiled/evidence data', {
          id,
          stepsCount: steps.length,
          missingCount: stepsWithoutCompiled.length,
          missingSteps: stepsWithoutCompiled.map(s => ({
            stepId: s.id,
            type: s.type,
            description: s.description?.slice(0, 60),
            hasCompiled: !!s.compiled,
            hasEvidence: !!s.evidence,
          })),
        });
      }
    }
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

    // Invalidate flow mode cache
    if (data.flow_id) {
      await cache.delByPattern(`qait:cache:ptree:flow:${data.flow_id}:*`);
    }

    // Mark related negative test cases as stale when steps change
    if (steps !== undefined) {
      this.markNegativesStale(id).catch((err) => {
        logger.warn('[INTENT_TEST_CASE] Failed to mark negatives stale', {
          testCaseId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return this.mapToIntentTestCase(data);
  }

  /**
   * Delete a test case
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[INTENT_TEST_CASE] Deleting test case', { id });

    // Fetch flow_id and project_id before delete for cache invalidation
    const { data: tc } = await supabaseAdmin
      .from('intent_test_cases')
      .select('flow_id, project_id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();

    // Clean up regression plan items referencing this test case
    const { error: planCleanupError } = await supabaseAdmin
      .from('regression_plan_items')
      .delete()
      .eq('test_case_id', id);

    if (planCleanupError) {
      logger.warn('[INTENT_TEST_CASE] Failed to cleanup plan items for deleted test case', {
        error: planCleanupError, id,
      });
    }

    const { error } = await supabaseAdmin
      .from('intent_test_cases')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('[INTENT_TEST_CASE] Failed to delete', { error, id });
      throw new Error(`Failed to delete test case: ${error.message}`);
    }

    // Invalidate flow mode cache
    if (tc?.flow_id) {
      await cache.delByPattern(`qait:cache:ptree:flow:${tc.flow_id}:*`);
    }

    // Invalidate plans cache — deleting a test case removes its regression_plan_items as side-effect
    if (tc?.project_id) {
      await cache.delByPattern(`qait:cache:plans:proj:${tc.project_id}:*`);
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
      platform: row.platform || 'web',

      // Replay data
      replayStrategy: row.replay_strategy || undefined,
      commands: row.commands || undefined,
      graphRef: row.graph_ref || undefined,
      parametersSchema: row.parameters_schema || undefined,

      // Organization
      flowId: row.flow_id || undefined,
      flowName: row.test_flows?.name || undefined,
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
    return withTestCaseMutex(params.intentTestCaseId, async () => {
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
    }); // withTestCaseMutex
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
    return withTestCaseMutex(params.intentTestCaseId, async () => {
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

        // Note: auto-wait injection removed here (V8). Auto-waits are now injected:
        // 1. In batchUpdateStepsFromRun() — once after run completes
        // 2. In preview.controller.ts PATCH — when user saves via REST API
        // 3. In IntentTestCaseService.update() — when fully updating test case

        // Save back to DB
        const { error: updateError } = await supabaseAdmin
          .from('intent_test_cases')
          .update({
            steps_json: steps,
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
    });
  }

  /**
   * Batch-update multiple steps after a preview run completes.
   * Single read-modify-write cycle instead of N individual updates.
   * Auto-wait injection runs once on the final merged array.
   *
   * @param intentTestCaseId The test case ID
   * @param enrichedSteps Map of stepId → enriched IntentStep (with compiled/evidence/bindingHints)
   */
  static async batchUpdateStepsFromRun(params: {
    intentTestCaseId: string;
    enrichedSteps: Map<string, IntentStep>;
  }): Promise<boolean> {
    return withTestCaseMutex(params.intentTestCaseId, async () => {
      const { intentTestCaseId, enrichedSteps } = params;

      logger.info('[INTENT_TEST_CASE] Batch-updating steps from run', {
        intentTestCaseId,
        enrichedCount: enrichedSteps.size,
      });

      try {
        const { data: row, error: fetchError } = await supabaseAdmin
          .from('intent_test_cases')
          .select('steps_json')
          .eq('id', intentTestCaseId)
          .single();

        if (fetchError || !row) {
          logger.warn('[INTENT_TEST_CASE] Test case not found for batch update', {
            intentTestCaseId,
            error: fetchError?.message,
          });
          return false;
        }

        const steps: IntentStep[] = row.steps_json || [];
        let updated = 0;

        // Merge all enriched steps into the array
        for (let i = 0; i < steps.length; i++) {
          const enriched = enrichedSteps.get(steps[i].id);
          if (enriched) {
            steps[i] = enriched;
            updated++;
          }
        }

        if (updated === 0) {
          logger.debug('[INTENT_TEST_CASE] No steps to batch-update', { intentTestCaseId });
          return false;
        }

        // Single auto-wait injection pass on the final merged array
        const stepsWithAutoWaits = injectAutoWaitForSteps(steps);

        const { error: updateError } = await supabaseAdmin
          .from('intent_test_cases')
          .update({
            steps_json: stepsWithAutoWaits,
            updated_at: new Date().toISOString(),
          })
          .eq('id', intentTestCaseId);

        if (updateError) {
          logger.error('[INTENT_TEST_CASE] Failed to batch-update steps from run', {
            intentTestCaseId,
            error: updateError.message,
          });
          return false;
        }

        logger.info('[INTENT_TEST_CASE] Batch-updated steps from run', {
          intentTestCaseId,
          updatedCount: updated,
          totalSteps: stepsWithAutoWaits.length,
        });

        // Mark related negatives as stale (best-effort, non-blocking)
        this.markNegativesStale(intentTestCaseId).catch((err) => {
          logger.warn('[INTENT_TEST_CASE] Failed to mark negatives stale after batch update', {
            testCaseId: intentTestCaseId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        return true;
      } catch (error) {
        logger.error('[INTENT_TEST_CASE] Exception batch-updating steps from run', {
          intentTestCaseId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    });
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

  /**
   * Mark all negative test cases derived from a source test case as stale.
   * Called when the parent happy-path steps change.
   */
  private static async markNegativesStale(sourceTestCaseId: string): Promise<void> {
    const { error, count } = await supabaseAdmin
      .from('intent_test_cases')
      .update({
        negative_stale_reason: 'parent_steps_changed',
        updated_at: new Date().toISOString(),
      })
      .eq('source_intent_test_case_id', sourceTestCaseId)
      .eq('is_negative', true)
      .is('negative_stale_reason', null);

    if (error) {
      logger.warn('[INTENT_TEST_CASE] Failed to mark negatives stale', {
        sourceTestCaseId,
        error: error.message,
      });
      return;
    }

    if (count && count > 0) {
      logger.info('[INTENT_TEST_CASE] Marked negatives as stale', {
        sourceTestCaseId,
        staleCount: count,
      });
    }
  }
}
