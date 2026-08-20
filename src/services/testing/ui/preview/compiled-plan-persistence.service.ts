import { logger } from '@/utils/core/logger';
import { IntentTestCaseService } from './intent-test-case.service';
import type { MobileIntentStep, MobileRunStepsResponse } from '@/services/mobile/mobile-runner.types';
import { withExpectsTransition } from '@/services/mobile/expects-transition';
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
        // Runner can flag a plan as stale post-dispatch (VTE caught text in
        // wrong field, or foreground mismatch with no relaunch). Skip
        // persistence — the plan is "successful at dispatch level" but
        // points at the wrong element. Saving it locks in the bug.
        const planIsStale = !!result.planStaleReason;
        if (planIsStale) {
          logger.debug('[MOBILE-TEST] Skipping plan persist — runner flagged stale', {
            stepId: result.stepId,
            reason: result.planStaleReason,
          });
        }
        const planIsProven =
          result.resolvedVia !== undefined && PROVEN_RESOLVED_VIA.has(result.resolvedVia);
        const savePlan = !!result.compiledPlan && !planIsStale && (result.success || planIsProven);

        // "This step navigates", recorded from a run.
        //
        // Deliberately NOT gated on `result.compiledPlan`. A WebView tap returns
        // from `executeCommand` before the compiled-plan builder ever runs, so
        // it has no plan — and WebView taps are precisely the steps this signal
        // exists to protect. Gating on the plan would have armed everything
        // EXCEPT the case that motivated the feature.
        //
        // Recording from a regression run (not just an editor apply) is safe
        // because the write is one-way: `withExpectsTransition` only acts on a
        // `true`, and `true` means "the screen changed when this step ran and
        // passed" — positive evidence, whatever dispatched it. The direction
        // that would be unsafe is writing `false` from a run whose tap MISSED,
        // and nothing here can do that. See the ADR
        // `20260820-regression-runs-may-record-expects-transition.md`.
        const saveTransition = result.transitionDetected === true && result.success;

        if (!savePlan && !saveTransition) continue;
        const original = originalById.get(result.stepId);
        if (!original) continue;

        // Start from the original step to preserve user-supplied fields
        // (description, value, options, assertionText, bindingHints, etc.),
        // then overlay runner-emitted artifacts. Cast is safe because
        // IntentStep is the structural superset used across web and mobile.
        const enriched: IntentStep = {
          ...(original as unknown as IntentStep),
          ...(savePlan ? { compiled: result.compiledPlan as unknown as IntentStep['compiled'] } : {}),
        };

        if (saveTransition) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          enriched.options = withExpectsTransition(original.options, true) as any;
        }

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
        logger.debug('[MOBILE-TEST] Nothing to persist from this run', { intentTestCaseId });
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
