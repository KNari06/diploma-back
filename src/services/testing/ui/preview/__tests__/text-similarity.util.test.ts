import {
  foldText,
  tokenizeLabel,
  tokenOverlap,
  hasAnyOverlap,
  fuzzyEqual,
} from '../text-similarity.util';

describe('text-similarity', () => {
  describe('foldText', () => {
    it('folds Cyrillic glyph-twins to Latin (lowercase only)', () => {
      // Map covers both upper and lower Cyrillic codepoints, but always emits
      // Latin lowercase. Caller is responsible for any case-folding upstream.
      expect(foldText('МАТ-SMART')).toBe('mat-SMART');
      expect(foldText('мат')).toBe('mat');
      expect(foldText('Т. Бекнұр')).toMatch(/^t\./); // "Т" → "t"
    });
    it('strips combining diacritics', () => {
      expect(foldText('café')).toBe('cafe');
      expect(foldText('résumé')).toBe('resume');
    });
    it('leaves Kazakh-only letters alone (no Latin twin)', () => {
      // ұ (0x04B1) has no Latin glyph-twin — should pass through untouched.
      const out = foldText('Бекнұр');
      expect(out).toContain('ұ');
    });
    it('is idempotent on already-Latin ASCII', () => {
      expect(foldText('hello world')).toBe('hello world');
    });
  });

  describe('tokenizeLabel', () => {
    it('returns empty set for null/undefined/empty', () => {
      expect(tokenizeLabel(null).size).toBe(0);
      expect(tokenizeLabel(undefined).size).toBe(0);
      expect(tokenizeLabel('').size).toBe(0);
    });
    it('drops tokens shorter than 3 chars', () => {
      const t = tokenizeLabel('A B ok yes hi');
      expect(t.has('a')).toBe(false);
      expect(t.has('ok')).toBe(false); // 2 chars
      expect(t.has('yes')).toBe(true);
    });
    it('drops stopwords (the/for/что)', () => {
      const t = tokenizeLabel('Wait for URL');
      expect(t.has('for')).toBe(false);
      expect(t.has('wait')).toBe(true);
      expect(t.has('url')).toBe(true);
    });
    it('Cyrillic-Latin twin folding is symmetric for tokens', () => {
      const a = tokenizeLabel('MAT-SMART'); // Latin
      const b = tokenizeLabel('МАТ-SMART'); // Cyrillic М/А/Т
      expect(a).toEqual(b);
    });
    it('splits on Unicode word boundaries (multilingual)', () => {
      const t = tokenizeLabel('Архив, раздел / 2024');
      // Tokens are post-fold so several Cyrillic letters become Latin lookalikes.
      // The key contract is: same input on both sides → same token set, AND
      // separators / digits work correctly. Don't assert specific folded forms.
      expect(t.size).toBeGreaterThanOrEqual(3); // archive + razdel + 2024
      expect(t.has('2024')).toBe(true);
      // Same input round-trips deterministically.
      const t2 = tokenizeLabel('Архив, раздел / 2024');
      expect(t).toEqual(t2);
    });
    it('handles diacritics (NFD strip)', () => {
      const a = tokenizeLabel('café latte');
      const b = tokenizeLabel('cafe latte');
      expect(a).toEqual(b);
    });
  });

  describe('tokenOverlap', () => {
    it('returns 0 for disjoint sets', () => {
      const a = tokenizeLabel('MAT-SMART раздел');
      const b = tokenizeLabel('Б'); // single char → empty after filter
      expect(tokenOverlap(a, b)).toBe(0);
    });
    it('counts exact matches', () => {
      const a = tokenizeLabel('button login submit');
      const b = tokenizeLabel('login form submit');
      expect(tokenOverlap(a, b)).toBe(2);
    });
    it('counts morphological variants via substring', () => {
      const a = tokenizeLabel('раздел');
      const b = tokenizeLabel('разделах');
      expect(tokenOverlap(a, b)).toBeGreaterThanOrEqual(1);
    });
    it('counts Cyrillic-Latin glyph twins as match', () => {
      const a = tokenizeLabel('MAT-SMART');
      const b = tokenizeLabel('МАТ-SMART курс');
      expect(tokenOverlap(a, b)).toBeGreaterThanOrEqual(1);
    });
    it('returns 0 when one side is empty', () => {
      expect(tokenOverlap(new Set(), tokenizeLabel('hello'))).toBe(0);
      expect(tokenOverlap(tokenizeLabel('hello'), new Set())).toBe(0);
    });
  });

  describe('hasAnyOverlap', () => {
    it('short-circuits on first match', () => {
      const a = tokenizeLabel('alpha bravo charlie');
      const b = tokenizeLabel('xxxxx alpha yyyyy');
      expect(hasAnyOverlap(a, b)).toBe(true);
    });
    it('returns false for completely disjoint', () => {
      const a = tokenizeLabel('MAT-SMART раздел');
      const b = tokenizeLabel('профиль выход');
      expect(hasAnyOverlap(a, b)).toBe(false);
    });
    it('handles real wrong-element case (avatar vs course card)', () => {
      // The juz40-edu.kz step 8 incident:
      // recorded "МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды"
      // chosen "Б" (single-char avatar)
      const recorded = tokenizeLabel('МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды');
      const chosen = tokenizeLabel('Б');
      expect(recorded.size).toBeGreaterThan(0);
      expect(chosen.size).toBe(0); // 1-char filtered out
      expect(hasAnyOverlap(recorded, chosen)).toBe(false);
    });
  });

  describe('fuzzyEqual', () => {
    it('returns true for identical strings', () => {
      expect(fuzzyEqual('hello', 'hello')).toBe(true);
    });
    it('returns true for single-char typos in 5+ char tokens', () => {
      expect(fuzzyEqual('archive', 'arxhive')).toBe(true); // 1 substitution
    });
    it('rejects when length difference > 2', () => {
      expect(fuzzyEqual('hello', 'helloworld')).toBe(false);
    });
    it('rejects short tokens regardless of distance', () => {
      // "code" vs "node" (DL=2) — intentionally rejected to prevent false matches
      expect(fuzzyEqual('code', 'node')).toBe(false);
    });
    it('catches Damerau transposition', () => {
      expect(fuzzyEqual('archive', 'arcvihe')).toBe(true); // hi ↔ ih transpose + substitution
    });
  });
});
