import { secretAdapter } from '../adapters/secret.adapter';
import type { ApplyContext, DecryptedResource } from '../types';

function buildResource(
  values: Record<string, unknown>,
): DecryptedResource<{ values: Record<string, string | number | boolean> }, Record<string, unknown>> {
  return {
    id: 'r-secret',
    kind: 'secret',
    name: 'Stripe keys',
    scope: {},
    config: { values: values as Record<string, string | number | boolean> },
    sensitive: {},
    status: 'active',
    refreshMethod: 'none',
    recipe: [],
  };
}

function buildCtx(): ApplyContext {
  return {
    userId: 'u',
    projectId: 'p',
    runVariables: new Map<string, unknown>(),
  };
}

describe('secretAdapter.sensitiveFields', () => {
  it('declares the values blob as the single sensitive field', () => {
    expect(secretAdapter.sensitiveFields()).toEqual(['values']);
  });
});

describe('secretAdapter.validate', () => {
  it('accepts a healthy values map', () => {
    const r = secretAdapter.validate({
      config: { values: { STRIPE: 'sk_test_xxx', TWILIO: 'tok_yyy', RETRY: 3 } },
    });
    expect(r.valid).toBe(true);
    expect(r.normalized?.config).toEqual({
      values: { STRIPE: 'sk_test_xxx', TWILIO: 'tok_yyy', RETRY: 3 },
    });
  });

  it('rejects missing values object', () => {
    const r = secretAdapter.validate({ config: {} });
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]).toMatch(/values must be an object/);
  });

  it('rejects array as values', () => {
    const r = secretAdapter.validate({ config: { values: [] } });
    expect(r.valid).toBe(false);
  });

  it('rejects empty values object', () => {
    const r = secretAdapter.validate({ config: { values: {} } });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /at least one entry/.test(e))).toBe(true);
  });

  it('rejects unexpected top-level fields (so they don\'t leak in plaintext)', () => {
    const r = secretAdapter.validate({
      config: {
        values: { K: 'v_long_enough' },
        // `description` would be plaintext if we accepted it here.
        description: 'production stripe',
      },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /unexpected fields at top level/.test(e))).toBe(true);
  });

  it('rejects names with reserved prefixes', () => {
    const r = secretAdapter.validate({
      config: { values: { 'secrets.NESTED': 'x_long' } },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects empty string values (likely UI bug)', () => {
    const r = secretAdapter.validate({ config: { values: { K: '' } } });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /value for "K" is empty/.test(e))).toBe(true);
  });

  it('rejects non-finite numbers', () => {
    const r = secretAdapter.validate({
      config: { values: { K: Infinity as unknown as number } },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects unsupported value types', () => {
    const r = secretAdapter.validate({
      config: { values: { K: { nested: 'no' } } },
    });
    expect(r.valid).toBe(false);
  });
});

describe('secretAdapter.apply', () => {
  it('writes each value into runVariables under secrets. prefix', async () => {
    const ctx = buildCtx();
    await secretAdapter.apply(
      ctx,
      buildResource({ STRIPE: 'sk_test_xxx', TWILIO: 'tok_yyy' }),
    );

    expect(ctx.runVariables.get('secrets.STRIPE')).toBe('sk_test_xxx');
    expect(ctx.runVariables.get('secrets.TWILIO')).toBe('tok_yyy');
    expect(ctx.runVariables.size).toBe(2);
  });

  it('coexists with environment vars in the same Map (different prefix)', async () => {
    const ctx = buildCtx();
    ctx.runVariables.set('env.BASE_URL', 'https://stg.app.com');
    await secretAdapter.apply(ctx, buildResource({ K: 'v_long_enough' }));

    expect(ctx.runVariables.get('env.BASE_URL')).toBe('https://stg.app.com');
    expect(ctx.runVariables.get('secrets.K')).toBe('v_long_enough');
  });

  it('is idempotent — re-applying overwrites the same keys', async () => {
    const ctx = buildCtx();
    await secretAdapter.apply(ctx, buildResource({ STRIPE: 'old_value' }));
    await secretAdapter.apply(ctx, buildResource({ STRIPE: 'new_value' }));
    expect(ctx.runVariables.get('secrets.STRIPE')).toBe('new_value');
    expect(ctx.runVariables.size).toBe(1);
  });

  it('does not throw on missing values (graceful no-op)', async () => {
    const ctx = buildCtx();
    await secretAdapter.apply(
      ctx,
      { ...buildResource({ X: 'x_long_enough' }), config: {} as never },
    );
    expect(ctx.runVariables.size).toBe(0);
  });
});

describe('secretAdapter — interaction with redactSecrets', () => {
  it('values applied here are picked up by collectSecretValues', async () => {
    const ctx = buildCtx();
    await secretAdapter.apply(
      ctx,
      buildResource({ STRIPE: 'sk_test_long_enough_to_redact' }),
    );

    // Re-import inside the test to keep paths colocated visibly.
    const { collectSecretValues, redactSecrets } = require('@/utils/interpolation/redact-secrets');
    const values = collectSecretValues(ctx.runVariables);
    expect(values).toEqual(['sk_test_long_enough_to_redact']);

    expect(
      redactSecrets('Bearer sk_test_long_enough_to_redact', ctx.runVariables),
    ).toBe('Bearer ***');
  });
});
