/**
 * Compiler-level tests for scenario_setup: nested expansion, cycle detection,
 * depth cap, kind validation, and final step shape. Mocks `loadDecrypted`
 * so we can construct arbitrary setup graphs without DB.
 */
import { ResourceStepCompilerService } from '../resource-step-compiler.service';
import type { DecryptedResource } from '../types';
import type { ResourceBinding } from '../test-resource.service';

jest.mock('../test-resource.service', () => {
  const actual = jest.requireActual('../test-resource.service');
  return {
    ...actual,
    loadDecrypted: jest.fn(),
    isFresh: jest.fn().mockReturnValue(true),
  };
});

const tr = require('../test-resource.service');

function makeSetup(
  id: string,
  steps: Array<Record<string, unknown>>,
): DecryptedResource {
  return {
    id,
    kind: 'scenario_setup',
    name: `setup-${id}`,
    scope: {},
    config: { platform: 'android', steps },
    sensitive: {},
    status: 'active',
    refreshMethod: 'none',
    recipe: [],
  };
}

beforeEach(() => {
  (tr.loadDecrypted as jest.Mock).mockReset();
  (tr.isFresh as jest.Mock).mockReturnValue(true);
});

describe('compileForMobile — scenario_setup', () => {
  it('compiles a flat setup with no nesting', async () => {
    const setupA = makeSetup('uuid-A', [
      { type: 'tap', description: 'Email' },
      { type: 'type', description: 'Email', value: 'demo@x.com' },
      { type: 'tap', description: 'Login' },
    ]);
    (tr.loadDecrypted as jest.Mock).mockResolvedValueOnce(setupA);

    const binding: ResourceBinding = {
      kind: 'scenario_setup',
      resource_id: 'uuid-A',
      required: true,
    };

    const result = await ResourceStepCompilerService.compileForMobile({
      bindings: [binding],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });

    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.phase === 'setup')).toBe(true);
    expect(result.steps.every((s) => s.isAutoInjected === true)).toBe(true);
    expect(result.steps[0].type).toBe('tap');
    expect(result.steps[1].value).toBe('demo@x.com');
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('inlines a nested use_setup reference', async () => {
    const setupA = makeSetup('uuid-A', [
      { type: 'tap', description: 'Email' },
      { type: 'tap', description: 'Login' },
    ]);
    const setupB = makeSetup('uuid-B', [
      { type: 'use_setup', refSetupId: 'uuid-A' },
      { type: 'tap', description: 'Catalog' },
      { type: 'tap', description: 'Cart' },
    ]);
    (tr.loadDecrypted as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'uuid-A') return setupA;
      if (id === 'uuid-B') return setupB;
      return null;
    });

    const result = await ResourceStepCompilerService.compileForMobile({
      bindings: [
        { kind: 'scenario_setup', resource_id: 'uuid-B', required: true },
      ],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });

    // 2 (from A inlined) + 2 (own B steps after use_setup) = 4
    expect(result.steps).toHaveLength(4);
    expect(result.steps.map((s) => s.description)).toEqual([
      'Email',
      'Login',
      'Catalog',
      'Cart',
    ]);
  });

  it('handles two levels of nesting (A → B → C)', async () => {
    const setupA = makeSetup('uuid-A', [{ type: 'tap', description: 'A1' }]);
    const setupB = makeSetup('uuid-B', [
      { type: 'use_setup', refSetupId: 'uuid-A' },
      { type: 'tap', description: 'B1' },
    ]);
    const setupC = makeSetup('uuid-C', [
      { type: 'use_setup', refSetupId: 'uuid-B' },
      { type: 'tap', description: 'C1' },
    ]);
    (tr.loadDecrypted as jest.Mock).mockImplementation(async (id: string) => {
      const m: Record<string, DecryptedResource> = {
        'uuid-A': setupA,
        'uuid-B': setupB,
        'uuid-C': setupC,
      };
      return m[id] ?? null;
    });

    const result = await ResourceStepCompilerService.compileForMobile({
      bindings: [
        { kind: 'scenario_setup', resource_id: 'uuid-C', required: true },
      ],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });

    expect(result.steps.map((s) => s.description)).toEqual(['A1', 'B1', 'C1']);
  });

  it('throws on direct cycle (A → A)', async () => {
    const setupA = makeSetup('uuid-A', [
      { type: 'use_setup', refSetupId: 'uuid-A' },
    ]);
    (tr.loadDecrypted as jest.Mock).mockResolvedValue(setupA);

    await expect(
      ResourceStepCompilerService.compileForMobile({
        bindings: [
          { kind: 'scenario_setup', resource_id: 'uuid-A', required: true },
        ],
        userId: 'u1',
        projectId: 'p1',
        platform: 'android',
      }),
    ).rejects.toThrow(/cycle detected/i);
  });

  it('throws on indirect cycle (A → B → A)', async () => {
    const setupA = makeSetup('uuid-A', [
      { type: 'use_setup', refSetupId: 'uuid-B' },
    ]);
    const setupB = makeSetup('uuid-B', [
      { type: 'use_setup', refSetupId: 'uuid-A' },
    ]);
    (tr.loadDecrypted as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'uuid-A') return setupA;
      if (id === 'uuid-B') return setupB;
      return null;
    });

    await expect(
      ResourceStepCompilerService.compileForMobile({
        bindings: [
          { kind: 'scenario_setup', resource_id: 'uuid-A', required: true },
        ],
        userId: 'u1',
        projectId: 'p1',
        platform: 'android',
      }),
    ).rejects.toThrow(/cycle detected/i);
  });

  it('throws when nesting depth exceeds 5', async () => {
    // chain L1 → L2 → L3 → L4 → L5 → L6, all referencing the next
    const make = (id: string, ref?: string): DecryptedResource =>
      makeSetup(
        id,
        ref
          ? [{ type: 'use_setup', refSetupId: ref }]
          : [{ type: 'tap', description: id }],
      );
    const chain: Record<string, DecryptedResource> = {
      L1: make('L1', 'L2'),
      L2: make('L2', 'L3'),
      L3: make('L3', 'L4'),
      L4: make('L4', 'L5'),
      L5: make('L5', 'L6'),
      L6: make('L6', 'L7'),
      L7: make('L7'),
    };
    (tr.loadDecrypted as jest.Mock).mockImplementation(async (id: string) => chain[id] ?? null);

    await expect(
      ResourceStepCompilerService.compileForMobile({
        bindings: [
          { kind: 'scenario_setup', resource_id: 'L1', required: true },
        ],
        userId: 'u1',
        projectId: 'p1',
        platform: 'android',
      }),
    ).rejects.toThrow(/nesting depth/i);
  });

  it('throws when referenced setup does not exist', async () => {
    const setupA = makeSetup('uuid-A', [
      { type: 'use_setup', refSetupId: 'uuid-missing' },
    ]);
    (tr.loadDecrypted as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'uuid-A') return setupA;
      return null;
    });

    await expect(
      ResourceStepCompilerService.compileForMobile({
        bindings: [
          { kind: 'scenario_setup', resource_id: 'uuid-A', required: true },
        ],
        userId: 'u1',
        projectId: 'p1',
        platform: 'android',
      }),
    ).rejects.toThrow(/references unknown setup/i);
  });

  it('throws when use_setup references a non-scenario_setup resource', async () => {
    const setupA = makeSetup('uuid-A', [
      { type: 'use_setup', refSetupId: 'uuid-env' },
    ]);
    const envResource: DecryptedResource = {
      id: 'uuid-env',
      kind: 'environment',
      name: 'Staging',
      scope: {},
      config: { variables: { BASE_URL: 'https://stg' } },
      sensitive: {},
      status: 'active',
      refreshMethod: 'none',
      recipe: [],
    };
    (tr.loadDecrypted as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'uuid-A') return setupA;
      if (id === 'uuid-env') return envResource;
      return null;
    });

    await expect(
      ResourceStepCompilerService.compileForMobile({
        bindings: [
          { kind: 'scenario_setup', resource_id: 'uuid-A', required: true },
        ],
        userId: 'u1',
        projectId: 'p1',
        platform: 'android',
      }),
    ).rejects.toThrow(/of kind "environment"/);
  });

  it('soft-skips a non-required setup with a broken graph', async () => {
    const setupA = makeSetup('uuid-A', [
      { type: 'use_setup', refSetupId: 'uuid-missing' },
    ]);
    (tr.loadDecrypted as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'uuid-A') return setupA;
      return null;
    });

    const result = await ResourceStepCompilerService.compileForMobile({
      bindings: [
        { kind: 'scenario_setup', resource_id: 'uuid-A', required: false },
      ],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });

    expect(result.steps).toHaveLength(0);
    expect(result.applied[0]?.apply_error).toMatch(/references unknown setup/);
  });

  it('skips scenario_setup when scope.platform mismatches', async () => {
    const setupA: DecryptedResource = {
      ...makeSetup('uuid-A', [{ type: 'tap', description: 'X' }]),
      scope: { platform: 'web' },
    };
    (tr.loadDecrypted as jest.Mock).mockResolvedValue(setupA);

    const result = await ResourceStepCompilerService.compileForMobile({
      bindings: [
        { kind: 'scenario_setup', resource_id: 'uuid-A', required: false },
      ],
      userId: 'u1',
      projectId: 'p1',
      platform: 'android',
    });

    expect(result.steps).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/scope.platform=web/);
  });
});
