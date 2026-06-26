import { scenarioSetupAdapter } from '../scenario_setup.adapter';

const validate = (config: any): any => scenarioSetupAdapter.validate({ config } as any);
const step = (over: any = {}) => ({ type: 'tap', ...over });

describe('scenarioSetupAdapter.validate — platform', () => {
  it('requires a platform', () => {
    expect(validate({ steps: [step()] }).valid).toBe(false);
    expect(validate({ steps: [step()] }).errors[0]).toMatch(/platform is required/);
  });

  it('rejects an unsupported platform', () => {
    expect(validate({ platform: 'desktop', steps: [step()] }).errors[0]).toMatch(/not supported/);
  });

  it('accepts a known platform and normalizes the config', () => {
    const r = validate({ platform: 'web', steps: [step({ type: 'goto', value: '/x' })] });
    expect(r.valid).toBe(true);
    expect(r.normalized.config.platform).toBe('web');
    expect(r.normalized.config.steps).toHaveLength(1);
    expect(r.normalized.config.appPackage).toBeUndefined();
  });

  it('includes a valid appPackage and rejects a non-string one', () => {
    const ok = validate({ platform: 'mobile_android', appPackage: 'com.x', steps: [step()] });
    expect(ok.normalized.config.appPackage).toBe('com.x');
    expect(validate({ platform: 'web', appPackage: 123, steps: [step()] }).valid).toBe(false);
  });
});

describe('scenarioSetupAdapter.validate — steps', () => {
  it('requires steps to be an array', () => {
    const r = validate({ platform: 'web', steps: 'nope' });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/steps must be an array/);
  });

  it('rejects an empty steps array', () => {
    expect(validate({ platform: 'web', steps: [] }).valid).toBe(false);
  });

  it('rejects a non-object step and a step missing type', () => {
    expect(validate({ platform: 'web', steps: [null] }).errors.some((e: string) => /must be an object/.test(e))).toBe(true);
    expect(validate({ platform: 'web', steps: [{}] }).errors.some((e: string) => /missing required string "type"/.test(e))).toBe(true);
  });

  it('requires a refSetupId on a use_setup step', () => {
    const r = validate({ platform: 'web', steps: [step({ type: 'use_setup' })] });
    expect(r.errors.some((e: string) => /refSetupId/.test(e))).toBe(true);
  });

  it('rejects a step value over the length cap', () => {
    const r = validate({ platform: 'web', steps: [step({ type: 'type', value: 'x'.repeat(8193) })] });
    expect(r.valid).toBe(false);
  });

  it('rejects more than the max number of steps', () => {
    const steps = Array.from({ length: 201 }, () => step());
    expect(validate({ platform: 'web', steps }).valid).toBe(false);
  });

  it('caps reported errors at 10', () => {
    const steps = Array.from({ length: 20 }, () => ({})); // 20 missing-type errors
    expect(validate({ platform: 'web', steps }).errors.length).toBeLessThanOrEqual(10);
  });
});

describe('scenarioSetupAdapter — passive apply & static contract', () => {
  it('apply is a no-op that does not touch runVariables', async () => {
    const ctx: any = { runVariables: new Map() };
    await scenarioSetupAdapter.apply(ctx, { id: 'r', name: 's', config: { platform: 'web', steps: [step()] } } as any);
    expect(ctx.runVariables.size).toBe(0);
  });

  it('exposes no sensitive fields, is always fresh, and reports its kind', () => {
    expect(scenarioSetupAdapter.sensitiveFields()).toEqual([]);
    expect(scenarioSetupAdapter.isFresh!({} as any)).toBe(true);
    expect(scenarioSetupAdapter.kind).toBe('scenario_setup');
  });
});
