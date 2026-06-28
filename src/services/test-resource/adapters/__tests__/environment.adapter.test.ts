/**
 * Tests for the EnvironmentAdapter — workspace-shared PUBLIC variables, applied
 * as {{env.NAME}}.
 *
 * Same validation family as the secret adapter, but with deliberate
 * differences that are pinned here: NO sensitive fields (env is plaintext),
 * empty-string values are ALLOWED (unlike secrets, where empty = a likely UI
 * bug), a smaller 4096-char value cap, and the `env.` apply prefix.
 */

import { environmentAdapter } from '../environment.adapter';
import type { ApplyContext } from '../../types';

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function validateConfig(config: unknown) {
  return environmentAdapter.validate({ config } as never);
}

describe('EnvironmentAdapter.validate', () => {
  it('accepts a well-formed variables map and normalizes it', () => {
    const res = validateConfig({ variables: { BASE_URL: 'https://stg.app', RETRIES: 3, FLAG: true } });
    expect(res.valid).toBe(true);
    expect(res.normalized?.config).toEqual({ variables: { BASE_URL: 'https://stg.app', RETRIES: 3, FLAG: true } });
  });

  it('rejects a missing / non-object / array variables field', () => {
    expect(validateConfig({}).valid).toBe(false);
    expect(validateConfig({ variables: 'nope' }).valid).toBe(false);
    expect(validateConfig({ variables: ['a'] }).valid).toBe(false);
  });

  it('rejects an empty variables object', () => {
    expect(validateConfig({ variables: {} }).valid).toBe(false);
  });

  it('rejects invalid names and reserved prefixes', () => {
    expect(validateConfig({ variables: { '1bad': 'v' } }).valid).toBe(false);
    expect(validateConfig({ variables: { 'has space': 'v' } }).valid).toBe(false);
    expect(validateConfig({ variables: { 'env.X': 'v' } }).valid).toBe(false);
    expect(validateConfig({ variables: { 'secrets.X': 'v' } }).valid).toBe(false);
  });

  it('detects a duplicate name after trimming and trims in the normalized output', () => {
    expect(validateConfig({ variables: { K: 'a', ' K ': 'b' } }).valid).toBe(false);
    const ok = validateConfig({ variables: { '  K  ': 'v' } });
    expect(Object.keys(ok.normalized!.config!.variables as object)).toEqual(['K']);
  });

  describe('value rules (differ from the secret adapter)', () => {
    it('ALLOWS an empty-string value (env is public config, not a credential)', () => {
      const res = validateConfig({ variables: { OPTIONAL: '' } });
      expect(res.valid).toBe(true);
      expect((res.normalized!.config!.variables as Record<string, unknown>).OPTIONAL).toBe('');
    });

    it('rejects a value over the 4096-char cap', () => {
      expect(validateConfig({ variables: { K: 'x'.repeat(4097) } }).valid).toBe(false);
      expect(validateConfig({ variables: { K: 'x'.repeat(4096) } }).valid).toBe(true);
    });

    it('rejects a non-finite number and an unsupported type', () => {
      expect(validateConfig({ variables: { K: Number.NaN } }).valid).toBe(false);
      expect(validateConfig({ variables: { K: { a: 1 } } }).valid).toBe(false);
    });

    it('accepts finite numbers and booleans', () => {
      expect(validateConfig({ variables: { N: 0, B: false } }).valid).toBe(true);
    });
  });

  it('caps reported errors at 10', () => {
    const variables: Record<string, string> = {};
    for (let i = 0; i < 20; i++) variables[`bad name ${i}`] = 'v';
    expect(validateConfig({ variables }).errors!.length).toBeLessThanOrEqual(10);
  });
});

describe('EnvironmentAdapter.apply', () => {
  function ctx() {
    const runVariables = new Map<string, unknown>();
    return { runVariables } as unknown as ApplyContext & { runVariables: Map<string, unknown> };
  }
  const resource = (variables: unknown) => ({ id: 'r1', name: 'Staging', config: { variables } }) as never;

  it('stamps each variable under the env. prefix', async () => {
    const c = ctx();
    await environmentAdapter.apply!(c, resource({ BASE_URL: 'https://stg', FLAG: true }));
    expect(c.runVariables.get('env.BASE_URL')).toBe('https://stg');
    expect(c.runVariables.get('env.FLAG')).toBe(true);
  });

  it('is a no-op when there are no variables', async () => {
    const c = ctx();
    await environmentAdapter.apply!(c, resource(undefined));
    expect(c.runVariables.size).toBe(0);
  });
});

describe('EnvironmentAdapter metadata', () => {
  it('has NO sensitive fields (plaintext public config)', () => {
    expect(environmentAdapter.sensitiveFields()).toEqual([]);
  });

  it('is always fresh', () => {
    expect(environmentAdapter.isFresh!({} as never)).toBe(true);
  });
});
