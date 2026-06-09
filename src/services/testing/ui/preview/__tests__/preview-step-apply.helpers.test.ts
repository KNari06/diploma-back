import {
  globToRegexPatternForWaitFor,
  normalizeTypeActionValue,
  typedValueLooksApplied,
  clearFieldBeforeType,
} from '../preview-step-apply.service';

// Minimal Locator stub — only the methods clearFieldBeforeType touches.
// `inputValues` is the queue of inputValue() reads (string, or Error to throw).
function makeLocatorStub(inputValues: Array<string | Error>) {
  const reads = [...inputValues];
  const calls = { fill: [] as string[], press: [] as string[], focus: 0 };
  const locator = {
    fill: async (v: string) => { calls.fill.push(v); },
    inputValue: async () => {
      const next = reads.shift();
      if (next instanceof Error) throw next;
      return next ?? '';
    },
    focus: async () => { calls.focus += 1; },
    press: async (k: string) => { calls.press.push(k); },
  };
  // Cast through unknown — the stub implements only the touched surface.
  return { locator: locator as unknown as import('playwright').Locator, calls };
}

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

  describe('typedValueLooksApplied', () => {
    it('detects a dropped trailing character (masked phone bug)', () => {
      expect(typedValueLooksApplied('+7 702 850 3640', '+7 702 850 364')).toBe(false);
    });

    it('ignores pure formatting differences from a mask', () => {
      expect(typedValueLooksApplied('+7 702 850 3640', '+7 (702) 850-36-40')).toBe(true);
    });

    it('matches when the value is fully applied', () => {
      expect(typedValueLooksApplied('+7 702 850 3640', '+7 702 850 3640')).toBe(true);
    });

    it('is case-insensitive for text fields', () => {
      expect(typedValueLooksApplied('user@Example.com', 'USER@example.COM')).toBe(true);
    });

    it('detects an extra character', () => {
      expect(typedValueLooksApplied('1234', '12345')).toBe(false);
    });

    it('skips verification when nothing meaningful was expected', () => {
      expect(typedValueLooksApplied('', '')).toBe(true);
      expect(typedValueLooksApplied('   ', 'anything')).toBe(true);
    });
  });

  describe('clearFieldBeforeType', () => {
    it('does not select-all/Delete when the initial clear already emptied the field', async () => {
      const { locator, calls } = makeLocatorStub(['']); // first read: empty
      await clearFieldBeforeType(locator, 5000);
      expect(calls.fill).toEqual(['']);
      expect(calls.focus).toBe(0);
      expect(calls.press).toEqual([]);
    });

    it('clears harder with select-all + Delete when the field still has content (consecutive-step bug)', async () => {
      // read 1: still has prior step's value; read 2: empty after select-all+Delete
      const { locator, calls } = makeLocatorStub(['+7 702 850 3640', '']);
      await clearFieldBeforeType(locator, 5000);
      expect(calls.fill).toEqual(['']);
      expect(calls.focus).toBe(1);
      expect(calls.press).toEqual(['ControlOrMeta+a', 'Delete']);
    });

    it('fails open (no select-all/Delete) when the value is unreadable', async () => {
      const { locator, calls } = makeLocatorStub([new Error('not an <input>')]);
      await clearFieldBeforeType(locator, 5000);
      expect(calls.fill).toEqual(['']);
      expect(calls.focus).toBe(0);
      expect(calls.press).toEqual([]);
    });
  });
});
