/**
 * Universality guards for overlay-dismissal detection constants.
 *
 * These cover the non-English failure modes that the old English-only +
 * ASCII-`\b` regexes silently passed through:
 *   - destructive guard must veto "Удалить" / "删除" / "Löschen" (data-loss risk)
 *   - explicit close affordance must be language-agnostic (structural / ARIA / ×)
 *   - a generic non-English text button must NOT count as a close affordance
 */

import {
  DESTRUCTIVE_TEXT_REGEX,
  DESTRUCTIVE_WORDS,
  CLOSE_AFFORDANCE_FN_SOURCE,
} from '../modal-detection';

/** Minimal DOM element stub — only the surface CLOSE_AFFORDANCE_FN_SOURCE touches. */
function makeEl(opts: {
  attrs?: Record<string, string>;
  text?: string;
}): unknown {
  const attrs = opts.attrs ?? {};
  return {
    getAttribute: (name: string): string | null =>
      name in attrs ? attrs[name] : null,
    hasAttribute: (name: string): boolean => name in attrs,
    textContent: opts.text ?? '',
  };
}

// Reconstruct the in-page helper from its single-source string, exactly as the
// dismisser does inside page.evaluate.
const hasExplicitCloseAffordance = new Function(
  `${CLOSE_AFFORDANCE_FN_SOURCE} return hasExplicitCloseAffordance;`,
)() as (el: unknown) => boolean;

describe('DESTRUCTIVE_TEXT_REGEX — universality', () => {
  it('matches English destructive verbs', () => {
    expect(DESTRUCTIVE_TEXT_REGEX.test('Delete')).toBe(true);
    expect(DESTRUCTIVE_TEXT_REGEX.test('Log out')).toBe(true);
    expect(DESTRUCTIVE_TEXT_REGEX.test('logout')).toBe(true);
    expect(DESTRUCTIVE_TEXT_REGEX.test('Sign out')).toBe(true);
  });

  it('matches Cyrillic destructive verbs (the \\b bug)', () => {
    // The whole point: ASCII \b never matched these, so they were never penalized.
    expect(DESTRUCTIVE_TEXT_REGEX.test('Удалить')).toBe(true);
    expect(DESTRUCTIVE_TEXT_REGEX.test('Выйти')).toBe(true);
  });

  it('matches CJK destructive verbs', () => {
    expect(DESTRUCTIVE_TEXT_REGEX.test('删除')).toBe(true);
    expect(DESTRUCTIVE_TEXT_REGEX.test('ログアウト')).toBe(true);
    expect(DESTRUCTIVE_TEXT_REGEX.test('삭제')).toBe(true);
  });

  it('matches other-language destructive verbs', () => {
    expect(DESTRUCTIVE_TEXT_REGEX.test('Löschen')).toBe(true);
    expect(DESTRUCTIVE_TEXT_REGEX.test('Eliminar')).toBe(true);
    expect(DESTRUCTIVE_TEXT_REGEX.test('Supprimer')).toBe(true);
  });

  it('does NOT match benign close text', () => {
    expect(DESTRUCTIVE_TEXT_REGEX.test('Close')).toBe(false);
    expect(DESTRUCTIVE_TEXT_REGEX.test('Закрыть')).toBe(false);
    expect(DESTRUCTIVE_TEXT_REGEX.test('Accept all')).toBe(false);
  });

  it('keeps the word list and regex in sync (every word matches)', () => {
    for (const w of DESTRUCTIVE_WORDS) {
      expect(DESTRUCTIVE_TEXT_REGEX.test(w)).toBe(true);
    }
  });
});

describe('hasExplicitCloseAffordance — language-agnostic close detection', () => {
  it('accepts structural close attributes', () => {
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { 'data-dismiss': 'modal' } }))).toBe(true);
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { 'data-close': '' } }))).toBe(true);
  });

  it('accepts close/dismiss/btn-close classes', () => {
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { class: 'btn-close' } }))).toBe(true);
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { class: 'modal__close-button' } }))).toBe(true);
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { class: 'dismiss' } }))).toBe(true);
  });

  it('accepts close words in aria-label across languages', () => {
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { 'aria-label': 'Close' } }))).toBe(true);
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { 'aria-label': 'Закрыть' } }))).toBe(true);
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { 'aria-label': 'Cerrar' } }))).toBe(true);
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { 'aria-label': '关闭' } }))).toBe(true);
    expect(hasExplicitCloseAffordance(makeEl({ attrs: { 'aria-label': '닫기' } }))).toBe(true);
  });

  it('accepts a lone × glyph as text', () => {
    expect(hasExplicitCloseAffordance(makeEl({ text: '×' }))).toBe(true);
    expect(hasExplicitCloseAffordance(makeEl({ text: '✕' }))).toBe(true);
  });

  it('REJECTS a generic non-English text button (the universality default)', () => {
    // A plain "Continue"/"Продолжить"-style button is NOT a close control —
    // the dismiser must never click it to close an overlay.
    expect(hasExplicitCloseAffordance(makeEl({ text: 'Продолжить' }))).toBe(false);
    expect(hasExplicitCloseAffordance(makeEl({ text: 'Continue' }))).toBe(false);
    expect(hasExplicitCloseAffordance(makeEl({ text: 'Подписаться' }))).toBe(false);
  });

  it('REJECTS a destructive button even if it has no close affordance', () => {
    // Pairs with the dismisser's destructive veto: "Удалить" must never qualify.
    expect(hasExplicitCloseAffordance(makeEl({ text: 'Удалить' }))).toBe(false);
    expect(DESTRUCTIVE_TEXT_REGEX.test('Удалить')).toBe(true);
  });
});
