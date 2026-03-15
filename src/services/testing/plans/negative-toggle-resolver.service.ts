import { supabaseAdmin } from '@/db/supabase';
import type { ExpandedTestCase, NegativeMeta } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

/**
 * Resolves negative testing toggle inheritance for regression plan items.
 *
 * Inheritance chain: test_case item → parent flow item → parent module item.
 * null = inherit from parent, true/false = explicit override.
 * Default (all null) = disabled.
 */
export class NegativeToggleResolverService {
  /**
   * Resolve whether negative testing is enabled for a specific test case in a plan.
   */
  static async resolveForTestCase(
    planId: string,
    testCaseId: string,
    flowId?: string,
    moduleId?: string,
  ): Promise<boolean> {
    // Fetch all plan items for this plan in one query
    const { data: items } = await supabaseAdmin
      .from('regression_plan_items')
      .select('item_type, test_case_id, flow_id, module_id, negative_testing_enabled')
      .eq('plan_id', planId);

    if (!items || items.length === 0) return false;

    // 1. Check test_case-level item
    // null means "inherit from parent"; true/false are explicit overrides.
    const testCaseItem = items.find(
      (i) => i.item_type === 'test_case' && i.test_case_id === testCaseId,
    );
    if (testCaseItem != null && testCaseItem.negative_testing_enabled !== null) {
      return testCaseItem.negative_testing_enabled;
    }

    // 2. Check flow-level item
    if (flowId) {
      const flowItem = items.find(
        (i) => i.item_type === 'flow' && i.flow_id === flowId,
      );
      if (flowItem != null && flowItem.negative_testing_enabled !== null) {
        return flowItem.negative_testing_enabled;
      }
    }

    // 3. Check module-level item
    if (moduleId) {
      const moduleItem = items.find(
        (i) => i.item_type === 'module' && i.module_id === moduleId,
      );
      if (moduleItem != null && moduleItem.negative_testing_enabled !== null) {
        return moduleItem.negative_testing_enabled;
      }
    }

    // Default: disabled
    return false;
  }

  /**
   * Batch-resolve toggle for all test cases in a plan and return
   * their negative test cases as ExpandedTestCase[].
   */
  static async expandNegatives(
    planId: string,
    positiveTestCases: ExpandedTestCase[],
  ): Promise<ExpandedTestCase[]> {
    if (positiveTestCases.length === 0) return [];

    // Fetch all plan items once
    const { data: planItems } = await supabaseAdmin
      .from('regression_plan_items')
      .select('item_type, test_case_id, flow_id, module_id, negative_testing_enabled')
      .eq('plan_id', planId);

    if (!planItems || planItems.length === 0) return [];

    // Determine which test cases have negatives enabled
    const enabledTestCaseIds: string[] = [];
    for (const tc of positiveTestCases) {
      // Skip API tests — negative testing only applies to UI
      if (tc.testType !== 'ui') continue;

      const enabled = this.resolveFromItems(
        planItems,
        tc.testCaseId,
        tc.flowId,
        tc.moduleId,
      );
      if (enabled) {
        enabledTestCaseIds.push(tc.testCaseId);
      }
    }

    if (enabledTestCaseIds.length === 0) return [];

    // Fetch negative test cases for enabled parents (only fresh ones)
    const { data: negatives, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, flow_id, source_intent_test_case_id, negative_meta')
      .eq('is_negative', true)
      .is('negative_stale_reason', null)
      .in('source_intent_test_case_id', enabledTestCaseIds);

    if (error) {
      logger.error('[NEGATIVE_TOGGLE] Failed to fetch negative test cases', { error: error.message });
      return [];
    }

    if (!negatives || negatives.length === 0) return [];

    // Build parent lookup for moduleId/flowId
    const parentMap = new Map<string, ExpandedTestCase>();
    for (const tc of positiveTestCases) {
      parentMap.set(tc.testCaseId, tc);
    }

    // Map to ExpandedTestCase
    return negatives.map((neg) => {
      const parent = parentMap.get(neg.source_intent_test_case_id);
      return {
        testCaseId: neg.id,
        testType: 'ui' as const,
        moduleId: parent?.moduleId,
        flowId: neg.flow_id || parent?.flowId,
        name: neg.name,
        isNegative: true,
        sourceTestCaseId: neg.source_intent_test_case_id,
        negativeMeta: neg.negative_meta as NegativeMeta | undefined,
      };
    });
  }

  /**
   * Resolve toggle from pre-fetched plan items (no DB call).
   */
  private static resolveFromItems(
    items: Array<{
      item_type: string;
      test_case_id: string | null;
      flow_id: string | null;
      module_id: string | null;
      negative_testing_enabled: boolean | null;
    }>,
    testCaseId: string,
    flowId?: string,
    moduleId?: string,
  ): boolean {
    // 1. Test case level — null means inherit, true/false are explicit overrides
    const tcItem = items.find(
      (i) => i.item_type === 'test_case' && i.test_case_id === testCaseId,
    );
    if (tcItem != null && tcItem.negative_testing_enabled !== null) {
      return tcItem.negative_testing_enabled;
    }

    // 2. Flow level
    if (flowId) {
      const flowItem = items.find(
        (i) => i.item_type === 'flow' && i.flow_id === flowId,
      );
      if (flowItem != null && flowItem.negative_testing_enabled !== null) {
        return flowItem.negative_testing_enabled;
      }
    }

    // 3. Module level
    if (moduleId) {
      const moduleItem = items.find(
        (i) => i.item_type === 'module' && i.module_id === moduleId,
      );
      if (moduleItem != null && moduleItem.negative_testing_enabled !== null) {
        return moduleItem.negative_testing_enabled;
      }
    }

    return false;
  }

  /**
   * List which test cases in a plan have negative testing effectively enabled.
   * Used by the generation job to know what to generate.
   */
  static async getEnabledTestCaseIds(
    planId: string,
  ): Promise<string[]> {
    // Get plan items
    const { data: planItems, error: planItemsError } = await supabaseAdmin
      .from('regression_plan_items')
      .select('item_type, test_case_id, flow_id, module_id, negative_testing_enabled')
      .eq('plan_id', planId);

    if (planItemsError) {
      logger.error('[NEGATIVE_TOGGLE] Failed to fetch plan items for getEnabledTestCaseIds', {
        planId,
        error: planItemsError.message,
      });
      return [];
    }

    if (!planItems) return [];

    // Expand plan to get all test cases
    let expanded: import('@/types/testing.types').ExpandedTestCase[];
    try {
      const { RegressionPlanService } = await import('./regression-plan.service');
      expanded = await RegressionPlanService.expandPlan(planId);
    } catch (err) {
      logger.error('[NEGATIVE_TOGGLE] Failed to expand plan in getEnabledTestCaseIds', {
        planId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const enabled: string[] = [];
    for (const tc of expanded) {
      if (tc.testType !== 'ui') continue;
      if (tc.isNegative) continue; // Skip negatives themselves
      const isEnabled = this.resolveFromItems(planItems, tc.testCaseId, tc.flowId, tc.moduleId);
      if (isEnabled) {
        enabled.push(tc.testCaseId);
      }
    }

    return enabled;
  }
}
