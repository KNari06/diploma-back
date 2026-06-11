import {
  typedValueLooksApplied,
  shouldRetryTypeWithFill,
  clearFieldBeforeType,
  verifyTypedValueAndRetry,
} from '../type-action.helpers';

// Minimal Locator stub — only the methods the helpers touch.
// `inputValues` is the queue of inputValue() reads (a string to return, or an
// Error instance to throw). Once the queue is exhausted, inputValue() throws so
// "unreadable" scenarios stay unreadable for every subsequent read.
function makeLocatorStub(inputValues: Array<string | Error>) {
  const reads = [...inputValues];
  const calls = { fill: [] as string[], press: [] as string[], focus: 0, click: 0 };
  const locator = {
    fill: async (v: string) => { calls.fill.push(v); },
    inputValue: async () => {
      if (reads.length === 0) throw new Error('no more reads queued (unreadable)');
      const next = reads.shift();
      if (next instanceof Error) throw next;
      return next as string;
    },
    focus: async () => { calls.focus += 1; },
    press: async (k: string) => { calls.press.push(k); },
    click: async () => { calls.click += 1; },
  };
  // Cast through unknown — the stub implements only the touched surface.
  return { locator: locator as unknown as import('playwright').Locator, calls };
}

// Page stub — only waitForTimeout is used by verifyTypedValueAndRetry.
const pageStub = { waitForTimeout: async () => {} } as unknown as import('playwright').Page;

describe('type-action.helpers', () => {
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

    // Finding 5 — symbol-only / dropped-trailing-special false-passes.
    it('detects a dropped trailing special char in a password', () => {
      expect(typedValueLooksApplied('Pass1!', 'Pass1')).toBe(false);
    });

    it('matches a symbol-bearing value that fully applied', () => {
      expect(typedValueLooksApplied('Pass1!', 'Pass1!')).toBe(true);
    });

    it('compares symbol-only values instead of blindly passing', () => {
      expect(typedValueLooksApplied('!@#$', '!@#$')).toBe(true);
      expect(typedValueLooksApplied('!@#$', '!@#')).toBe(false);
    });
  });

  describe('shouldRetryTypeWithFill', () => {
    it('retries on a dropped trailing char (masked phone)', () => {
      expect(shouldRetryTypeWithFill('+7 702 850 3640', '+7 702 850 364')).toBe(true);
    });

    it('does NOT retry on a multi-box OTP read (large gap would wipe a working entry)', () => {
      // resolved locator reads a single auto-advanced box
      expect(shouldRetryTypeWithFill('123456', '1')).toBe(false);
    });

    it('does NOT retry on a maxlength-capped / extra-char mismatch', () => {
      expect(shouldRetryTypeWithFill('1234', '12345')).toBe(false);
    });

    it('retries on a residual prefix (under-cleared field holds leftover + value)', () => {
      expect(shouldRetryTypeWithFill('Smith', 'JohnSmith')).toBe(true);
    });

    it('does NOT retry on an unrelated / garbled value', () => {
      expect(shouldRetryTypeWithFill('hello', 'world')).toBe(false);
    });

    it('does NOT retry when nothing was typed (empty read)', () => {
      expect(shouldRetryTypeWithFill('hello', '')).toBe(false);
    });
  });

  describe('clearFieldBeforeType', () => {
    it('does not select-all/Delete when the field is confirmed empty', async () => {
      const { locator, calls } = makeLocatorStub(['', '']); // read + confirm read, both empty
      await clearFieldBeforeType(locator, 5000);
      expect(calls.fill).toEqual(['']);
      expect(calls.focus).toBe(0);
      expect(calls.press).toEqual([]);
    });

    it('clears harder with select-all + Delete when residue remains (fill no-op)', async () => {
      // read 1: still has prior step's value; read 2: empty after select-all+Delete
      const { locator, calls } = makeLocatorStub(['+7 702 850 3640', '']);
      await clearFieldBeforeType(locator, 5000);
      expect(calls.fill).toEqual(['']);
      expect(calls.focus).toBe(1);
      expect(calls.press).toEqual(['ControlOrMeta+a', 'Delete']);
    });

    it('escalates when an empty field re-commits its old value (Finding 4a)', async () => {
      // read 1: empty; recheck: re-committed old value; post-clear read: empty
      const { locator, calls } = makeLocatorStub(['', '+7 702 850 3640', '']);
      await clearFieldBeforeType(locator, 5000);
      expect(calls.focus).toBe(1);
      expect(calls.press).toEqual(['ControlOrMeta+a', 'Delete']);
    });

    it('retries the read under contention before escalating (Finding 4b)', async () => {
      // read 1: contention timeout (null); retry read: residue; post-clear: empty
      const { locator, calls } = makeLocatorStub([new Error('timeout'), '+7 702 850 3640', '']);
      await clearFieldBeforeType(locator, 5000);
      expect(calls.focus).toBe(1);
      expect(calls.press).toEqual(['ControlOrMeta+a', 'Delete']);
    });

    it('fails open (no select-all/Delete) when the value stays unreadable', async () => {
      const { locator, calls } = makeLocatorStub([new Error('not an <input>'), new Error('still unreadable')]);
      await clearFieldBeforeType(locator, 5000);
      expect(calls.fill).toEqual(['']);
      expect(calls.focus).toBe(0);
      expect(calls.press).toEqual([]);
    });
  });

  describe('verifyTypedValueAndRetry', () => {
    it('repairs a dropped trailing char with fill()', async () => {
      // read-back stays dropped across the settle poll (initial + 5 polls), then
      // the gated fill() fires and the post-fill read is correct.
      const dropped = '+7 702 850 364';
      const { locator, calls } = makeLocatorStub([
        dropped, dropped, dropped, dropped, dropped, dropped, // initial + 5 polls
        '+7 702 850 3640', // post-fill read
      ]);
      await verifyTypedValueAndRetry(pageStub, locator, '+7 702 850 3640', 5000);
      expect(calls.fill).toEqual(['+7 702 850 3640']); // fill retry fired
    });

    it('does NOT fill() on a multi-box OTP mismatch (would wipe a working entry)', async () => {
      // resolved locator reads a single auto-advanced box across the whole poll —
      // gap too large → retry suppressed.
      const { locator, calls } = makeLocatorStub(['1', '1', '1', '1', '1', '1']);
      await verifyTypedValueAndRetry(pageStub, locator, '123456', 5000);
      expect(calls.fill).toEqual([]); // retry suppressed
    });

    it('does nothing when the value is already correct', async () => {
      const { locator, calls } = makeLocatorStub(['hello@example.com']);
      await verifyTypedValueAndRetry(pageStub, locator, 'hello@example.com', 5000);
      expect(calls.fill).toEqual([]);
    });

    it('skips verification when the value is unreadable', async () => {
      const { locator, calls } = makeLocatorStub([new Error('unreadable')]);
      await verifyTypedValueAndRetry(pageStub, locator, 'whatever', 5000);
      expect(calls.fill).toEqual([]);
    });
  });
});
