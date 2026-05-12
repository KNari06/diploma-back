import { scenarioSetupAdapter } from '../adapters/scenario_setup.adapter';
import type { ApplyContext, DecryptedResource } from '../types';

function buildResource(
  config: Record<string, unknown>,
): DecryptedResource<Record<string, unknown>, Record<string, unknown>> {
  return {
    id: 'r1',
    kind: 'scenario_setup',
    name: 'Login + Cart',
    scope: {},
    config,
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

describe('scenarioSetupAdapter.validate', () => {
  it('accepts a minimal healthy setup', () => {
    const r = scenarioSetupAdapter.validate({
      config: {
        platform: 'mobile_android',
        steps: [
          { type: 'tap', description: 'Email field' },
          { type: 'type', description: 'Email field', value: '{{secrets.email}}' },
        ],
      },
    });
    expect(r.valid).toBe(true);
    expect(r.normalized?.config.platform).toBe('mobile_android');
    expect((r.normalized?.config.steps as unknown[]).length).toBe(2);
  });

  it('accepts a setup with use_setup nested ref', () => {
    const r = scenarioSetupAdapter.validate({
      config: {
        platform: 'mobile_android',
        steps: [
          { type: 'use_setup', refSetupId: 'uuid-other' },
          { type: 'tap', description: 'Catalog' },
        ],
      },
    });
    expect(r.valid).toBe(true);
  });

  it('preserves appPackage when provided', () => {
    const r = scenarioSetupAdapter.validate({
      config: {
        platform: 'mobile_android',
        appPackage: 'com.example.app',
        steps: [{ type: 'tap', description: 'X' }],
      },
    });
    expect(r.valid).toBe(true);
    expect(r.normalized?.config.appPackage).toBe('com.example.app');
  });

  it('drops empty appPackage rather than persisting empty string', () => {
    const r = scenarioSetupAdapter.validate({
      config: {
        platform: 'mobile_android',
        appPackage: '',
        steps: [{ type: 'tap', description: 'X' }],
      },
    });
    expect(r.valid).toBe(true);
    expect(r.normalized?.config.appPackage).toBeUndefined();
  });

  it('rejects missing platform', () => {
    const r = scenarioSetupAdapter.validate({
      config: { steps: [{ type: 'tap', description: 'X' }] },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /platform is required/.test(e))).toBe(true);
  });

  it('rejects unknown platform', () => {
    const r = scenarioSetupAdapter.validate({
      config: { platform: 'desktop_macos', steps: [{ type: 'tap', description: 'X' }] },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /not supported/.test(e))).toBe(true);
  });

  it('rejects appPackage of wrong type', () => {
    const r = scenarioSetupAdapter.validate({
      config: {
        platform: 'mobile_android',
        appPackage: 123,
        steps: [{ type: 'tap', description: 'X' }],
      },
    });
    expect(r.valid).toBe(false);
  });

  it('rejects missing steps array', () => {
    const r = scenarioSetupAdapter.validate({
      config: { platform: 'mobile_android' },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /steps must be an array/.test(e))).toBe(true);
  });

  it('rejects empty steps array', () => {
    const r = scenarioSetupAdapter.validate({
      config: { platform: 'mobile_android', steps: [] },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /at least one step/.test(e))).toBe(true);
  });

  it('rejects more than 200 steps', () => {
    const steps = Array.from({ length: 201 }, (_, i) => ({
      type: 'tap',
      description: `step ${i}`,
    }));
    const r = scenarioSetupAdapter.validate({
      config: { platform: 'mobile_android', steps },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /too many steps/.test(e))).toBe(true);
  });

  it('rejects step missing type', () => {
    const r = scenarioSetupAdapter.validate({
      config: {
        platform: 'mobile_android',
        steps: [{ description: 'no type' } as unknown as Record<string, unknown>],
      },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /missing required string "type"/.test(e))).toBe(true);
  });

  it('rejects use_setup step without refSetupId', () => {
    const r = scenarioSetupAdapter.validate({
      config: {
        platform: 'mobile_android',
        steps: [{ type: 'use_setup' }],
      },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /must have a non-empty refSetupId/.test(e))).toBe(true);
  });

  it('rejects values longer than 8KB', () => {
    const big = 'x'.repeat(8193);
    const r = scenarioSetupAdapter.validate({
      config: {
        platform: 'mobile_android',
        steps: [{ type: 'type', description: 'X', value: big }],
      },
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /value exceeds 8192/.test(e))).toBe(true);
  });

  it('accepts value at exactly 8KB', () => {
    const big = 'x'.repeat(8192);
    const r = scenarioSetupAdapter.validate({
      config: {
        platform: 'mobile_android',
        steps: [{ type: 'type', description: 'X', value: big }],
      },
    });
    expect(r.valid).toBe(true);
  });

  it('exposes no sensitive fields', () => {
    expect(scenarioSetupAdapter.sensitiveFields()).toEqual([]);
  });

  it('isFresh always returns true', () => {
    expect(
      scenarioSetupAdapter.isFresh!(
        buildResource({ platform: 'mobile_android', steps: [{ type: 'tap' }] }) as never,
      ),
    ).toBe(true);
  });
});

describe('scenarioSetupAdapter.apply', () => {
  it('is a passive no-op (writes nothing to runVariables)', async () => {
    const ctx = buildCtx();
    await scenarioSetupAdapter.apply(
      ctx,
      buildResource({
        platform: 'mobile_android',
        steps: [{ type: 'tap', description: 'X' }],
      }) as never,
    );
    expect(ctx.runVariables.size).toBe(0);
  });

  it('does not throw on missing config (graceful)', async () => {
    const ctx = buildCtx();
    await scenarioSetupAdapter.apply(ctx, {
      ...buildResource({ platform: 'mobile_android', steps: [{ type: 'tap' }] }),
      config: {} as never,
    } as never);
    expect(ctx.runVariables.size).toBe(0);
  });
});
