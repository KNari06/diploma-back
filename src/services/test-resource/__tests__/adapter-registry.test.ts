/**
 * Tests for the resource adapter registry — the "which adapter handles which
 * kind" lookup. requireResourceAdapter must FAIL FAST on an unknown kind (a DB
 * row shipped without its adapter), not silently no-op the resource.
 *
 * Module-level Map state, so each test re-requires a fresh module.
 */

type Registry = typeof import('../adapter-registry');
let reg: Registry;

beforeEach(() => {
  jest.resetModules();
  jest.doMock('@/utils/core/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  reg = require('../adapter-registry');
});

const adapter = (kind: string) => ({ kind }) as never;

describe('adapter registry', () => {
  it('registers and retrieves an adapter by kind', () => {
    reg.registerResourceAdapter(adapter('secret'));
    expect(reg.getResourceAdapter('secret' as never)?.kind).toBe('secret');
  });

  it('getResourceAdapter returns undefined for an unregistered kind', () => {
    expect(reg.getResourceAdapter('nope' as never)).toBeUndefined();
  });

  it('requireResourceAdapter throws for an unregistered kind (fail fast)', () => {
    expect(() => reg.requireResourceAdapter('ghost' as never)).toThrow(
      /No adapter registered for resource kind 'ghost'/,
    );
  });

  it('requireResourceAdapter returns the adapter when present', () => {
    reg.registerResourceAdapter(adapter('environment'));
    expect(reg.requireResourceAdapter('environment' as never).kind).toBe('environment');
  });

  it('listRegisteredKinds reflects what was registered', () => {
    expect(reg.listRegisteredKinds()).toEqual([]);
    reg.registerResourceAdapter(adapter('secret'));
    reg.registerResourceAdapter(adapter('auth'));
    expect(reg.listRegisteredKinds().sort()).toEqual(['auth', 'secret']);
  });

  it('overwriting an existing kind warns but takes effect', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { logger } = require('@/utils/core/logger');
    const first = { kind: 'secret', tag: 'A' } as never;
    const second = { kind: 'secret', tag: 'B' } as never;
    reg.registerResourceAdapter(first);
    reg.registerResourceAdapter(second);
    expect(logger.warn).toHaveBeenCalledWith('[RESOURCE_REGISTRY] Overwriting existing adapter', { kind: 'secret' });
    expect((reg.getResourceAdapter('secret' as never) as unknown as { tag: string }).tag).toBe('B');
    expect(reg.listRegisteredKinds()).toEqual(['secret']); // not duplicated
  });
});
