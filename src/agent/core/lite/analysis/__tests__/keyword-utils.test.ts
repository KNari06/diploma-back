/**
 * Smoke tests for `keyword-utils` — direct coverage so future tweaks
 * to tokenization / stemming / error detection don't silently regress.
 *
 * History note: these utils were extracted verbatim from the (now
 * deleted) `hybrid-semantic-weight.ts` Stage 2D refactor. Originally
 * they were tested only indirectly via the calculator's test file.
 * That file is gone; these tests pin the public contract.
 */

import type { LiteElement } from '../../lite-types';
import { isErrorElement, matchesKeyword } from '../keyword-utils';

// ── matchesKeyword ────────────────────────────────────────────────────

describe('matchesKeyword — token boundary matching', () => {
  it('matches single-word keyword on exact token', () => {
    expect(matchesKeyword('Submit Order', 'submit')).toBe(true);
    expect(matchesKeyword('Click here', 'click')).toBe(true);
  });

  it('does NOT match partial substring (canonical "log" in "catalog" guard)', () => {
    expect(matchesKeyword('Catalog of items', 'log')).toBe(false);
    expect(matchesKeyword('Login page', 'gin')).toBe(false);
  });

  it('case-insensitive', () => {
    expect(matchesKeyword('SUBMIT', 'submit')).toBe(true);
    expect(matchesKeyword('submit', 'SUBMIT')).toBe(true);
  });

  it('matches Russian tokens', () => {
    expect(matchesKeyword('Войти в систему', 'войти')).toBe(true);
    expect(matchesKeyword('Регистрация пользователя', 'регистрация')).toBe(true);
  });

  it('handles ё → е normalization', () => {
    expect(matchesKeyword('Войдите в кабинет', 'войдите')).toBe(true);
    // Goal uses ё, text has е — should still match.
    expect(matchesKeyword('Зайдете в личный', 'зайдёте')).toBe(true);
  });

  it('camelCase split is currently NEUTRALISED by toLowerCase ordering (known limitation)', () => {
    // KNOWN BUG inherited verbatim from legacy hybrid-semantic-weight.ts:
    // `normalizeText` calls `.toLowerCase()` BEFORE the
    // `/([a-z])([A-Z])/g` camelCase regex — so the regex never sees
    // any uppercase and never splits. As a result `'signInButton'`
    // becomes `'signinbutton'` (one token), not `['sign','in','button']`.
    // Pinned here so a future fix to normalizeText also updates this
    // test instead of silently changing prod behaviour. See `normalizeText`
    // for the rule order.
    expect(matchesKeyword('signInButton', 'sign')).toBe(false);
    expect(matchesKeyword('signInButton', 'signinbutton')).toBe(true);
    // Already-spaced camelCase works fine:
    expect(matchesKeyword('Sign In Button', 'sign')).toBe(true);
    expect(matchesKeyword('Sign In Button', 'in')).toBe(true);
  });

  it('normalises kebab/snake separators', () => {
    expect(matchesKeyword('add-to-cart', 'add')).toBe(true);
    expect(matchesKeyword('add_to_cart', 'cart')).toBe(true);
    expect(matchesKeyword('button.submit.primary', 'submit')).toBe(true);
  });

  it('matches multi-word keyword as token sequence', () => {
    expect(matchesKeyword('Click Sign In below', 'sign in')).toBe(true);
    expect(matchesKeyword('Sign Up for free', 'sign in')).toBe(false);
    // Multi-word in middle of sentence
    expect(matchesKeyword('Please Add To Cart now', 'add to cart')).toBe(true);
  });

  it('multi-word does NOT match across non-adjacent tokens', () => {
    // "sign" then "in" but with another word between → no match
    expect(matchesKeyword('Sign already in account', 'sign in')).toBe(false);
  });

  it('light EN stemming: ing/ed/s reduce both sides symmetrically', () => {
    // Stemming reduces both text and keyword tokens. Matches happen
    // when the *stems* line up. The stemming rules are deliberately
    // imperfect (suffix-strip without re-add): "logged" → "logg",
    // "submits" → "submit". So "log" matches "logging" only because
    // the keyword "log" is too short to be stemmed (minLen 4) and
    // the text token "logging" → "logg" — they don't match. This is
    // a known asymmetry; tests pin behaviour rather than wishful
    // intent.
    expect(matchesKeyword('Signing process', 'sign')).toBe(true);          // signing → sign, sign → sign
    expect(matchesKeyword('Submits the form', 'submit')).toBe(true);       // submits → submit, submit → submit
    expect(matchesKeyword('Applied filter', 'apply')).toBe(true);          // applied → apply, apply → apply
  });

  it('disabled stemming when useStemming=false', () => {
    expect(matchesKeyword('Signing process', 'sign', false)).toBe(false);
    expect(matchesKeyword('Submits form', 'submit', false)).toBe(false);
  });

  it('returns false on empty inputs', () => {
    expect(matchesKeyword('', 'submit')).toBe(false);
    expect(matchesKeyword('Submit', '')).toBe(false);
    expect(matchesKeyword('', '')).toBe(false);
  });
});

// ── isErrorElement ────────────────────────────────────────────────────

function makeEl(overrides: Partial<LiteElement> = {}): LiteElement {
  return {
    ref: 'e1',
    tag: 'div',
    name: '',
    visible: true,
    ...overrides,
  } as LiteElement;
}

describe('isErrorElement — fast path: ARIA role', () => {
  it('returns true on role="alert" regardless of text', () => {
    expect(isErrorElement(makeEl({ role: 'alert', name: '' }))).toBe(true);
    expect(isErrorElement(makeEl({ role: 'alert', name: 'Anything' }))).toBe(true);
  });
});

describe('isErrorElement — text-bearing detection', () => {
  it('detects error keyword in element name', () => {
    expect(isErrorElement(makeEl({ name: 'Invalid email address' }))).toBe(true);
    expect(isErrorElement(makeEl({ name: 'Login failed' }))).toBe(true);
  });

  it('detects error in htmlId', () => {
    expect(isErrorElement(makeEl({ htmlId: 'login-error' }))).toBe(true);
  });

  it('detects error in htmlName when camelCase form contains the bare keyword', () => {
    // KNOWN: camelCase split is neutralised by toLowerCase ordering
    // (see matchesKeyword test). 'errorMessage' → 'errormessage' single
    // token, which does NOT contain 'error' as a discrete token.
    // Pin actual behaviour: the kebab/snake separator path still works.
    expect(isErrorElement(makeEl({ htmlName: 'error-message' }))).toBe(true);
    expect(isErrorElement(makeEl({ htmlName: 'error_message' }))).toBe(true);
    // camelCase form without separator: NOT detected (acceptable
    // because real-world htmlName values usually use kebab/snake).
    expect(isErrorElement(makeEl({ htmlName: 'errorMessage' }))).toBe(false);
  });

  it('detects error in context (separator-based tokenisation)', () => {
    // Spaces / colons split into tokens; 'error' as a discrete token matches.
    expect(isErrorElement(makeEl({ context: 'inside: error dialog' }))).toBe(true);
  });

  it('Russian error keywords (no stemming for errors)', () => {
    // ERROR_KEYWORDS uses useStemming=false — tokens must match exactly.
    expect(isErrorElement(makeEl({ name: 'Ошибка входа' }))).toBe(true);
    // Must use the exact keyword form. 'Неверно введён' matches 'неверно',
    // but 'Неверный пароль' (different ending) does NOT — by design.
    expect(isErrorElement(makeEl({ name: 'Неверно введён код' }))).toBe(true);
  });

  it('returns false on neutral elements', () => {
    expect(isErrorElement(makeEl({ name: 'Submit Order' }))).toBe(false);
    expect(isErrorElement(makeEl({ name: 'Add to cart' }))).toBe(false);
    expect(isErrorElement(makeEl({}))).toBe(false);
  });

  it('does NOT use stemming (would over-trigger on "logo" → "log" etc)', () => {
    // Regression: ERROR_KEYWORDS must use exact-token, not stemmed.
    // Otherwise legitimate UI text like "Logo" would match the
    // "log" stem of "logging error".
    expect(isErrorElement(makeEl({ name: 'Logo image' }))).toBe(false);
  });
});
