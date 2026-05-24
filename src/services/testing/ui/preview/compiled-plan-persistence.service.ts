import { logger } from '@/utils/core/logger';
import { IntentTestCaseService } from './intent-test-case.service';
import type { MobileIntentStep, MobileRunStepsResponse } from '@/services/mobile/mobile-runner.types';
import type { IntentStep } from './preview.types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COMPILED PLAN PERSISTENCE SERVICE
 *
 * Extracted from MobileTestRunJobHandler (Phase 2-A refactor).
 * Merges runner-emitted compiledPlan artifacts back into
 * `intent_test_cases.steps_json` so subsequent runs benefit from
 * pre-resolved element plans (fast path).
 * ═══════════════════════════════════════════════════════════════════════════
 */
export class CompiledPlanPersistenceService {
  /**
   * Persist compiled plans from a completed mobile run back to `intent_test_cases`.
   *
   * @param intentTestCaseId - `intent_test_cases.id` (NOT `tests.id`).
   *   Pass `undefined` for chat-dispatch paths that don't carry a test-case PK.
   * @param intentSteps - The steps that were dispatched (pre-parameter-substitution originals).
   * @param runResult - Runner's `RunStepsResult` containing per-step compiled plans.
   */
  static async persistFromRun(
    intentTestCaseId: string | undefined,
    intentSteps: MobileIntentStep[],
    runResult: MobileRunStepsResponse,
  ): Promise<void> {
    if (!runResult?.steps?.length) return;
    // intentTestCaseId is the `intent_test_cases.id` (NOT `tests.id`).
    // The chat dispatch path doesn't populate it yet, in which case we
    // skip the persist — without the test-case PK there's nothing to
    // merge into. Regression and editor paths always pass it.
    if (!intentTestCaseId) {
      logger.debug('[MOBILE-TEST] Skipping compiled-plan persist — no intent_test_cases.id provided', {
        runStepsCount: runResult.steps.length,
      });
      return;
    }

    try {
      const originalById = new Map<string, MobileIntentStep>();
      for (const s of intentSteps) originalById.set(s.id, s);

      const enrichedSteps = new Map<string, IntentStep>();

      // resolvedVia values that mean "this plan was already proven against
      // the current tree before the run started". Safe to persist on failure
      // because the plan is independently validated.
      const PROVEN_RESOLVED_VIA = new Set<string>(['compiled', 'compiled_fast_path', 'cache']);

      for (const result of runResult.steps) {
        if (!result.compiledPlan) continue;
        // Runner can flag a plan as stale post-dispatch (VTE caught text in
        // wrong field, or foreground mismatch with no relaunch). Skip
        // persistence — the plan is "successful at dispatch level" but
        // points at the wrong element. Saving it locks in the bug.
        if (result.planStaleReason) {
          logger.debug('[MOBILE-TEST] Skipping plan persist — runner flagged stale', {
            stepId: result.stepId,
            reason: result.planStaleReason,
          });
          continue;
        }
        const planIsProven =
          result.resolvedVia !== undefined && PROVEN_RESOLVED_VIA.has(result.resolvedVia);
        if (!result.success && !planIsProven) continue;
        const original = originalById.get(result.stepId);
        if (!original) continue;

        // Start from the original step to preserve user-supplied fields
        // (description, value, options, assertionText, bindingHints, etc.),
        // then overlay runner-emitted artifacts. Cast is safe because
        // IntentStep is the structural superset used across web and mobile.
        const enriched: IntentStep = {
          ...(original as unknown as IntentStep),
          compiled: result.compiledPlan as unknown as IntentStep['compiled'],
        };

        if (result.evidence) {
          enriched.evidence = {
            ...(original as unknown as IntentStep).evidence,
            resolvedVia: result.resolvedVia,
            appliedAt: new Date().toISOString(),
            // Keep runner-collected logs/console/network errors under a
            // dedicated key so they don't collide with web StepEvidence fields.
            runtime: result.evidence,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any;
        }

        enrichedSteps.set(result.stepId, enriched);
      }

      if (enrichedSteps.size === 0) {
        logger.debug('[MOBILE-TEST] No compiled plans to persist', { intentTestCaseId });
        return;
      }

      const ok = await IntentTestCaseService.batchUpdateStepsFromRun({
        intentTestCaseId,
        enrichedSteps,
      });

      if (ok) {
        logger.info('[MOBILE-TEST] Persisted compiled plans from run', {
          intentTestCaseId,
          persistedCount: enrichedSteps.size,
          totalSteps: runResult.steps.length,
        });
      }
    } catch (error) {
      // Non-fatal: run already succeeded, test_results will still be created.
      logger.warn('[MOBILE-TEST] Failed to persist compiled plans (non-fatal)', {
        intentTestCaseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
