/**
 * Which exploration flows may author a deterministic assertion.
 *
 * The interesting assertion here is the NEGATIVE one: the gate must stay a
 * one-category exclusion. Widening it "to be safe" would silently remove the
 * feature from e_commerce and crud — the categories where a checkable value is
 * the entire point — and nothing would fail.
 */

import { categoryAllowsAssertAuthoring, type TestFlowCategory } from '../types';

const ALL: TestFlowCategory[] = [
  'authentication',
  'navigation',
  'search',
  'form_submission',
  'crud',
  'e_commerce',
  'content',
  'user_management',
  'error_handling',
  'other',
];

describe('categoryAllowsAssertAuthoring', () => {
  it('blocks authentication — its replay cannot reproduce the login the assert stands on', () => {
    expect(categoryAllowsAssertAuthoring('authentication')).toBe(false);
  });

  it('allows every other category', () => {
    const blocked = ALL.filter((c) => !categoryAllowsAssertAuthoring(c));
    expect(blocked).toEqual(['authentication']);
  });

  it('allows the categories the feature exists for', () => {
    // Guarded explicitly: a future "let us be cautious" edit that adds these to
    // the blocklist should fail loudly rather than quietly gut the feature.
    expect(categoryAllowsAssertAuthoring('e_commerce')).toBe(true);
    expect(categoryAllowsAssertAuthoring('crud')).toBe(true);
    expect(categoryAllowsAssertAuthoring('search')).toBe(true);
  });
});
