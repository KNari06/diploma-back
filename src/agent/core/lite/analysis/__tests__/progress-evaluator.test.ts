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
  applyDeweightedSentiment,
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

  // ── Audit Scenario 1: Reviews "iPhone" content keyword false-positive ──
  it('Scenario 1: review divs containing goal text are NOT actionable → still No Effect', () => {
    // "buy iPhone" goal, user clicks Reviews tab. Review cards mount
    // as plain <div> elements whose name contains "iPhone" — naive
    // text-match would misclassify them as goal-relevant.
    const goal = makeGoal(['buy', 'iphone']);
    const reviewCards = [1, 2, 3, 4, 5].map((i) => makeEl({
      tag: 'div', ref: `r${i}`,
      name: `Great iPhone! Bought it last week, very happy review #${i}`,
    }));
    expect(computeProgressSentiment(
      makeDiff({ addedElements: reviewCards }),
      goal,
    )).toBe('No Effect');
  });

  it('Scenario 1: actual interactive button containing goal text → Minor Change', () => {
    // Counterpart: a real <button>iPhone 15 Pro</button> in a list of
    // products MUST be detected as actionable. Stricter predicate
    // accepts native interactive tags + ARIA-button roles.
    const goal = makeGoal(['iphone']);
    const products = [
      makeEl({ tag: 'div', ref: 'card1', name: 'iPhone description' }),
      makeEl({ tag: 'div', ref: 'card2', name: 'iPhone price' }),
      makeEl({ tag: 'button', ref: 'buy1', name: 'Buy iPhone 15 Pro' }),
    ];
    expect(computeProgressSentiment(
      makeDiff({ addedElements: products }),
      goal,
    )).toBe('Minor Change');
  });

  // ── Audit C1: Radix data-state flip → Major Progress ──
  it('Fix C1: data-state closed→open in changedElements → Major Progress', () => {
    // Radix DropdownMenu trigger flips data-state without aria-expanded.
    expect(computeProgressSentiment(makeDiff({
      changedElements: [
        { ref: 'trig1', field: 'dataState', before: 'closed', after: 'open' },
      ],
    }))).toBe('Major Progress');
  });

  it('Fix C1: data-state inactive→active (Tabs) → Major Progress', () => {
    expect(computeProgressSentiment(makeDiff({
      changedElements: [
        { ref: 'tab1', field: 'dataState', before: 'inactive', after: 'active' },
      ],
    }))).toBe('Major Progress');
  });

  it('Fix C1: data-state open→closed (closing) is NOT major progress', () => {
    // Closing is not "progress" — let bulk-gate / lower rules decide.
    // Single change → totalMoves=1 → 'No Effect'.
    expect(computeProgressSentiment(makeDiff({
      changedElements: [
        { ref: 'trig1', field: 'dataState', before: 'open', after: 'closed' },
      ],
    }))).toBe('No Effect');
  });

  // ── Audit H4: widget-open list now covers Radix menu/combobox/listbox ──
  it('Fix H4: new role=menu in addedElements → Major Progress', () => {
    expect(computeProgressSentiment(makeDiff({
      addedElements: [makeEl({ tag: 'div', role: 'menu', ref: 'm1' })],
    }))).toBe('Major Progress');
  });

  it('Fix H4: new role=menuitem (Portal-rendered DropdownMenu items) → Major Progress', () => {
    expect(computeProgressSentiment(makeDiff({
      addedElements: [
        makeEl({ tag: 'div', role: 'menuitem', ref: 'mi1' }),
        makeEl({ tag: 'div', role: 'menuitem', ref: 'mi2' }),
      ],
    }))).toBe('Major Progress');
  });

  it('Fix H4: new role=combobox (Radix Select) → Major Progress', () => {
    expect(computeProgressSentiment(makeDiff({
      addedElements: [makeEl({ tag: 'div', role: 'combobox', ref: 'c1' })],
    }))).toBe('Major Progress');
  });

  it('Fix H4: new role=listbox + role=option (Listbox open) → Major Progress', () => {
    expect(computeProgressSentiment(makeDiff({
      addedElements: [
        makeEl({ tag: 'div', role: 'listbox', ref: 'lb' }),
        makeEl({ tag: 'div', role: 'option', ref: 'o1' }),
      ],
    }))).toBe('Major Progress');
  });

  // ── Audit M5: visible=false widget should NOT trigger Major Progress ──
  it('Audit M5: hidden <input> from Stripe iframe → does NOT fire widget gate', () => {
    // Stripe / reCaptcha inject hidden inputs / forms. Without the
    // visible filter, every page with these injects fires Major
    // Progress on every iteration — false-positive that resets stuck
    // count and prevents legitimate aborts.
    expect(computeProgressSentiment(makeDiff({
      addedElements: [
        makeEl({ tag: 'input', ref: 'hidden1', visible: false }),
        makeEl({ tag: 'form', ref: 'hidden2', visible: false }),
      ],
    }))).toBe('No Effect');
  });
});

describe('applyDeweightedSentiment — C2/C3 flag truthfulness', () => {
  it('Major Progress sets meaningful=true and significant=true', () => {
    const result = applyDeweightedSentiment(makeDiff({ urlChanged: true, urlAfter: 'https://app/done' }));
    expect(result.progressSentiment).toBe('Major Progress');
    expect(result.meaningfulChange).toBe(true);
    expect(result.significantChange).toBe(true);
  });

  it('Significant Change sets meaningful=true and significant=true', () => {
    const result = applyDeweightedSentiment(makeDiff({
      successfulApiResponses: [{ url: '/api/save', status: 201, method: 'POST' } as NetworkSuccess],
    }));
    expect(result.progressSentiment).toBe('Significant Change');
    expect(result.meaningfulChange).toBe(true);
    expect(result.significantChange).toBe(true);
  });

  it('Minor Change sets meaningful=true but significant=false', () => {
    const result = applyDeweightedSentiment(makeDiff({
      addedElements: [
        makeEl({ tag: 'span', ref: 'a' }),
        makeEl({ tag: 'div', ref: 'b' }),
        makeEl({ tag: 'p', ref: 'c' }),
      ],
    }));
    expect(result.progressSentiment).toBe('Minor Change');
    expect(result.meaningfulChange).toBe(true);
    expect(result.significantChange).toBe(false);
  });

  it('Negative Change sets BOTH flags true (something happened, even if bad)', () => {
    // Errors are still "meaningful" — state-validator and downstream
    // need to know SOMETHING happened, just badly.
    const result = applyDeweightedSentiment(makeDiff({ newPageErrors: ['Boom'] }));
    expect(result.progressSentiment).toBe('Negative Change');
    expect(result.meaningfulChange).toBe(true);
    expect(result.significantChange).toBe(true);
  });

  it('No Effect sets both false (matches base default)', () => {
    const result = applyDeweightedSentiment(makeDiff());
    expect(result.progressSentiment).toBe('No Effect');
    expect(result.meaningfulChange).toBe(false);
    expect(result.significantChange).toBe(false);
  });

  it('preserves all other StateDiff fields', () => {
    const base = makeDiff({
      urlChanged: true,
      urlAfter: 'https://app/x',
      addedElements: [makeEl({ tag: 'span', ref: 'a' })],
      removedRefs: ['b', 'c'],
    });
    const result = applyDeweightedSentiment(base);
    expect(result.urlAfter).toBe('https://app/x');
    expect(result.addedElements).toBe(base.addedElements);
    expect(result.removedRefs).toEqual(['b', 'c']);
  });
});

describe('isGoalRelevantElement — H3: title/iconLabel coverage', () => {
  it('matches goal keyword in el.title (icon button tooltip)', () => {
    const goal = makeGoal(['add', 'cart']);
    expect(isGoalRelevantElement(
      makeEl({ tag: 'button', name: '', title: 'Add to cart' }),
      goal,
    )).toBe(true);
  });

  it('matches goal keyword in el.iconLabel (Lucide / FA icon)', () => {
    const goal = makeGoal(['delete', 'trash']);
    expect(isGoalRelevantElement(
      makeEl({ tag: 'button', name: '', iconLabel: 'trash' }),
      goal,
    )).toBe(true);
  });

  it('matches goal keyword in el.labelText (form input wrap)', () => {
    const goal = makeGoal(['email']);
    expect(isGoalRelevantElement(
      makeEl({ tag: 'input', name: '', labelText: 'Email address' }),
      goal,
    )).toBe(true);
  });

  it('matches goal keyword in el.placeholder (input)', () => {
    const goal = makeGoal(['search']);
    expect(isGoalRelevantElement(
      makeEl({ tag: 'input', name: '', placeholder: 'Search products' }),
      goal,
    )).toBe(true);
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
