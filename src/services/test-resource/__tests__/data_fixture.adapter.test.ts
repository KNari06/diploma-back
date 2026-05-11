import { dataFixtureAdapter } from '../adapters/data_fixture.adapter';
import type { ApplyContext, DecryptedResource } from '../types';

function buildResource(
  data: Record<string, unknown>,
): DecryptedResource<{ data: Record<string, string | number | boolean> }, Record<string, unknown>> {
  return {
    id: 'r1',
    kind: 'data_fixture',
    name: 'Sample User',
    scope: {},
    config: { data: data as Record<string, string | number | boolean> },
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

describe('dataFixtureAdapter.validate', () => {
  it('accepts a healthy data map', () => {
    const r = dataFixtureAdapter.validate({
      config: { data: { USER_EMAIL: 'demo@x.com', CART_QTY: 3, IS_VIP: true } },
    });
    expect(r.valid).toBe(true);
    expect(r.normalized?.config).toEqual({
      data: { USER_EMAIL: 'demo@x.com', CART_QTY: 3, IS_VIP: true },
    });
  });

  it('rejects missing data object', () => {
    const r = dataFixtureAdapter.validate({ config: {} });
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]).toMatch(/data must be an object/);
  });

  it('rejects array as data (must be plain object)', () => {
    const r = dataFixtureAdapter.validate({ config: { data: [1, 2, 3] } });
    expect(r.valid).toBe(false);
  });

  it('rejects empty data object', () => {
    const r = dataFixtureAdapter.validate({ config: { data: {} } });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /at least one entry/.test(e))).toBe(true);
  });

  it('rejects keys with reserved prefixes', () => {
    const r = dataFixtureAdapter.validate({
      config: { data: { 'fixtures.A': 'x' } },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /reserved prefix/.test(e))).toBe(true);
  });

  it('rejects all four reserved prefixes', () => {
    for (const bad of ['env.X', 'secrets.X', 'fixtures.X', 'email.X']) {
      const r = dataFixtureAdapter.validate({ config: { data: { [bad]: 'x' } } });
      expect(r.valid).toBe(false);
    }
  });

  it('rejects invalid name characters', () => {
    const r = dataFixtureAdapter.validate({
      config: { data: { 'with space': 'x' } },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects unsupported value types (object)', () => {
    const r = dataFixtureAdapter.validate({
      config: { data: { K: { nested: 'no' } } },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const r = dataFixtureAdapter.validate({
      config: { data: { K: Infinity as unknown as number } },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects values longer than 16 KB', () => {
    const big = 'x'.repeat(16385);
    const r = dataFixtureAdapter.validate({ config: { data: { K: big } } });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /exceeds 16384 chars/.test(e))).toBe(true);
  });

  it('accepts values up to 16 KB exactly', () => {
    const big = 'x'.repeat(16384);
    const r = dataFixtureAdapter.validate({ config: { data: { K: big } } });
    expect(r.valid).toBe(true);
  });

  it('rejects more than 200 keys', () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 201; i++) data[`K${i}`] = String(i);
    const r = dataFixtureAdapter.validate({ config: { data } });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /too many/.test(e))).toBe(true);
  });

  it('exposes no sensitive fields (plaintext only in slice 1)', () => {
    expect(dataFixtureAdapter.sensitiveFields()).toEqual([]);
  });

  it('isFresh always returns true', () => {
    expect(dataFixtureAdapter.isFresh!(buildResource({ A: 'a' }))).toBe(true);
  });
});

describe('dataFixtureAdapter.apply', () => {
  it('writes each entry into runVariables under fixtures. prefix', async () => {
    const ctx = buildCtx();
    await dataFixtureAdapter.apply(
      ctx,
      buildResource({ USER_EMAIL: 'demo@x.com', IS_VIP: true, CART_QTY: 3 }),
    );

    expect(ctx.runVariables.get('fixtures.USER_EMAIL')).toBe('demo@x.com');
    expect(ctx.runVariables.get('fixtures.IS_VIP')).toBe(true);
    expect(ctx.runVariables.get('fixtures.CART_QTY')).toBe(3);
    expect(ctx.runVariables.size).toBe(3);
  });

  it('is idempotent — re-applying overwrites the same keys', async () => {
    const ctx = buildCtx();
    await dataFixtureAdapter.apply(ctx, buildResource({ EMAIL: 'old@x.com' }));
    await dataFixtureAdapter.apply(ctx, buildResource({ EMAIL: 'new@x.com' }));
    expect(ctx.runVariables.get('fixtures.EMAIL')).toBe('new@x.com');
    expect(ctx.runVariables.size).toBe(1);
  });

  it('does NOT recursively interpolate values — placeholders pass through as literals', async () => {
    const ctx = buildCtx();
    ctx.runVariables.set('fixtures.B', 'resolved');
    await dataFixtureAdapter.apply(ctx, buildResource({ A: '{{fixtures.B}}' }));
    // A is kept literal — recursive interpolation is intentionally unsupported.
    expect(ctx.runVariables.get('fixtures.A')).toBe('{{fixtures.B}}');
  });

  it('does not throw on missing data (graceful no-op)', async () => {
    const ctx = buildCtx();
    await dataFixtureAdapter.apply(
      ctx,
      { ...buildResource({ X: 'x' }), config: {} as never },
    );
    expect(ctx.runVariables.size).toBe(0);
  });
});
