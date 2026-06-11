import {
  globToRegexPatternForWaitFor,
  normalizeTypeActionValue,
} from '../preview-step-apply.service';

// Note: the type-action helpers (typedValueLooksApplied / shouldRetryTypeWithFill
// / clearFieldBeforeType / verifyTypedValueAndRetry) were extracted to
// `type-action.helpers.ts` — their tests live in `type-action.helpers.test.ts`.

describe('preview-step-apply helpers', () => {
  describe('globToRegexPatternForWaitFor', () => {
    it('keeps ** and * semantics without replacement collisions', () => {
      const pattern = globToRegexPatternForWaitFor('https://site.com/**/users/*');
      const anchored = new RegExp(`^${pattern}$`);

      expect(anchored.test('https://site.com/admin/users/42')).toBe(true);
      expect(anchored.test('https://site.com/a/b/c/users/john')).toBe(true);
      expect(anchored.test('https://site.com/users/42/profile')).toBe(false);
    });

    it('supports ? wildcard and escaped literals', () => {
      const pattern = globToRegexPatternForWaitFor('https://x.com/path?/v*');
      const anchored = new RegExp(`^${pattern}$`);

      expect(anchored.test('https://x.com/path1/v2')).toBe(true);
      expect(anchored.test('https://x.com/pathA/value')).toBe(true);
      expect(anchored.test('https://x.com/path12/v2')).toBe(false);
    });

    it('treats escaped wildcard chars as literals', () => {
      const pattern = globToRegexPatternForWaitFor('https://x.com/file\\*\\?.txt');
      const anchored = new RegExp(`^${pattern}$`);

      expect(anchored.test('https://x.com/file*?.txt')).toBe(true);
      expect(anchored.test('https://x.com/fileAB.txt')).toBe(false);
    });

    it('matches trailing backslash literally', () => {
      const pattern = globToRegexPatternForWaitFor('https://x.com/path\\');
      const anchored = new RegExp(`^${pattern}$`);

      expect(anchored.test('https://x.com/path\\')).toBe(true);
      expect(anchored.test('https://x.com/path')).toBe(false);
    });
  });

  describe('normalizeTypeActionValue', () => {
    it('preserves leading/trailing whitespace', () => {
      expect(normalizeTypeActionValue('  hello  ')).toBe('  hello  ');
    });

    it('preserves multiline input', () => {
      expect(normalizeTypeActionValue('line1\nline2\n')).toBe('line1\nline2\n');
    });

    it('returns empty string for undefined', () => {
      expect(normalizeTypeActionValue(undefined)).toBe('');
    });
  });
});
