/**
 * Recovering a human element name from a discovered step.
 *
 * A snapshot ref (`e7`) is meaningless to a reader and dead after a re-render,
 * so the generated negative case must not print one. The name is already
 * present in the positive step's description — `Clicked "Sign in" (button)` —
 * because the executor writes the resolved element's name into its output.
 */

import { extractElementLabel, elementLabelOr } from '../element-label';

describe('extractElementLabel', () => {
  it.each([
    ['Clicked "Sign in" (button)', 'Sign in'],
    ['Clicked "Submit" (input)', 'Submit'],
    ['Clicked "Add to cart" (button) — 1 new tab opened', 'Add to cart'],
    ['Clicked "Continue" (button) — navigated to /checkout', 'Continue'],
  ])('pulls the name out of %s', (description, expected) => {
    expect(extractElementLabel(description)).toBe(expected);
  });

  it('handles a non-English label — most UIs under test are not English', () => {
    expect(extractElementLabel('Clicked "Заказать" (button)')).toBe('Заказать');
    expect(extractElementLabel('Clicked "登录" (button)')).toBe('登录');
  });

  it('refuses an ephemeral ref masquerading as a name', () => {
    // Both the executor and the extractor can fall back to the raw ref; neither
    // fallback is a real name, and printing it is the bug this exists to stop.
    expect(extractElementLabel('Click "e7"')).toBeUndefined();
    expect(extractElementLabel('Clicked "E12" (button)')).toBeUndefined();
  });

  it('returns undefined when there is no quoted name at all', () => {
    expect(extractElementLabel('Clicked e7')).toBeUndefined();
    expect(extractElementLabel('Navigated to /cart')).toBeUndefined();
    expect(extractElementLabel('')).toBeUndefined();
    expect(extractElementLabel(undefined)).toBeUndefined();
  });

  it('keeps a name that merely CONTAINS a ref-like token', () => {
    // `e7` alone is a ref; "Save e7 config" is a real button label.
    expect(extractElementLabel('Clicked "Save e7 config" (button)')).toBe('Save e7 config');
  });

  it('trims surrounding whitespace rather than emitting a padded label', () => {
    expect(extractElementLabel('Clicked "  Sign in  " (button)')).toBe('Sign in');
  });

  it('ignores a quoted empty string', () => {
    expect(extractElementLabel('Clicked "" (button)')).toBeUndefined();
  });
});

describe('elementLabelOr', () => {
  it('prefers the real name', () => {
    expect(elementLabelOr('Clicked "Sign in" (button)', 'submit button')).toBe('Sign in');
  });

  it('falls back to a generic noun, never to the ref', () => {
    // "submit button" tells a reader more than "e7" does.
    expect(elementLabelOr('Click "e7"', 'submit button')).toBe('submit button');
    expect(elementLabelOr(undefined, 'submit button')).toBe('submit button');
  });
});
