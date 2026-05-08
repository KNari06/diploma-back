import { environmentAdapter } from '../adapters/environment.adapter';
import type { ApplyContext, DecryptedResource } from '../types';

function buildResource(
  variables: Record<string, unknown>,
): DecryptedResource<{ variables: Record<string, string | number | boolean> }, Record<string, unknown>> {
  return {
    id: 'r1',
    kind: 'environment',
    name: 'Staging',
    scope: {},
    config: { variables: variables as Record<string, string | number | boolean> },
    sensitive: {},
    status: 'active',
    refreshMethod: 'none',
    recipe: [],
  };
}

function buildCtx(): ApplyContext {
  return {
    userId: 'u1',
    projectId: 'p1',
    runVariables: new Map<string, unknown>(),
  };
}

describe('environmentAdapter.validate', () => {
  it('accepts a healthy variables map', () => {
    const r = environmentAdapter.validate({
      config: { variables: { BASE_URL: 'https://stg.app.com', FEATURE_X: true, RETRY: 3 } },
    });
    expect(r.valid).toBe(true);
    expect(r.normalized?.config).toEqual({
      variables: { BASE_URL: 'https://stg.app.com', FEATURE_X: true, RETRY: 3 },
    });
  });

  it('rejects missing variables object', () => {
    const r = environmentAdapter.validate({ config: {} });
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]).toMatch(/variables must be an object/);
  });

  it('rejects array as variables (must be plain object)', () => {
    const r = environmentAdapter.validate({ config: { variables: [1, 2, 3] } });
    expect(r.valid).toBe(false);
  });

  it('rejects empty variables object', () => {
    const r = environmentAdapter.validate({ config: { variables: {} } });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /at least one entry/.test(e))).toBe(true);
  });

  it('rejects names with reserved prefixes', () => {
    const r = environmentAdapter.validate({
      config: { variables: { 'env.BASE_URL': 'x' } },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /reserved prefix/.test(e))).toBe(true);
  });

  it('rejects invalid name characters', () => {
    const r = environmentAdapter.validate({
      config: { variables: { 'with space': 'x' } },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects unsupported value types (object / null)', () => {
    const r = environmentAdapter.validate({
      config: { variables: { K: { nested: 'no' } } },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const r = environmentAdapter.validate({
      config: { variables: { K: Infinity as unknown as number } },
    });
    expect(r.valid).toBe(false);
  });

  it('exposes no sensitive fields', () => {
    expect(environmentAdapter.sensitiveFields()).toEqual([]);
  });

  it('isFresh always returns true', () => {
    expect(environmentAdapter.isFresh!(buildResource({ A: 'a' }))).toBe(true);
  });
});

describe('environmentAdapter.apply', () => {
  it('writes each variable into runVariables under env. prefix', async () => {
    const ctx = buildCtx();
    await environmentAdapter.apply(
      ctx,
      buildResource({ BASE_URL: 'https://stg.app.com', FEATURE_X: true, RETRY: 3 }),
    );

    expect(ctx.runVariables.get('env.BASE_URL')).toBe('https://stg.app.com');
    expect(ctx.runVariables.get('env.FEATURE_X')).toBe(true);
    expect(ctx.runVariables.get('env.RETRY')).toBe(3);
    expect(ctx.runVariables.size).toBe(3);
  });

  it('is idempotent — re-applying overwrites the same keys', async () => {
    const ctx = buildCtx();
    await environmentAdapter.apply(ctx, buildResource({ BASE_URL: 'old' }));
    await environmentAdapter.apply(ctx, buildResource({ BASE_URL: 'new' }));
    expect(ctx.runVariables.get('env.BASE_URL')).toBe('new');
    expect(ctx.runVariables.size).toBe(1);
  });

  it('does not throw on missing variables (graceful no-op)', async () => {
    const ctx = buildCtx();
    await environmentAdapter.apply(
      ctx,
      // Force an invalid shape to mimic a corrupted DB row.
      { ...buildResource({ X: 'x' }), config: {} as never },
    );
    expect(ctx.runVariables.size).toBe(0);
  });
});
