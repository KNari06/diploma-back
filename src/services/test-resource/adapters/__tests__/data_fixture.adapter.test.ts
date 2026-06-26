import { dataFixtureAdapter } from '../data_fixture.adapter';

const validate = (config: any): any => dataFixtureAdapter.validate({ config } as any);
const apply = async (data: any) => {
  const ctx: any = { runVariables: new Map() };
  await dataFixtureAdapter.apply(ctx, { id: 'r1', name: 'fx', config: { data } } as any);
  return ctx.runVariables;
};

describe('dataFixtureAdapter.validate', () => {
  it('rejects non-object data', () => {
    expect(validate({}).valid).toBe(false);
    expect(validate({ data: [] }).valid).toBe(false);
    expect(validate({ data: 'x' }).errors[0]).toMatch(/object of name/);
  });

  it('rejects empty data', () => {
    expect(validate({ data: {} }).valid).toBe(false);
  });

  it('accepts and normalizes string/number/boolean values', () => {
    const r = validate({ data: { name: 'Bob', age: 30, active: true } });
    expect(r.valid).toBe(true);
    expect(r.normalized).toEqual({ config: { data: { name: 'Bob', age: 30, active: true } } });
  });

  it('rejects an invalid key format', () => {
    expect(validate({ data: { '1bad': 'x' } }).errors[0]).toMatch(/invalid fixture key/);
  });

  it('rejects reserved-prefix keys', () => {
    const r = validate({ data: { 'env.HOST': 'x' } });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/reserved prefix/);
  });

  it('rejects duplicate keys after trimming', () => {
    const r = validate({ data: { a: 1, ' a ': 2 } });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e: string) => /duplicate/.test(e))).toBe(true);
  });

  it('rejects a value over the length cap', () => {
    expect(validate({ data: { big: 'x'.repeat(16385) } }).valid).toBe(false);
  });

  it('rejects non-finite numbers and non-scalar values', () => {
    expect(validate({ data: { n: Infinity } }).valid).toBe(false);
    expect(validate({ data: { o: { nested: true } } }).errors[0]).toMatch(/string \| number \| boolean/);
  });

  it('rejects too many keys', () => {
    const data: Record<string, number> = {};
    for (let i = 0; i < 201; i++) data[`k${i}`] = i;
    expect(validate({ data }).valid).toBe(false);
  });

  it('caps reported errors at 10', () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 20; i++) data[`env.k${i}`] = 'x'; // all reserved-prefix → 20 errors
    expect(validate({ data }).errors.length).toBeLessThanOrEqual(10);
  });
});

describe('dataFixtureAdapter.apply', () => {
  it('stamps each entry under the fixtures. prefix', async () => {
    const vars = await apply({ name: 'Bob', age: 30 });
    expect(vars.get('fixtures.name')).toBe('Bob');
    expect(vars.get('fixtures.age')).toBe(30);
  });

  it('is a no-op when there is no data', async () => {
    const ctx: any = { runVariables: new Map() };
    await dataFixtureAdapter.apply(ctx, { id: 'r1', name: 'fx', config: {} } as any);
    expect(ctx.runVariables.size).toBe(0);
  });

  it('overwrites the same keys idempotently', async () => {
    const ctx: any = { runVariables: new Map([['fixtures.name', 'old']]) };
    await dataFixtureAdapter.apply(ctx, { id: 'r1', name: 'fx', config: { data: { name: 'new' } } } as any);
    expect(ctx.runVariables.get('fixtures.name')).toBe('new');
  });
});

describe('dataFixtureAdapter — static contract', () => {
  it('exposes no sensitive fields and is always fresh', () => {
    expect(dataFixtureAdapter.sensitiveFields()).toEqual([]);
    expect(dataFixtureAdapter.isFresh!({} as any)).toBe(true);
    expect(dataFixtureAdapter.kind).toBe('data_fixture');
  });
});
