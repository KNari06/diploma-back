/**
 * Tests for Stage 2 deweighted ProgressEvaluator.
 *
 * Goals:
 *   1. Pin the priority order (errors > url > widget-open > api > moves > none).
 *   2. Verify pure synchronous behaviour (no LLM, no I/O).
 *   3. Confirm shape parity with HybridSemanticWeightCalculator output —
 *      same `ProgressSentiment` enum values for the same inputs in
 *      cases the legacy calculator handled deterministically.
 *   4. Goal-keyword relevance is token-based (no false partial matches).
 */

import type { LiteElement, NetworkSuccess, NetworkValidationError, StateDiff } from '../../lite-types';
import type { ExpandedGoal } from '../goal-expander';
import {
  buildDeterministicSummary,
  computeProgressSentiment,
  isGoalRelevantElement,
} from '../progress-evaluator';

// Test helpers — keep tiny so each test reads in 5 seconds.

function makeEl(overrides: Partial<LiteElement> = {}): LiteElement {
  return {
    ref: 'e1',
    tag: 'button',
    name: '',
    visible: true,
    ...overrides,
  } as LiteElement;
}

function makeDiff(overrides: Partial<StateDiff> = {}): StateDiff {
  return {
    urlChanged: false,
    urlBefore: 'https://app/',
    urlAfter: 'https://app/',
    addedElements: [],
    removedRefs: [],
    changedElements: [],
    hasVisualChange: false,
    newPageErrors: [],
    newConsoleErrors: [],
    newNetworkErrors: [],
    semanticWeight: 0,
    meaningfulChange: false,
    significantChange: false,
    progressSentiment: 'No Effect',
    ...overrides,
  };
}

function makeGoal(keywords: string[]): ExpandedGoal {
  return {
    original: keywords.join(' '),
    actionTokens: [keywords[0] ?? ''],
    objectTokens: keywords.slice(1),
    allKeywords: new Set(keywords),
    negativeKeywords: new Set(),
    language: 'en',
  } as ExpandedGoal;
}

describe('computeProgressSentiment — priority order', () => {
  it('returns Negative Change on any error signal', () => {
    expect(computeProgressSentiment(makeDiff({ newPageErrors: ['oops'] }))).toBe('Negative Change');
    expect(computeProgressSentiment(makeDiff({ newConsoleErrors: ['oops'] }))).toBe('Negative Change');
    expect(computeProgressSentiment(makeDiff({ newNetworkErrors: ['500'] }))).toBe('Negative Change');
    expect(computeProgressSentiment(makeDiff({
      validationApiErrors: [{ url: '/api/x', status: 422, message: 'invalid' } as NetworkValidationError],
    }))).toBe('Negative Change');
  });

  it('errors outrank URL change (regression guard)', () => {
    // A click that simultaneously navigates AND raises an error is
    // still a regression — author wanted the destination, not a 500.
    const diff = makeDiff({
      urlChanged: true,
      urlBefore: 'https://app/',
      urlAfter: 'https://app/error',
      newPageErrors: ['Boom'],
    });
    expect(computeProgressSentiment(diff)).toBe('Negative Change');
  });

  it('URL change → Major Progress', () => {
    expect(computeProgressSentiment(makeDiff({
      urlChanged: true, urlAfter: 'https://app/done',
    }))).toBe('Major Progress');
  });

  it('new <form> appears → Major Progress', () => {
    expect(computeProgressSentiment(makeDiff({
      addedElements: [makeEl({ tag: 'form', ref: 'f1' })],
    }))).toBe('Major Progress');
  });

  it('new role=dialog appears → Major Progress (Radix Dialog without <dialog>)', () => {
    expect(computeProgressSentiment(makeDiff({
      addedElements: [makeEl({ tag: 'div', role: 'dialog', ref: 'd1' })],
    }))).toBe('Major Progress');
  });

  it('new role=alertdialog appears → Major Progress', () => {
    expect(computeProgressSentiment(makeDiff({
      addedElements: [makeEl({ tag: 'div', role: 'alertdialog', ref: 'd1' })],
    }))).toBe('Major Progress');
  });

  it('new <input> / <textarea> / <select> appears → Major Progress', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(computeProgressSentiment(makeDiff({
        addedElements: [makeEl({ tag, ref: 'i1' })],
      }))).toBe('Major Progress');
    }
  });

  it('successful API response → Significant Change', () => {
    expect(computeProgressSentiment(makeDiff({
      successfulApiResponses: [{ url: '/api/save', status: 201, method: 'POST' } as NetworkSuccess],
    }))).toBe('Significant Change');
  });

  it('bulk DOM movement (≥3 added/removed/changed) → Minor Change', () => {
    // 3 added elements, no widget-opening tag.
    expect(computeProgressSentiment(makeDiff({
      addedElements: [
        makeEl({ tag: 'span', ref: 'a' }),
        makeEl({ tag: 'div', ref: 'b' }),
        makeEl({ tag: 'p', ref: 'c' }),
      ],
    }))).toBe('Minor Change');

    // Mix of added/removed/changed totalling 3.
    expect(computeProgressSentiment(makeDiff({
      addedElements: [makeEl({ tag: 'span', ref: 'a' })],
      removedRefs: ['b'],
      changedElements: [{ ref: 'c', field: 'visible', before: true, after: false }],
    }))).toBe('Minor Change');
  });

  it('no signals → No Effect (drives consecutiveNoEffectCount)', () => {
    expect(computeProgressSentiment(makeDiff())).toBe('No Effect');
    // 2 changes are NOT enough — must be ≥3.
    expect(computeProgressSentiment(makeDiff({
      addedElements: [makeEl({ tag: 'span', ref: 'a' })],
      removedRefs: ['b'],
    }))).toBe('No Effect');
  });

  // Fix 2 — decorative bulk gate. Critical for "buy iPhone" runs
  // where agent accidentally clicks Reviews/FAQ section.
  it('Fix 2: decorative bulk with goal → No Effect, not Minor Change', () => {
    const goal = makeGoal(['buy', 'iphone', 'cart']);
    // Reviews opened: 5 new <div> elements, none related to goal.
    const decorative = [1, 2, 3, 4, 5].map((i) => makeEl({
      tag: 'div', ref: `r${i}`, name: `Review by user ${i}`,
    }));
    expect(computeProgressSentiment(
      makeDiff({ addedElements: decorative }),
      goal,
    )).toBe('No Effect');
  });

  it('Fix 2: bulk WITH goal-relevant → still Minor Change', () => {
    // Mini-cart popover: 4 decorative + 1 goal-relevant Checkout button.
    const goal = makeGoal(['checkout', 'cart']);
    const mixed = [
      makeEl({ tag: 'div', ref: 'd1', name: 'Free shipping' }),
      makeEl({ tag: 'div', ref: 'd2', name: 'Secure payment' }),
      makeEl({ tag: 'div', ref: 'd3', name: 'Returns policy' }),
      makeEl({ tag: 'span', ref: 'd4', name: 'Trusted store' }),
      makeEl({ tag: 'button', ref: 'b1', name: 'Proceed to Checkout' }),
    ];
    expect(computeProgressSentiment(
      makeDiff({ addedElements: mixed }),
      goal,
    )).toBe('Minor Change');
  });

  it('Fix 2: bulk WITH error element → stays Minor Change (errors handled separately above)', () => {
    // Validation surfaced: error span + 3 unrelated divs. The error
    // gate at the top doesn't fire (newPageErrors empty), but the
    // decorative gate must NOT demote — error inside addedElements
    // is still meaningful.
    const goal = makeGoal(['login']);
    const withError = [
      makeEl({ tag: 'div', ref: 'd1', name: 'Hint 1' }),
      makeEl({ tag: 'div', ref: 'd2', name: 'Hint 2' }),
      makeEl({ tag: 'span', ref: 'e1', name: 'Login failed: invalid password' }),
      makeEl({ tag: 'div', ref: 'd3', name: 'Hint 3' }),
    ];
    expect(computeProgressSentiment(
      makeDiff({ addedElements: withError }),
      goal,
    )).toBe('Minor Change');
  });

  it('Fix 2: no goal provided → bulk gate inactive (back-compat)', () => {
    // When goal is null/undefined, decorative gate must be a no-op
    // so behaviour matches pre-Fix-2 (threshold-only).
    const decorative = [1, 2, 3].map((i) => makeEl({
      tag: 'div', ref: `r${i}`, name: `Item ${i}`,
    }));
    expect(computeProgressSentiment(
      makeDiff({ addedElements: decorative }),
      null,
    )).toBe('Minor Change');
  });

  it('is pure / synchronous (no Promise return)', () => {
    const result = computeProgressSentiment(makeDiff());
    // If it ever becomes async, this property check breaks loud.
    expect(typeof result).toBe('string');
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe('isGoalRelevantElement — keyword token match', () => {
  it('matches whole-word goal keyword in element name', () => {
    const goal = makeGoal(['submit', 'order']);
    expect(isGoalRelevantElement(makeEl({ name: 'Submit Order' }), goal)).toBe(true);
  });

  it('does NOT match partial substrings (regression guard for "log" in "catalog")', () => {
    const goal = makeGoal(['log']);
    expect(isGoalRelevantElement(makeEl({ name: 'Catalog' }), goal)).toBe(false);
  });

  it('reads ariaLabel when name is empty', () => {
    const goal = makeGoal(['close']);
    expect(isGoalRelevantElement(
      makeEl({ name: '', ariaLabel: 'Close dialog' }),
      goal,
    )).toBe(true);
  });

  it('returns false when no goal provided', () => {
    expect(isGoalRelevantElement(makeEl({ name: 'Submit' }), null)).toBe(false);
  });

  it('returns false on element with no text-bearing fields', () => {
    const goal = makeGoal(['submit']);
    expect(isGoalRelevantElement(makeEl({ name: '' }), goal)).toBe(false);
  });
});

describe('buildDeterministicSummary — output shape', () => {
  it('returns "Minimal changes detected." when nothing happened', () => {
    expect(buildDeterministicSummary(makeDiff(), null)).toBe('Minimal changes detected.');
  });

  it('lists errors with names when present', () => {
    const errEl = makeEl({ name: 'Failed to save', tag: 'div' });
    const summary = buildDeterministicSummary(
      makeDiff({ addedElements: [errEl], progressSentiment: 'Negative Change' }),
      null,
    );
    // Don't assert exact wording — just that error and sentiment appear.
    expect(summary).toMatch(/⚠️|Errors|error/i);
  });

  it('lists URL change line when navigated', () => {
    const summary = buildDeterministicSummary(
      makeDiff({ urlChanged: true, urlAfter: 'https://app/checkout', progressSentiment: 'Major Progress' }),
      null,
    );
    expect(summary).toMatch(/Navigated/);
    expect(summary).toMatch(/checkout/);
  });

  it('flags new dialog by role', () => {
    const summary = buildDeterministicSummary(
      makeDiff({
        addedElements: [makeEl({ tag: 'div', role: 'dialog', name: 'Confirm', ref: 'd1' })],
        progressSentiment: 'Major Progress',
      }),
      null,
    );
    expect(summary).toMatch(/Dialog opened/);
    expect(summary).toMatch(/Confirm/);
  });

  it('does not include sentiment line when "No Effect"', () => {
    // Same shape as legacy calculator: silent on null-progress.
    const summary = buildDeterministicSummary(makeDiff(), null);
    expect(summary).not.toMatch(/Progress:/);
  });

  it('annotates goal-relevant additions when goal provided', () => {
    const goal = makeGoal(['cart']);
    const summary = buildDeterministicSummary(
      makeDiff({
        addedElements: [makeEl({ tag: 'button', name: 'Add to cart', ref: 'b1' })],
        // Without urlChanged or widget-open this would normally be 'No Effect',
        // but the consumer sets sentiment elsewhere — pass it explicitly.
        progressSentiment: 'Minor Change',
      }),
      goal,
    );
    expect(summary).toMatch(/Goal-relevant/);
    expect(summary).toMatch(/Add to cart/);
  });
});
