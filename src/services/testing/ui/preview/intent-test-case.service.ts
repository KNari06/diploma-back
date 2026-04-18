/**
 * Intent Test Case Service
 * CRUD operations for user-authored intent-based test cases
 * V2: Added step-level updates for runtime heal persistence
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { COMMAND_EXECUTOR_CONFIG } from '@/config/testing/playwright-tuning';
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
    platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
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

    // Auto-attach workspace-configured resources (Login, Environment, etc)
    // that match the test's scope. Fulfils the "use for all new tests on
    // this site" UX promise set when the user created the resource.
    // Best-effort — if lookup fails, we still create the test without
    // bindings; user can attach manually.
    //
    // mobile_flutter is intentionally skipped — no resource adapter
    // supports it yet; enriching with a web/android fallback would
    // silently bind the wrong profile.
    let resourceBindings: Array<{ kind: string; resource_id: string; required?: boolean }> = [];
    const scopePlatform: 'web' | 'android' | 'ios' | null =
      platform === 'web'
        ? 'web'
        : platform === 'mobile_android'
          ? 'android'
          : platform === 'mobile_ios'
            ? 'ios'
            : null;
    if (scopePlatform !== null) {
      try {
        const { enrichBindingsWithDefaults } = await import('@/services/test-resource/test-resource.service');
        resourceBindings = (await enrichBindingsWithDefaults({
          userId,
          projectId,
          bindings: [],
          scope: {
            platform: scopePlatform,
            url: startUrl ?? null,
          },
        })) as Array<{ kind: string; resource_id: string; required?: boolean }>;
      } catch (enrichErr) {
        logger.warn('[INTENT_TEST_CASE] enrichBindingsWithDefaults failed (non-fatal)', {
          error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
        });
      }
    }

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
        resource_bindings: resourceBindings,
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
    // Serialize concurrent writes to the same test case via the same in-process
    // mutex used by updateStepFromPreviewApply / updateStepAfterHeal /
    // batchUpdateStepsFromRun. Without it, a manual Save issued during an
    // in-flight auto-persist could race and overwrite compiled/evidence fields
    // that the runner just wrote. No reentrancy risk — none of the already-
    // mutex'd methods call update() internally.
    return withTestCaseMutex(params.id, async () => {
      const { id, userId, name, description, startUrl, url, steps, flowId, status, kind, tags, priority } = params;

      const updates: Record<string, any> = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (startUrl !== undefined) updates.start_url = startUrl;
      if (url !== undefined) updates.url = url;
      if (steps !== undefined) {
        let mergedSteps = this.normalizeSteps(steps);

        // V16: Merge compiled/evidence/bindingHints from DB for steps that don't include them.
        // Frontend state often lacks these backend-generated fields (compiled plans from apply/run,
        // evidence from execution). Without this merge, any PATCH that includes steps (reorder,
        // rename, add step) would wipe compiled plans and force LLM fallback on next background run.
        const hasStepsMissingBackendFields = mergedSteps.some(s =>
          !s.compiled || !s.evidence
        );

        if (hasStepsMissingBackendFields) {
          try {
            const { data: existingRow } = await supabaseAdmin
              .from('intent_test_cases')
              .select('steps_json')
              .eq('id', id)
              .single();

            if (existingRow?.steps_json) {
              const existingById = new Map<string, IntentStep>();
              for (const existing of existingRow.steps_json as IntentStep[]) {
                existingById.set(existing.id, existing);
              }

              let preserved = 0;
              mergedSteps = mergedSteps.map(step => {
                const existing = existingById.get(step.id);
                if (!existing) return step;

                let changed = false;
                const merged = { ...step };

                if (!step.compiled && existing.compiled) {
                  merged.compiled = existing.compiled;
                  changed = true;
                }
                if (!step.evidence && existing.evidence) {
                  merged.evidence = existing.evidence;
                  changed = true;
                }
                if (!step.bindingHints && existing.bindingHints) {
                  merged.bindingHints = existing.bindingHints;
                  changed = true;
                }

                if (changed) preserved++;
                return merged;
              });

              if (preserved > 0) {
                logger.info('[INTENT_TEST_CASE] Preserved backend fields from DB during update', {
                  id,
                  preservedCount: preserved,
                  totalSteps: mergedSteps.length,
                });
              }
            }
          } catch (mergeError) {
            logger.warn('[INTENT_TEST_CASE] Failed to merge backend fields (non-fatal, saving as-is)', {
              id,
              error: mergeError instanceof Error ? mergeError.message : String(mergeError),
            });
          }
        }

        updates.steps_json = mergedSteps;
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
    });
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
      goal: row.goal || undefined,
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

      // Track heal count for flakiness detection
      const currentHealCount = steps[stepIndex].evidence?.healCount || 0;
      const newHealCount = currentHealCount + 1;
      const needsReview = newHealCount >= COMMAND_EXECUTOR_CONFIG.healCountReviewThreshold;

      if (needsReview) {
        logger.warn('[INTENT_TEST_CASE] Step healed multiple times — flagged for review', {
          intentTestCaseId, stepId, healCount: newHealCount,
        });
      }

      steps[stepIndex] = {
        ...steps[stepIndex],
        compiled: mergedCompiled,
        evidence: {
          ...steps[stepIndex].evidence,
          ...evidence,
          healCount: newHealCount,
          lastHealedAt: new Date().toISOString(),
          needsReview: needsReview || steps[stepIndex].evidence?.needsReview,
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
          // V16: Step not yet in DB (manually added on frontend, applied before Save).
          // Append to preserve compiled/evidence — the next PATCH from frontend will
          // merge via the V16 merge logic in update(), keeping compiled intact.
          logger.info('[INTENT_TEST_CASE] Step not in DB yet, appending from preview apply', {
            intentTestCaseId,
            stepId: appliedStep.id,
            hasCompiled: !!appliedStep.compiled,
          });
          steps.push(appliedStep);
        } else {
          // Replace the step entirely with appliedStep
          steps[stepIndex] = appliedStep;
        }

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
