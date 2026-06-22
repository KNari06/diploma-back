/**
 * Contract test for the centralized intent-keyword registry.
 *
 * Purpose: lock in the "every control-word family covers en + ru + kk" rule so
 * a future edit can't silently drop a language (the exact failure mode that
 * scattered the lists in the first place). The TYPE `MultiLangList` already
 * forces all three keys at compile time; this adds the runtime guarantees the
 * type can't express (non-empty buckets, working boundary regex, kk anchors).
 */

import {
  AFFIRMATIVE,
  CANCEL,
  REJECTION,
  CHITCHAT,
  CONFIRMATION_MARKERS,
  flattenLangs,
  toLangSet,
  toBoundaryRegex,
  type MultiLangList,
} from '@/config/testing/intent-keywords';

const FAMILIES: Record<string, MultiLangList> = {
  AFFIRMATIVE,
  CANCEL,
  REJECTION,
  CHITCHAT,
  CONFIRMATION_MARKERS,
};

describe('intent-keywords registry contract', () => {
  describe('every family covers all three product languages', () => {
    for (const [name, list] of Object.entries(FAMILIES)) {
      it(`${name} has non-empty en / ru / kk buckets`, () => {
        expect(list.en.length).toBeGreaterThan(0);
        expect(list.ru.length).toBeGreaterThan(0);
        expect(list.kk.length).toBeGreaterThan(0);
      });

      it(`${name} kk bucket contains real Kazakh (Cyrillic) words`, () => {
        // At least one kk entry must contain a Cyrillic letter — guards against
        // someone "filling" kk with Latin placeholders to satisfy the type.
        const hasCyrillic = list.kk.some((w) => /[Ѐ-ӿ]/.test(w));
        expect(hasCyrillic).toBe(true);
      });

      it(`${name} entries are all lowercase + trimmed`, () => {
        for (const w of flattenLangs(list)) {
          expect(w).toBe(w.trim());
          expect(w).toBe(w.toLowerCase());
        }
      });
    }
  });

  describe('canonical anchor words are present (catch accidental deletions)', () => {
    it('AFFIRMATIVE covers yes / да / иә', () => {
      const s = toLangSet(AFFIRMATIVE);
      expect(s.has('yes')).toBe(true);
      expect(s.has('да')).toBe(true);
      expect(s.has('иә')).toBe(true);
    });

    it('CANCEL covers cancel / отмена / тоқта', () => {
      const s = toLangSet(CANCEL);
      expect(s.has('cancel')).toBe(true);
      expect(s.has('отмена')).toBe(true);
      expect(s.has('тоқта')).toBe(true);
    });

    it('REJECTION covers no / нет / жоқ', () => {
      const s = toLangSet(REJECTION);
      expect(s.has('no')).toBe(true);
      expect(s.has('нет')).toBe(true);
      expect(s.has('жоқ')).toBe(true);
    });
  });

  describe('toBoundaryRegex is unicode-aware (matches Cyrillic, not just ASCII)', () => {
    const confirm = toBoundaryRegex(AFFIRMATIVE);
    const cancel = toBoundaryRegex(CANCEL);

    it('matches whole-word affirmatives across languages', () => {
      expect(confirm.test('yes')).toBe(true);
      expect(confirm.test('да')).toBe(true);
      expect(confirm.test('иә')).toBe(true);
      expect(confirm.test('жарайды, бастаймыз')).toBe(true); // word + trailing text
    });

    it('matches Cyrillic cancel words — the \\b ASCII trap regression', () => {
      expect(cancel.test('тоқта')).toBe(true);
      expect(cancel.test('отмена')).toBe(true);
    });

    it('does NOT match a longer word that merely starts with a keyword', () => {
      // boundary `(?![\p{L}\p{N}])` → "yesterday" must not match "yes"
      expect(confirm.test('yesterday')).toBe(false);
      // "нетронутый" must not match "нет"
      expect(toBoundaryRegex(REJECTION).test('нетронутый')).toBe(false);
    });
  });

  it('families do not contain duplicate entries within a single language', () => {
    for (const [name, list] of Object.entries(FAMILIES)) {
      for (const lang of ['en', 'ru', 'kk'] as const) {
        const arr = list[lang];
        const unique = new Set(arr);
        expect(`${name}.${lang}: ${arr.length}`).toBe(`${name}.${lang}: ${unique.size}`);
      }
    }
  });
});
