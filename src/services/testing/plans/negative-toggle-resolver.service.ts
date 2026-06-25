import type { ExpandedTestCase, NegativeMeta } from '@/types/testing.types';
import * as negativeDb from '@/services/testing/negative/db/negative.db';
import type { PlanItemToggleRow } from '@/services/testing/negative/db/negative.db';
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
    const items = await negativeDb.getPlanItemsForToggle(planId);
    if (items.length === 0) return false;
    return this.resolveFromItems(items, testCaseId, flowId, moduleId);
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
    const planItems = await negativeDb.getPlanItemsForToggle(planId);
    if (planItems.length === 0) return [];

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
    const negatives = await negativeDb.getFreshNegativesBySources(enabledTestCaseIds);
    if (negatives.length === 0) return [];

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
        // Inherit the parent's platform so a mobile source's negatives route to
        // the mobile runner. Without it the negative has no platform and the
        // orchestrator's `platform?.startsWith('mobile_')` check dispatches it
        // as web — it then fails on a fresh browser instead of the device.
        platform: parent?.platform,
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
    items: PlanItemToggleRow[],
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
    const planItems = await negativeDb.getPlanItemsForToggle(planId);
    if (planItems.length === 0) return [];

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
