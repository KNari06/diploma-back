import { classifyStepResults } from '../step-result-classifier';
import type { MobileIntentStep, MobileStepResult } from '@/services/mobile/mobile-runner.types';

// Minimal step factories for test clarity
const step = (stepId: string, success: boolean, error?: string): MobileStepResult =>
  ({ stepId, success, error, durationMs: 100 } as MobileStepResult);

const intent = (id: string, opts?: { continueOnError?: boolean; isAutoInjected?: boolean }): MobileIntentStep =>
  ({
    id,
    type: 'tap' as any,
    description: id,
    ...(opts?.continueOnError !== undefined ? { options: { continueOnError: opts.continueOnError } } : {}),
    ...(opts?.isAutoInjected !== undefined ? { isAutoInjected: opts.isAutoInjected } : {}),
  } as MobileIntentStep);

describe('classifyStepResults', () => {
  describe('testPassed', () => {
    it('returns testPassed=true when all steps succeed', () => {
      const result = classifyStepResults(
        [step('s1', true), step('s2', true)],
        [intent('s1'), intent('s2')],
        'passed',
      );
      expect(result.testPassed).toBe(true);
      expect(result.mandatoryFailures).toHaveLength(0);
    });

    it('returns testPassed=false when a mandatory step fails', () => {
      const result = classifyStepResults(
        [step('s1', true), step('s2', false, 'Element not found')],
        [intent('s1'), intent('s2')],
        'failed',
      );
      expect(result.testPassed).toBe(false);
      expect(result.mandatoryFailures).toHaveLength(1);
      expect(result.mandatoryFailures[0].stepId).toBe('s2');
    });

    it('returns testPassed=true when only optional (continueOnError) steps fail', () => {
      const result = classifyStepResults(
        [step('s1', true), step('s2', false, 'Optional step failed')],
        [intent('s1'), intent('s2', { continueOnError: true })],
        'failed',
      );
      expect(result.testPassed).toBe(true);
      expect(result.mandatoryFailures).toHaveLength(0);
      expect(result.optionalFailures).toHaveLength(1);
    });

    it('returns testPassed=true when only auto-injected steps fail', () => {
      const result = classifyStepResults(
        [step('s1', true), step('auto1', false)],
        [intent('s1'), intent('auto1', { isAutoInjected: true })],
        'failed',
      );
      expect(result.testPassed).toBe(true);
      expect(result.mandatoryFailures).toHaveLength(0);
      expect(result.optionalFailures).toHaveLength(1);
    });

    it('returns testPassed=true when a step is unknown (runner-injected) and fails', () => {
      // 'runner_step' not in intentSteps — treated as runner infrastructure
      const result = classifyStepResults(
        [step('s1', true), step('runner_step', false)],
        [intent('s1')],
        'failed',
      );
      expect(result.testPassed).toBe(true);
      expect(result.optionalFailures).toHaveLength(1);
    });

    it('returns testPassed=false when mix of optional and mandatory fails', () => {
      const result = classifyStepResults(
        [step('opt', false), step('mandatory', false, 'crash')],
        [intent('opt', { continueOnError: true }), intent('mandatory')],
        'failed',
      );
      expect(result.testPassed).toBe(false);
      expect(result.mandatoryFailures).toHaveLength(1);
      expect(result.optionalFailures).toHaveLength(1);
    });
  });

  describe('aggregateMismatch', () => {
    it('detects mismatch when runner says passed but steps contain failures', () => {
      const result = classifyStepResults(
        [step('s1', true), step('s2', false)],
        [intent('s1'), intent('s2')],
        'passed', // runner aggregate disagrees with per-step truth
      );
      expect(result.aggregateMismatch).toBe(true);
    });

    it('no mismatch when runner says failed and steps contain failures', () => {
      const result = classifyStepResults(
        [step('s1', false)],
        [intent('s1')],
        'failed',
      );
      expect(result.aggregateMismatch).toBe(false);
    });

    it('no mismatch when runner says passed and all steps pass', () => {
      const result = classifyStepResults(
        [step('s1', true)],
        [intent('s1')],
        'passed',
      );
      expect(result.aggregateMismatch).toBe(false);
    });
  });

  describe('isTolerableFailure predicate', () => {
    it('returns false for a known mandatory step', () => {
      const { isTolerableFailure } = classifyStepResults(
        [],
        [intent('s1')],
        'passed',
      );
      expect(isTolerableFailure('s1')).toBe(false);
    });

    it('returns true for a known continueOnError step', () => {
      const { isTolerableFailure } = classifyStepResults(
        [],
        [intent('s1', { continueOnError: true })],
        'passed',
      );
      expect(isTolerableFailure('s1')).toBe(true);
    });

    it('returns true for an unknown (runner-injected) step', () => {
      const { isTolerableFailure } = classifyStepResults(
        [],
        [intent('s1')],
        'passed',
      );
      expect(isTolerableFailure('runner_unknown')).toBe(true);
    });
  });

  describe('incompleteRun (truncated runner response)', () => {
    it('fails the run when the runner returns fewer steps than requested', () => {
      // Requested 5 steps, runner aborted after 3 — all 3 returned passed.
      // Without truncation detection this would be a false-green 3/5.
      const result = classifyStepResults(
        [step('s1', true), step('s2', true), step('s3', true)],
        [intent('s1'), intent('s2'), intent('s3'), intent('s4'), intent('s5')],
        'passed',
        5,
      );
      expect(result.incompleteRun).toBe(true);
      expect(result.testPassed).toBe(false);
      expect(result.missingStepIds).toEqual(['s4', 's5']);
      expect(result.returnedStepCount).toBe(3);
      expect(result.expectedStepCount).toBe(5);
      expect(result.mandatoryFailures).toHaveLength(0);
    });

    it('fails when steps fall short of the runner-reported total even if intent count matches', () => {
      // Returned a result per intent step, but the runner itself reports it
      // expected more — trust the larger of the two counts.
      const result = classifyStepResults(
        [step('s1', true), step('s2', true)],
        [intent('s1'), intent('s2')],
        'passed',
        4,
      );
      expect(result.incompleteRun).toBe(true);
      expect(result.testPassed).toBe(false);
      expect(result.expectedStepCount).toBe(4);
    });

    it('does not flag a complete run with runner-injected extra steps', () => {
      // Every intent step has a result; runner added an extra helper step.
      const result = classifyStepResults(
        [step('s1', true), step('auto_wait', true), step('s2', true)],
        [intent('s1'), intent('s2')],
        'passed',
        2,
      );
      expect(result.incompleteRun).toBe(false);
      expect(result.testPassed).toBe(true);
      expect(result.missingStepIds).toHaveLength(0);
    });

    it('does not flag truncation when runnerTotalSteps is omitted and all intent steps ran', () => {
      const result = classifyStepResults(
        [step('s1', true), step('s2', true)],
        [intent('s1'), intent('s2')],
        'passed',
      );
      expect(result.incompleteRun).toBe(false);
      expect(result.testPassed).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty steps and intentSteps', () => {
      const result = classifyStepResults([], [], 'passed');
      expect(result.testPassed).toBe(true);
      expect(result.mandatoryFailures).toHaveLength(0);
      expect(result.optionalFailures).toHaveLength(0);
      expect(result.aggregateMismatch).toBe(false);
    });
  });

  describe('author-disabled steps (options.enabled === false)', () => {
    const disabledIntent = (id: string): MobileIntentStep =>
      ({ id, type: 'tap' as any, description: id, options: { enabled: false } } as MobileIntentStep);

    // What the runner actually sends for a disabled step: a real stepId,
    // success:true so it can't fail the run, and skipReason to mark it.
    const disabledResult = (stepId: string): MobileStepResult =>
      ({ stepId, success: true, resolvedVia: 'skipped', skipReason: 'disabled', durationMs: 0 } as MobileStepResult);

    it('passes the test when the only non-executed step was disabled by the author', () => {
      const result = classifyStepResults(
        [step('s1', true), disabledResult('s2')],
        [intent('s1'), disabledIntent('s2')],
        'passed',
      );
      expect(result.testPassed).toBe(true);
      expect(result.mandatoryFailures).toHaveLength(0);
      expect(result.incompleteRun).toBe(false);
    });

    it('treats a disabled step as tolerable so an older runner reporting it as failed cannot fail the test', () => {
      // Defense in depth: a runner predating `skipReason` may send success:false.
      const result = classifyStepResults(
        [step('s1', true), step('s2', false, 'Skipped')],
        [intent('s1'), disabledIntent('s2')],
        'passed',
      );
      expect(result.isTolerableFailure('s2')).toBe(true);
      expect(result.mandatoryFailures).toHaveLength(0);
      expect(result.testPassed).toBe(true);
    });

    it('still fails the test when a step that WAS enabled fails alongside a disabled one', () => {
      const result = classifyStepResults(
        [step('s1', false, 'boom'), disabledResult('s2')],
        [intent('s1'), disabledIntent('s2')],
        'failed',
      );
      expect(result.testPassed).toBe(false);
      expect(result.mandatoryFailures).toHaveLength(1);
      expect(result.mandatoryFailures[0].stepId).toBe('s1');
    });

    it('flags an incomplete run when a disabled step is omitted from the results entirely', () => {
      // Regression guard: the runner MUST push a row for a disabled step.
      // Omitting it makes the run look truncated and force-fails the test.
      const result = classifyStepResults(
        [step('s1', true)],
        [intent('s1'), disabledIntent('s2')],
        'passed',
      );
      expect(result.incompleteRun).toBe(true);
      expect(result.missingStepIds).toEqual(['s2']);
      expect(result.testPassed).toBe(false);
    });

    it('passes a run in which every step is disabled', () => {
      const result = classifyStepResults(
        [disabledResult('s1'), disabledResult('s2')],
        [disabledIntent('s1'), disabledIntent('s2')],
        'passed',
      );
      expect(result.testPassed).toBe(true);
      expect(result.aggregateMismatch).toBe(false);
    });
  });
});
