/**
 * Unit tests for `toIntentSteps` handling of the deterministic `assert` action.
 *
 * These two behaviors are load-bearing for rung-3 (deterministic-assert
 * authoring): if the `value` is not carried the converter degrades the assert to
 * a visibility check that passes on ANY page (false-green persists); if the
 * structural selector is not pinned the replay primary locator encodes the
 * asserted text and locator-misses on a broken value instead of a clean text
 * mismatch. Both are guarded here.
 */

import { toIntentSteps, type DiscoveredStep } from '../types';

function assertStep(overrides: Partial<DiscoveredStep> = {}): DiscoveredStep {
  return {
    stepNumber: 1,
    description: 'Result count shows one match',
    action: 'assert',
    value: '1 result',
    pageUrl: 'https://x.test/shop',
    ...overrides,
  };
}

describe('toIntentSteps — deterministic assert', () => {
  it('maps action:"assert" → type:"assert"', () => {
    const [step] = toIntentSteps([assertStep()]);
    expect(step.type).toBe('assert');
  });

  it('carries the expected value (so the converter builds a text-contains assertion, not a visibility check)', () => {
    const [step] = toIntentSteps([assertStep({ value: '$126.35' })]);
    expect(step.value).toBe('$126.35');
  });

  it('pins the structural selector as options.cssSelector (text-independent replay primary)', () => {
    const [step] = toIntentSteps([assertStep({ selector: '[data-testid="result-count"]' })]);
    expect(step.options?.cssSelector).toBe('[data-testid="result-count"]');
  });

  it('omits options.cssSelector when no structural selector was captured', () => {
    const [step] = toIntentSteps([assertStep({ selector: undefined })]);
    expect(step.options?.cssSelector).toBeUndefined();
  });

  it('does not corrupt a following step', () => {
    const steps = toIntentSteps([
      assertStep(),
      { stepNumber: 2, description: 'Click home', action: 'click', ref: 'e2', pageUrl: 'https://x.test/shop' },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[1].type).toBe('click');
    expect(steps[1].value).toBeUndefined();
  });
});
