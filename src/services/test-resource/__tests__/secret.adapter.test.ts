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

/**
 * The shape `loadDecrypted` ACTUALLY returns: `values` was declared sensitive,
 * so it round-trips through the encrypted envelope and comes back under
 * `sensitive` — `config` stays empty. `buildResource` above models the
 * hand-built/normalized shape instead; both must apply.
 */
function buildDecryptedResource(
  values: Record<string, unknown>,
): DecryptedResource<{ values: Record<string, string | number | boolean> }, Record<string, unknown>> {
  return {
    ...buildResource(values),
    config: {} as never,
    sensitive: { values },
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

  it('applies values from the DECRYPTED envelope — the real loadDecrypted shape', async () => {
    // Regression guard. `values` is sensitive, so at runtime it arrives under
    // `sensitive` and `config` is empty. Reading only `config.values` made
    // apply() a silent no-op, so every `{{secrets.X}}` stayed unresolved and
    // credential-bearing tests failed to authenticate.
    const ctx = buildCtx();
    await secretAdapter.apply(
      ctx,
      buildDecryptedResource({ login_email: 'demo@qait.dev', login_password: 'password' }),
    );

    expect(ctx.runVariables.get('secrets.login_email')).toBe('demo@qait.dev');
    expect(ctx.runVariables.get('secrets.login_password')).toBe('password');
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

  it('THROWS when there are no values to apply, so a required binding fails loudly', async () => {
    // Fails closed on purpose: the applier only escalates on a throw, so a
    // silent no-op would report the binding as applied while every
    // {{secrets.X}} stayed unresolved — how the config-vs-sensitive read bug
    // hid for so long.
    const ctx = buildCtx();
    await expect(
      secretAdapter.apply(
        ctx,
        { ...buildResource({ X: 'x_long_enough' }), config: {} as never, sensitive: {} },
      ),
    ).rejects.toThrow(/no values to apply/i);
    expect(ctx.runVariables.size).toBe(0);
  });

  it('prefers the decrypted envelope over config when both are present', async () => {
    // Pins the `??` order. Flipping the operands would silently reintroduce the
    // bug for DB-loaded secrets, and every other test would still pass.
    const ctx = buildCtx();
    await secretAdapter.apply(ctx, {
      ...buildResource({ K: 'from_config' }),
      sensitive: { values: { K: 'from_envelope' } },
    });
    expect(ctx.runVariables.get('secrets.K')).toBe('from_envelope');
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
