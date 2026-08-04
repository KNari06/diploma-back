/**
 * A snapshot `ref` (`e7`) must never escape into a persisted test case.
 *
 * It identifies an element only within the snapshot that produced it, so as a
 * selector it matches nothing, and as a bindingHints label it actively sends
 * the resolver hunting for an element named "e7" — bindingHints are the
 * PREFERRED semantic-match source, so a bogus label outranks the description
 * that would have worked.
 */

import { toIntentSteps } from '../types';
import type { DiscoveredStep } from '../types';

const step = (over: Partial<DiscoveredStep> = {}): DiscoveredStep => ({
  stepNumber: 1,
  description: 'Clicked "Sign in" (button)',
  action: 'click',
  ref: 'e7',
  pageUrl: 'https://acme.com/login',
  ...over,
});

describe('toIntentSteps — ephemeral refs', () => {
  it('labels the binding hint with the HUMAN name, not the ref', () => {
    const [s] = toIntentSteps([step()]);
    expect(s.bindingHints?.label).toBe('Sign in');
  });

  it('omits the label entirely when only a ref is available', () => {
    // Better no hint than a hint that matches nothing: the resolver then falls
    // through to `nearText` / the description.
    const [s] = toIntentSteps([step({ description: 'Click "e7"' })]);
    expect(s.bindingHints?.label).toBeUndefined();
    expect(s.bindingHints?.nearText).toBe('Click "e7"');
  });

  it('never emits a ref as a label, for any ref shape', () => {
    for (const description of ['Click "e7"', 'Clicked "E12" (button)', 'Clicked e7']) {
      const [s] = toIntentSteps([step({ description })]);
      const label = s.bindingHints?.label;
      // Absent is the correct outcome here — assert on the string only when one
      // was emitted, so `undefined` counts as a pass rather than a matcher error.
      expect(label === undefined || !/^e\d+$/i.test(label)).toBe(true);
    }
  });

  it('still records a hint when the step has a real selector', () => {
    const [s] = toIntentSteps([step({ ref: undefined, selector: '#submit' })]);
    expect(s.bindingHints).toBeDefined();
  });

  it('adds no binding hints when the step targets nothing', () => {
    const [s] = toIntentSteps([step({ ref: undefined, selector: undefined, action: 'navigate' })]);
    expect(s.bindingHints).toBeUndefined();
  });
});
