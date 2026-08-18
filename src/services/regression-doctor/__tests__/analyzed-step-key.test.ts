/**
 * "Already analyzed" is a property of a STEP OF A TEST CASE, never of a step id
 * alone.
 *
 * Web test cases number their steps `step-1`, `step-2`, … so the same id
 * recurs in every case in the project. Keying the skip set on the bare id made
 * the job treat the second test case's `step-2` as already analyzed: it was
 * skipped, no finding was written, and because the collision is deterministic,
 * re-clicking Analyze reproduced it forever. `pattern_key` has always composed
 * testCaseId + stepId; this is the same identity, and the two must not drift.
 */

import { analyzedStepKey } from '../db/regression-doctor.db';
import { computeStepPatternKey } from '../pattern-key';

describe('analyzedStepKey', () => {
  it('separates the same step id in two different test cases', () => {
    expect(analyzedStepKey('tc-a', 'step-2')).not.toBe(analyzedStepKey('tc-b', 'step-2'));
  });

  it('separates two different steps of one test case', () => {
    expect(analyzedStepKey('tc-a', 'step-2')).not.toBe(analyzedStepKey('tc-a', 'step-3'));
  });

  it('is stable for the same pair', () => {
    expect(analyzedStepKey('tc-a', 'step-2')).toBe(analyzedStepKey('tc-a', 'step-2'));
  });

  it('does not collide when ids contain the separator character', () => {
    // Mobile step ids are of the form `d_<draft>_<suffix>:6` and routinely
    // contain punctuation, so a naive concat could make two distinct pairs
    // produce one key.
    expect(analyzedStepKey('a b', 'c')).not.toBe(analyzedStepKey('a', 'b c'));
  });

  it('agrees with pattern_key on what identifies a step', () => {
    // Both must treat the same id under two cases as two different things.
    const patternA = computeStepPatternKey({
      testCaseId: 'tc-a',
      stepId: 'step-2',
      failureKind: 'click',
    });
    const patternB = computeStepPatternKey({
      testCaseId: 'tc-b',
      stepId: 'step-2',
      failureKind: 'click',
    });

    expect(patternA).not.toBe(patternB);
    expect(analyzedStepKey('tc-a', 'step-2')).not.toBe(analyzedStepKey('tc-b', 'step-2'));
  });
});
