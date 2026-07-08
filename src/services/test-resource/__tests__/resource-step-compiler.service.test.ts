/**
 * Unit tests for ResourceStepCompilerService (Track 5 — Option A).
 *
 * Covers the mobile-side compile path end-to-end with `loadDecrypted`
 * mocked. Real decrypt + DB are exercised separately in the test-resource
 * integration suite.
 *
 * Structure:
 *   - compileForMobile: control flow (empty, ordering, required, skip)
 *   - per-kind compilation happy paths + edge cases
 *   - platform compatibility matrix
 *   - staleness policy (bug #8)
 *   - scenario_setup warn (bug #9)
 *   - secret handling (no plaintext in wire-like structures)
 */

import {
  ResourceStepCompilerService,
  type CompiledResourceStep,
} from '../resource-step-compiler.service';
import type {
  DecryptedResource,
  ResourceKind,
  ResourceStatus,
} from '../types';
import type { ResourceBinding } from '../test-resource.service';

// ─────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────

jest.mock('../test-resource.service', () => {
  const actual = jest.requireActual<typeof import('../test-resource.service')>(
    '../test-resource.service',
  );
  return {
    ...actual,
    loadDecrypted: jest.fn(),
    // `isFresh` has a pure fallback path — the real implementation is safe
    // to call without adapters registered for static kinds (no TTL). We
    // only override it in tests that need to force staleness.
    isFresh: jest.fn(actual.isFresh),
  };
});

// Re-import the mocked module so we can tweak return values per-test.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockedModule = require('../test-resource.service') as {
  loadDecrypted: jest.Mock;
  isFresh: jest.Mock;
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function makeResource(
  over: Partial<DecryptedResource> & { kind: ResourceKind },
): DecryptedResource {
  return {
    id: over.id ?? `res-${over.kind}-${Math.random().toString(36).slice(2, 8)}`,
    kind: over.kind,
    name: over.name ?? `Test ${over.kind}`,
    scope: over.scope ?? {},
    config: over.config ?? {},
    sensitive: over.sensitive ?? {},
    status: (over.status ?? 'active') as ResourceStatus,
    expiresAt: over.expiresAt,
    ttlSeconds: over.ttlSeconds,
    refreshMethod: over.refreshMethod ?? 'none',
    refreshConfig: over.refreshConfig,
    recipe: over.recipe ?? [],
  };
}

function binding(
  kind: ResourceKind,
  resource_id: string,
  required = false,
): ResourceBinding {
  return { kind, resource_id, required };
}

function typesOf(steps: CompiledResourceStep[]): string[] {
  return steps.map((s) => s.type);
}

function storeKeys(steps: CompiledResourceStep[]): string[] {
  return steps.filter((s) => s.type === 'store').map((s) => s.description);
}

function storeValue(
  steps: CompiledResourceStep[],
  key: string,
): string | undefined {
  return steps.find((s) => s.type === 'store' && s.description === key)?.value;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: isFresh returns true unless a test overrides it.
  mockedModule.isFresh.mockImplementation(() => true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Control flow
// ═══════════════════════════════════════════════════════════════════════════

describe('compileForMobile — control flow', () => {
  it('returns empty result for empty bindings array', async () => {
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(0);
    expect(r.applied).toHaveLength(0);
    expect(r.skipped).toHaveLength(0);
    expect(mockedModule.loadDecrypted).not.toHaveBeenCalled();
  });

  it('soft-skips missing non-required binding', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(null);
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('auth', 'missing', false)],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(0);
    expect(r.applied).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain('not found');
  });

  it('throws on missing required binding', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(null);
    await expect(
      ResourceStepCompilerService.compileForMobile({
        bindings: [binding('auth', 'missing', true)],
        userId: 'u1',
        projectId: 'p1',
        platform: 'android',
      }),
    ).rejects.toThrow(/Required auth binding missing not found/);
  });

  it('throws on required binding with status=broken', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'auth', status: 'broken', name: 'Admin' }),
    );
    await expect(
      ResourceStepCompilerService.compileForMobile({
        bindings: [binding('auth', 'x', true)],
        userId: 'u1',
        projectId: 'p1',
        platform: 'android',
      }),
    ).rejects.toThrow(/broken/);
  });

  it('applies topological order: secret/env → network → auth', async () => {
    mockedModule.loadDecrypted.mockImplementation(async (id: string) => {
      if (id === 'sec') return makeResource({ kind: 'secret', id: 'sec', sensitive: { API_KEY: 'xxx' } });
      if (id === 'net') return makeResource({ kind: 'network', id: 'net', config: { preset: '3g' } });
      if (id === 'auth') return makeResource({ kind: 'auth', id: 'auth', recipe: [] });
      return null;
    });

    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [
        // Deliberately out of order in input:
        binding('auth', 'auth'),
        binding('network', 'net'),
        binding('secret', 'sec'),
      ],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });

    const appliedKinds = r.applied.map((a) => a.kind);
    // Secret must land before network; network before auth.
    expect(appliedKinds.indexOf('secret')).toBeLessThan(
      appliedKinds.indexOf('network'),
    );
    expect(appliedKinds.indexOf('network')).toBeLessThan(
      appliedKinds.indexOf('auth'),
    );
  });

  it('treats loadDecrypted throw as missing (soft skip)', async () => {
    mockedModule.loadDecrypted.mockRejectedValueOnce(new Error('db down'));
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('environment', 'e1', false)],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain('not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Per-kind: auth
// ═══════════════════════════════════════════════════════════════════════════

describe('compileAuth (bug #1 regression)', () => {
  it('seeds config + sensitive into scratchpad BEFORE recipe', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'auth',
        name: 'Admin',
        config: { username: 'admin@example.com' },
        sensitive: { password: 's3cr3t', totpSecret: 'JBSWY3DPEHPK3PXP' },
        recipe: [
          {
            id: 'r1',
            type: 'tap',
            description: 'tap email field',
          },
          {
            id: 'r2',
            type: 'type',
            description: 'type email',
            value: '${username}',
          },
          {
            id: 'r3',
            type: 'type',
            description: 'type password',
            value: '${password}',
          },
        ],
      }),
    );

    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('auth', 'auth1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });

    // Store steps come first, in order: config → sensitive(bare) → sensitive(prefixed).
    const firstStore = r.steps.findIndex((s) => s.type === 'store');
    const firstRecipe = r.steps.findIndex((s) => s.type === 'tap');
    expect(firstStore).toBeGreaterThanOrEqual(0);
    expect(firstRecipe).toBeGreaterThan(firstStore);

    // Bare-form keys available (backward compat with existing recipes).
    expect(storeValue(r.steps, 'username')).toBe('admin@example.com');
    expect(storeValue(r.steps, 'password')).toBe('s3cr3t');
    expect(storeValue(r.steps, 'totpSecret')).toBe('JBSWY3DPEHPK3PXP');

    // Prefixed-form keys also emitted for sensitive fields (signal for
    // log redaction).
    expect(storeValue(r.steps, '_secret_password')).toBe('s3cr3t');
    expect(storeValue(r.steps, '_secret_totpSecret')).toBe('JBSWY3DPEHPK3PXP');

    // Bare username should NOT get a secret alias (non-sensitive).
    expect(storeValue(r.steps, '_secret_username')).toBeUndefined();

    // Recipe steps preserved in order and tagged as setup.
    const recipeSteps = r.steps.slice(firstRecipe);
    expect(recipeSteps.every((s) => s.phase === 'setup')).toBe(true);
    expect(recipeSteps.every((s) => s.isAutoInjected === true)).toBe(true);
    expect(typesOf(recipeSteps)).toEqual(['tap', 'type', 'type']);
  });

  it('emits store steps even when recipe is empty (logs warn)', async () => {
    const warnSpy = jest
      .spyOn(require('@/utils/core/logger').logger, 'warn')
      .mockImplementation(() => undefined);
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'auth',
        name: 'BadAuth',
        config: { username: 'x@y.z' },
        sensitive: { password: 'p' },
        recipe: [],
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('auth', 'auth1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps.every((s) => s.type === 'store')).toBe(true);
    expect(r.steps.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auth resource has empty recipe'),
      expect.any(Object),
    );
    warnSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Per-kind: environment / secret / variables
// ═══════════════════════════════════════════════════════════════════════════

describe('compileKeyValue (environment / secret / variables)', () => {
  it('environment: emits one store per non-empty config key', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'environment',
        config: { BASE_URL: 'https://stg.app', EMPTY: '', FEATURE: true, NEST: { a: 1 } },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('environment', 'e1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(storeKeys(r.steps).sort()).toEqual(
      ['BASE_URL', 'FEATURE', 'NEST'].sort(),
    );
    // Booleans stringified.
    expect(storeValue(r.steps, 'FEATURE')).toBe('true');
    // Objects JSON-encoded.
    expect(storeValue(r.steps, 'NEST')).toBe('{"a":1}');
    // Empty strings skipped.
    expect(storeKeys(r.steps)).not.toContain('EMPTY');
  });

  it('secret: keys are prefixed with _secret_', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'secret',
        sensitive: { API_KEY: 'sk-xxx', AUTH_TOKEN: 'bearer-yyy' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('secret', 's1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(storeKeys(r.steps).sort()).toEqual(
      ['_secret_API_KEY', '_secret_AUTH_TOKEN'].sort(),
    );
  });

  it('variables: bare keys, no prefix', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'variables', config: { userId: 42 } }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('variables', 'v1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(storeKeys(r.steps)).toEqual(['userId']);
    expect(storeValue(r.steps, 'userId')).toBe('42');
  });

  it('skips resources with null/undefined/empty values entirely', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'environment',
        config: { A: null, B: undefined, C: '', D: {} },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('environment', 'e1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    // All keys filtered out — no store steps.
    expect(r.steps.filter((s) => s.type === 'store')).toHaveLength(0);
    // But the binding was still considered → recorded in applied.
    expect(r.applied).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Per-kind: network
// ═══════════════════════════════════════════════════════════════════════════

describe('compileNetwork', () => {
  it('emits network step with preset', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'network',
        name: 'Slow3G',
        config: { preset: '3g' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('network', 'n1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].type).toBe('network');
    expect(r.steps[0].options).toMatchObject({ networkPreset: '3g' });
  });

  it('emits network step with custom latency/bandwidth/loss', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'network',
        config: { latencyMs: 500, bandwidthKbps: 128, packetLossPercent: 5 },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('network', 'n1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps[0].options).toEqual(
      expect.objectContaining({
        networkLatencyMs: 500,
        networkBandwidthKbps: 128,
        networkPacketLossPercent: 5,
      }),
    );
  });

  it('rejects invalid preset (no step emitted)', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'network', config: { preset: 'quantum' } }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('network', 'n1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Per-kind: file / device / oauth_token
// ═══════════════════════════════════════════════════════════════════════════

describe('compileFile / compileDevice / compileOAuthToken', () => {
  it('file: emits upload step with uploadFilePath', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'file',
        config: { runnerPath: '/tmp/fixture.png' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('file', 'f1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps[0].type).toBe('upload');
    expect(r.steps[0].options).toMatchObject({
      uploadFilePath: '/tmp/fixture.png',
    });
  });

  it('file: no steps when runnerPath missing', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'file', config: {} }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('file', 'f1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(0);
  });

  it('device: emits geolocation step when lat/lng set', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'device',
        config: { latitude: 51.5, longitude: -0.1 },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('device', 'd1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps[0].type).toBe('geolocation');
    expect(r.steps[0].options).toEqual(
      expect.objectContaining({
        geolocationAction: 'set',
        geolocationLatitude: 51.5,
        geolocationLongitude: -0.1,
      }),
    );
  });

  it('device: skipped when neither lat nor lng present', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'device', config: { userAgent: 'Mozilla' } }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('device', 'd1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(0);
  });

  it('oauth_token: emits single _secret_-prefixed store', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'oauth_token',
        name: 'GitHub App',
        config: { tokenAlias: 'gh_token' },
        sensitive: { access_token: 'ghp_xxxxxxxx' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('oauth_token', 'o1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].type).toBe('store');
    expect(r.steps[0].description).toBe('_secret_gh_token');
    expect(r.steps[0].value).toBe('ghp_xxxxxxxx');
  });

  it('oauth_token: derives alias from name when no tokenAlias', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'oauth_token',
        name: 'My Staging Token!',
        sensitive: { access_token: 'abc' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('oauth_token', 'o1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps[0].description).toMatch(/^_secret_oauth_my_staging_token/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// scenario_setup / data_fixture
// ═══════════════════════════════════════════════════════════════════════════

describe('scenario_setup', () => {
  // Empty scenario_setup (no config.steps) should soft-warn and emit zero
  // steps. This used to be the "not orchestrated" stub; after slice 1 of
  // setup-blocks we DO orchestrate scenario_setup on mobile, but a setup
  // with literally no steps remains a soft no-op (with a diagnostic warn).
  it('warns and emits zero steps when config.steps is empty', async () => {
    const warnSpy = jest
      .spyOn(require('@/utils/core/logger').logger, 'warn')
      .mockImplementation(() => undefined);
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'scenario_setup', name: 'LoginBundle' }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('scenario_setup', 's1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(0);
    expect(r.applied).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('scenario_setup has no steps after expansion'),
      expect.any(Object),
    );
    warnSpy.mockRestore();
  });

  it('emits steps verbatim when config.steps is populated', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'scenario_setup',
        name: 'LoginBundle',
        config: {
          platform: 'android',
          steps: [
            { type: 'tap', description: 'Email field' },
            { type: 'type', description: 'Email field', value: 'demo@x.com' },
          ],
        },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('scenario_setup', 's1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].type).toBe('tap');
    expect(r.steps[1].value).toBe('demo@x.com');
    expect(r.steps.every((s) => s.phase === 'setup')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Platform compatibility
// ═══════════════════════════════════════════════════════════════════════════

describe('platform compatibility', () => {
  it('skips scope.platform=web on android run', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'environment',
        scope: { platform: 'web' as any, domain: 'example.com' },
        config: { BASE_URL: 'https://example.com' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('environment', 'e1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.steps).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain('scope.platform=web');
  });

  it('allows android scope on flutter run', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'environment',
        scope: { platform: 'android' },
        config: { K: 'v' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('environment', 'e1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'flutter',
    });
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('soft-skips required=true on platform mismatch (does NOT throw)', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'auth',
        scope: { platform: 'web' as any },
        recipe: [],
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('auth', 'a1', true)],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.skipped).toHaveLength(1);
    expect(r.steps).toHaveLength(0);
  });

  it('accepts legacy resource with no scope.platform', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'environment',
        scope: {}, // no platform key
        config: { K: 'v' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('environment', 'e1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.applied).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Staleness (bug #8)
// ═══════════════════════════════════════════════════════════════════════════

describe('staleness policy', () => {
  it('applies stale non-required resource with stale_at_start in snapshot', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'auth',
        name: 'OldLogin',
        refreshMethod: 'manual',
        config: { username: 'u' },
        recipe: [{ id: 'r1', type: 'tap', description: 'tap login' }],
      }),
    );
    mockedModule.isFresh.mockReturnValueOnce(false);

    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('auth', 'a1', false)],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });

    expect(r.applied).toHaveLength(1);
    expect(r.applied[0].status_at_start).toBe('stale');
    // Steps still emitted — the compile didn't abort.
    expect(r.steps.length).toBeGreaterThan(0);
  });

  it('throws on stale required resource', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'auth',
        refreshMethod: 'manual',
        recipe: [],
      }),
    );
    mockedModule.isFresh.mockReturnValueOnce(false);

    await expect(
      ResourceStepCompilerService.compileForMobile({
        bindings: [binding('auth', 'a1', true)],
        userId: 'u1',
        projectId: 'p1',
        platform: 'android',
      }),
    ).rejects.toThrow(/stale/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Step shape sanity
// ═══════════════════════════════════════════════════════════════════════════

describe('step output shape', () => {
  it('every emitted step has id, phase=setup, isAutoInjected=true', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'environment',
        config: { A: '1', B: '2' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('environment', 'e1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    for (const s of r.steps) {
      expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.phase).toBe('setup');
      expect(s.isAutoInjected).toBe(true);
    }
  });

  it('snapshot never surfaces decrypted secret values', async () => {
    const SECRET = 'super-secret-password-12345';
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'secret',
        name: 'ApiKeys',
        sensitive: { API_KEY: SECRET },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('secret', 's1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    // The secret is in `steps[*].value` (that's the whole point — it goes
    // to the scratchpad at runtime). But it must NEVER appear inside the
    // snapshot (`applied` / `skipped`) which is persisted as audit data.
    const snapshotJson = JSON.stringify({ applied: r.applied, skipped: r.skipped });
    expect(snapshotJson).not.toContain(SECRET);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// secretValues — the mobile job's redact-value list (bug #2 fix)
// ═══════════════════════════════════════════════════════════════════════════

describe('secretValues', () => {
  it('is empty when there are no bindings', async () => {
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.secretValues).toEqual([]);
  });

  it('is empty when nothing compiled is sensitive', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'environment', config: { BASE_URL: 'https://stg.app' } }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('environment', 'e1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.secretValues).toEqual([]);
  });

  it('collects a secret-kind resource value', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'secret', sensitive: { API_KEY: 'sk-super-secret-value' } }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('secret', 's1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.secretValues).toEqual(['sk-super-secret-value']);
  });

  it('collects auth sensitive fields but not bare non-sensitive config', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'auth',
        config: { username: 'admin@example.com' },
        sensitive: { password: 's3cr3t-password' },
        recipe: [{ id: 'r1', type: 'tap', description: 'tap' }],
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('auth', 'auth1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.secretValues).toEqual(['s3cr3t-password']);
    expect(r.secretValues).not.toContain('admin@example.com');
  });

  it('collects an oauth_token value', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'oauth_token', sensitive: { access_token: 'ghp_xxxxxxxxsecret' } }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('oauth_token', 'o1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.secretValues).toEqual(['ghp_xxxxxxxxsecret']);
  });

  it('does not collect data_fixture values (plaintext by design, not secret-prefixed)', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({ kind: 'data_fixture', config: { data: { EMAIL: 'fixture@example.com' } } }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('data_fixture', 'df1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.secretValues).toEqual([]);
  });

  it('sorts collected values longest-first (substring-safe masking order)', async () => {
    mockedModule.loadDecrypted.mockResolvedValueOnce(
      makeResource({
        kind: 'secret',
        sensitive: { SHORT: 'abcd', LONG: 'abcdEFGH' },
      }),
    );
    const r = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding('secret', 's1')],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });
    expect(r.secretValues).toEqual(['abcdEFGH', 'abcd']);
  });
});
