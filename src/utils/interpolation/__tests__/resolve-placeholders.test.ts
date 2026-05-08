import {
  resolvePlaceholders,
  mapSource,
  recordSource,
  type VariableSource,
} from '../resolve-placeholders';

describe('resolvePlaceholders', () => {
  describe('basic substitution', () => {
    it('replaces a single placeholder from a Map source', () => {
      const out = resolvePlaceholders('Hello {{name}}', [
        mapSource('extracted', new Map([['name', 'World']])),
      ]);
      expect(out).toBe('Hello World');
    });

    it('replaces multiple placeholders', () => {
      const out = resolvePlaceholders('{{a}}-{{b}}-{{a}}', [
        mapSource('m', new Map([['a', 'X'], ['b', 'Y']])),
      ]);
      expect(out).toBe('X-Y-X');
    });

    it('falls through to next source when first is undefined', () => {
      const out = resolvePlaceholders('{{key}}', [
        mapSource('first', new Map()),
        recordSource('second', { key: 'found' }),
      ]);
      expect(out).toBe('found');
    });

    it('first defined hit wins (priority order)', () => {
      const out = resolvePlaceholders('{{otp}}', [
        mapSource('scratchpad', new Map([['otp', 'fromScratchpad']])),
        recordSource('runVariables', { otp: 'fromRunVars' }),
      ]);
      expect(out).toBe('fromScratchpad');
    });
  });

  describe('non-string values', () => {
    it('coerces numbers and booleans via String()', () => {
      const out = resolvePlaceholders('count={{n}} active={{ok}}', [
        recordSource('m', { n: 42, ok: true }),
      ]);
      expect(out).toBe('count=42 active=true');
    });

    it('emits literal "null" for explicit null value', () => {
      const out = resolvePlaceholders('val={{x}}', [recordSource('m', { x: null })]);
      expect(out).toBe('val=null');
    });

    it('preserves falsy strings like empty / 0 / false', () => {
      // recordSource uses hasOwnProperty so { x: '' } is a defined hit.
      const out = resolvePlaceholders('[{{e}}|{{z}}|{{f}}]', [
        recordSource('m', { e: '', z: 0, f: false }),
      ]);
      expect(out).toBe('[|0|false]');
    });
  });

  describe('fail-open behaviour', () => {
    it('leaves unknown placeholders as literals', () => {
      const out = resolvePlaceholders('Hi {{missing}}', [recordSource('m', {})]);
      expect(out).toBe('Hi {{missing}}');
    });

    it('leaves _secret_ placeholders alone when no source knows them', () => {
      // Recipe-redaction owns the _secret_ namespace; the generic helper
      // must not consume them.
      const out = resolvePlaceholders('{{_secret_step42}}', [
        mapSource('extracted', new Map()),
      ]);
      expect(out).toBe('{{_secret_step42}}');
    });

    it('skips a source that throws and tries the next', () => {
      const flaky: VariableSource = {
        name: 'flaky',
        lookup: () => {
          throw new Error('boom');
        },
      };
      const out = resolvePlaceholders('{{k}}', [
        flaky,
        recordSource('safe', { k: 'rescued' }),
      ]);
      expect(out).toBe('rescued');
    });

    it('returns input unchanged when no sources are passed', () => {
      const out = resolvePlaceholders('{{k}}', []);
      expect(out).toBe('{{k}}');
    });

    it('fast-paths strings without `{{`', () => {
      const out = resolvePlaceholders('plain text', [
        mapSource('m', new Map([['k', 'v']])),
      ]);
      expect(out).toBe('plain text');
    });
  });

  describe('shape preservation', () => {
    it('returns non-strings unchanged', () => {
      // Helper is generic — passing through e.g. undefined / number must work.
      expect(resolvePlaceholders(undefined as unknown as string, [])).toBeUndefined();
      expect(resolvePlaceholders(42 as unknown as string, [])).toBe(42);
      expect(resolvePlaceholders(null as unknown as string, [])).toBeNull();
    });
  });

  describe('namespacing examples (env / secrets / fixtures)', () => {
    it('resolves env.* / secrets.* / fixtures.* from separate sources', () => {
      const env = recordSource('env', { 'env.BASE_URL': 'https://stg.app.com' });
      const secrets = recordSource('secrets', { 'secrets.STRIPE': 'sk_test_xxx' });
      const fixtures = recordSource('fixtures', { 'fixtures.testUser.email': 'qa@x.com' });

      const out = resolvePlaceholders(
        '{{env.BASE_URL}}/checkout?key={{secrets.STRIPE}}&u={{fixtures.testUser.email}}',
        [env, secrets, fixtures],
      );
      expect(out).toBe('https://stg.app.com/checkout?key=sk_test_xxx&u=qa@x.com');
    });

    it('scratchpad email.otp wins over a workspace var of same name', () => {
      const scratchpad = mapSource('extracted', new Map([['email.otp', '482917']]));
      const runVars = recordSource('runVars', { 'email.otp': 'STALE' });
      const out = resolvePlaceholders('Code: {{email.otp}}', [scratchpad, runVars]);
      expect(out).toBe('Code: 482917');
    });
  });
});
