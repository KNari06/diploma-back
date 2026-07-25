/**
 * Tests for the SecretAdapter — workspace-shared encrypted secrets injected as
 * {{secrets.NAME}} at run time.
 *
 * validate() is the security gate: a malformed name that slips through later
 * surfaces as a literal `{{secrets.foo}}` on the page instead of substituting
 * (leak + broken test), and a reserved-prefix name could shadow env/fixtures.
 * apply() must stamp every secret into runVariables and never log values.
 */

import { secretAdapter } from '../secret.adapter';
import type { ApplyContext } from '../../types';

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function validateConfig(config: unknown) {
  return secretAdapter.validate({ config } as never);
}

describe('SecretAdapter.validate', () => {
  it('accepts a well-formed values map and normalizes it', () => {
    const res = validateConfig({ values: { STRIPE_TEST_KEY: 'sk_test_x', RETRIES: 3, FLAG: true } });
    expect(res.valid).toBe(true);
    expect(res.normalized?.config).toEqual({ values: { STRIPE_TEST_KEY: 'sk_test_x', RETRIES: 3, FLAG: true } });
  });

  it('rejects unknown top-level keys (no plaintext metadata leak)', () => {
    const res = validateConfig({ values: { K: 'v' }, description: 'prod stripe' });
    expect(res.valid).toBe(false);
    expect(res.errors?.join(' ')).toMatch(/unexpected fields at top level: description/);
  });

  it('rejects a missing / non-object / array values field', () => {
    expect(validateConfig({}).valid).toBe(false);
    expect(validateConfig({ values: 'nope' }).valid).toBe(false);
    expect(validateConfig({ values: ['a'] }).valid).toBe(false);
  });

  it('rejects an empty values object', () => {
    const res = validateConfig({ values: {} });
    expect(res.valid).toBe(false);
    expect(res.errors?.join(' ')).toMatch(/at least one entry/);
  });

  it('rejects invalid secret names (must match KEY_RE)', () => {
    for (const bad of ['1leading', 'has space', 'weird!', 'a$b']) {
      const res = validateConfig({ values: { [bad]: 'v' } });
      expect(res.valid).toBe(false);
      expect(res.errors?.join(' ')).toMatch(/invalid secret name/);
    }
  });

  it('accepts valid names with letters/digits/_/-/.', () => {
    expect(validateConfig({ values: { 'A_b-1.x': 'v' } }).valid).toBe(true);
  });

  it.each(['env.FOO', 'secrets.BAR', 'fixtures.BAZ', 'email.X'])(
    'rejects a reserved-prefix name %s',
    (name) => {
      const res = validateConfig({ values: { [name]: 'v' } });
      expect(res.valid).toBe(false);
      expect(res.errors?.join(' ')).toMatch(/reserved prefix/);
    },
  );

  it('detects a duplicate name after trimming', () => {
    const res = validateConfig({ values: { KEY: 'a', ' KEY ': 'b' } });
    expect(res.valid).toBe(false);
    expect(res.errors?.join(' ')).toMatch(/duplicate secret name/);
  });

  it('trims the name in the normalized output', () => {
    const res = validateConfig({ values: { '  TOKEN  ': 'v' } });
    expect(res.valid).toBe(true);
    expect(Object.keys(res.normalized!.config!.values as object)).toEqual(['TOKEN']);
  });

  describe('value rules', () => {
    it('rejects an empty-string value (likely a UI bug, not a deletion)', () => {
      expect(validateConfig({ values: { K: '' } }).valid).toBe(false);
    });

    it('rejects a value over the 64KiB ceiling', () => {
      const res = validateConfig({ values: { K: 'x'.repeat(64 * 1024 + 1) } });
      expect(res.valid).toBe(false);
      expect(res.errors?.join(' ')).toMatch(/exceeds/);
    });

    it('rejects a non-finite number', () => {
      expect(validateConfig({ values: { K: Number.POSITIVE_INFINITY } }).valid).toBe(false);
    });

    it('rejects an unsupported value type (object / null)', () => {
      expect(validateConfig({ values: { K: { nested: 1 } } }).valid).toBe(false);
      expect(validateConfig({ values: { K: null } }).valid).toBe(false);
    });

    it('accepts finite numbers and booleans', () => {
      expect(validateConfig({ values: { N: 0, B: false } }).valid).toBe(true);
    });
  });

  it('caps the reported errors at 10', () => {
    const values: Record<string, string> = {};
    for (let i = 0; i < 20; i++) values[`bad name ${i}`] = 'v'; // each has a space → invalid
    const res = validateConfig({ values });
    expect(res.valid).toBe(false);
    expect(res.errors!.length).toBeLessThanOrEqual(10);
  });
});

describe('SecretAdapter.apply', () => {
  function ctx() {
    const runVariables = new Map<string, unknown>();
    return { runVariables } as unknown as ApplyContext & { runVariables: Map<string, unknown> };
  }
  function resource(values: unknown) {
    return { id: 'r1', name: 'creds', config: { values } } as never;
  }

  it('stamps every secret into runVariables under the secrets. prefix', async () => {
    const c = ctx();
    await secretAdapter.apply!(c, resource({ STRIPE: 'sk_x', TOKEN: 'tok_y' }));
    expect(c.runVariables.get('secrets.STRIPE')).toBe('sk_x');
    expect(c.runVariables.get('secrets.TOKEN')).toBe('tok_y');
  });

  it('THROWS when there are no values, so a required binding fails loudly', async () => {
    const c = ctx();
    await expect(secretAdapter.apply!(c, resource(undefined))).rejects.toThrow(/no values to apply/i);
    expect(c.runVariables.size).toBe(0);
  });

  it('applies values from the DECRYPTED envelope — the real loadDecrypted shape', async () => {
    // Regression guard, duplicated from the sibling suite in
    // test-resource/__tests__/ so it lives wherever someone looks. `values` is
    // sensitive, so at runtime it arrives under `sensitive` and `config` is
    // empty; reading only `config.values` made apply() a silent no-op and left
    // every {{secrets.X}} unresolved.
    const c = ctx();
    await secretAdapter.apply!(c, {
      id: 'r1', name: 'creds', config: {}, sensitive: { values: { LOGIN: 'demo' } },
    } as never);
    expect(c.runVariables.get('secrets.LOGIN')).toBe('demo');
  });

  it('logs key NAMES but never secret VALUES', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { logger } = require('@/utils/core/logger');
    const c = ctx();
    await secretAdapter.apply!(c, resource({ STRIPE: 'sk_super_secret_value' }));
    const logged = JSON.stringify((logger.debug as jest.Mock).mock.calls);
    expect(logged).toContain('STRIPE'); // name ok
    expect(logged).not.toContain('sk_super_secret_value'); // value must not leak
  });
});

describe('SecretAdapter metadata', () => {
  it('declares values as the only sensitive field', () => {
    expect(secretAdapter.sensitiveFields()).toEqual(['values']);
  });

  it('is always fresh (static config never expires)', () => {
    expect(secretAdapter.isFresh!({} as never)).toBe(true);
  });
});
