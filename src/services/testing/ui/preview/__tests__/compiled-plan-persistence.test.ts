import { CompiledPlanPersistenceService } from '../compiled-plan-persistence.service';
import { IntentTestCaseService } from '../intent-test-case.service';
import type { MobileIntentStep, MobileRunStepsResponse } from '@/services/mobile/mobile-runner.types';

jest.mock('../intent-test-case.service', () => ({
  IntentTestCaseService: { batchUpdateStepsFromRun: jest.fn().mockResolvedValue(true) },
}));

const batchUpdate = IntentTestCaseService.batchUpdateStepsFromRun as jest.Mock;

const CASE_ID = 'case-1';
const step = (over: Partial<MobileIntentStep> = {}): MobileIntentStep => ({
  id: 'step-1',
  type: 'click',
  description: 'Pay',
  ...over,
}) as MobileIntentStep;

const runResult = (over: Record<string, unknown>): MobileRunStepsResponse => ({
  steps: [{ stepId: 'step-1', success: true, durationMs: 10, ...over }],
} as unknown as MobileRunStepsResponse);

/** The steps map handed to the DB layer, keyed by step id. */
const persisted = () => batchUpdate.mock.calls.at(-1)?.[0]?.enrichedSteps as Map<string, any>;

beforeEach(() => jest.clearAllMocks());

describe('persistFromRun — recording that a step navigates', () => {
  it('records expectsTransition for a step that has NO compiled plan', async () => {
    // The case that motivated the feature: a WebView tap returns from
    // executeCommand before the compiled-plan builder runs, so it never has a
    // plan. Gating on the plan would arm everything EXCEPT this.
    await CompiledPlanPersistenceService.persistFromRun(
      CASE_ID, [step()], runResult({ transitionDetected: true, resolvedVia: 'web_dom' }),
    );
    expect(persisted().get('step-1').options).toEqual({ expectsTransition: true });
  });

  it('keeps the step\'s existing options while recording', async () => {
    await CompiledPlanPersistenceService.persistFromRun(
      CASE_ID,
      [step({ options: { timeout: 5000 } } as Partial<MobileIntentStep>)],
      runResult({ transitionDetected: true }),
    );
    expect(persisted().get('step-1').options).toEqual({ timeout: 5000, expectsTransition: true });
  });

  it('records NOTHING when the step changed no screen', async () => {
    // The one-way rule. A run whose tap missed must not teach the step that it
    // does not navigate — that would pin it to the guard's lenient branch.
    await CompiledPlanPersistenceService.persistFromRun(
      CASE_ID, [step()], runResult({ transitionDetected: false }),
    );
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('records nothing when the runner had no verdict', async () => {
    await CompiledPlanPersistenceService.persistFromRun(CASE_ID, [step()], runResult({}));
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('records nothing from a FAILED step, even if the screen changed', async () => {
    // A failed step's transition says nothing trustworthy about the step's
    // intent — the screen may have changed because the app errored.
    await CompiledPlanPersistenceService.persistFromRun(
      CASE_ID, [step()], runResult({ success: false, transitionDetected: true }),
    );
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('still persists a compiled plan on its own, as before', async () => {
    const plan = { version: 1, platform: 'flutter', compiledAt: 'x', strategies: [], fingerprint: {} };
    await CompiledPlanPersistenceService.persistFromRun(
      CASE_ID, [step()], runResult({ compiledPlan: plan }),
    );
    const out = persisted().get('step-1');
    expect(out.compiled).toEqual(plan);
    expect(out.options).toBeUndefined();
  });

  it('persists both a plan and the expectation together', async () => {
    const plan = { version: 1, platform: 'flutter', compiledAt: 'x', strategies: [], fingerprint: {} };
    await CompiledPlanPersistenceService.persistFromRun(
      CASE_ID, [step()], runResult({ compiledPlan: plan, transitionDetected: true }),
    );
    const out = persisted().get('step-1');
    expect(out.compiled).toEqual(plan);
    expect(out.options).toEqual({ expectsTransition: true });
  });

  it('still refuses a stale plan, but the expectation survives', async () => {
    // A stale plan points at the wrong element and must not be saved. The
    // observation that the screen changed is a separate, still-true fact.
    const plan = { version: 1, platform: 'flutter', compiledAt: 'x', strategies: [], fingerprint: {} };
    await CompiledPlanPersistenceService.persistFromRun(
      CASE_ID, [step()],
      runResult({ compiledPlan: plan, planStaleReason: 'vte_mismatch', transitionDetected: true }),
    );
    const out = persisted().get('step-1');
    expect(out.compiled).toBeUndefined();
    expect(out.options).toEqual({ expectsTransition: true });
  });
});
