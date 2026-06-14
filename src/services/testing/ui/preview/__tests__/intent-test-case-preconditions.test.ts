/**
 * Tests for IntentTestCaseService.collectPreconditionSteps().
 *
 * Verifies the transitive precondition expansion used to inline a test's
 * dependency steps before its own steps at run time:
 *   - dependency-first ordering (deepest dependency runs first)
 *   - diamond dedup (a shared ancestor's steps appear exactly once)
 *   - cycle safety (no infinite recursion)
 *   - provenance tagging + namespaced ids (collision-proof writeback)
 */

// Dependency graph the mocked supabase `.in('id', ids)` reads from. Each test
// sets it in its own arrange step. Prefixed `mock` so the jest.mock factory may
// reference it.
let mockGraph: Record<string, { depends_on: string[]; steps_json: unknown[] }> = {};

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        in: jest.fn(async (_col: string, ids: string[]) => ({
          data: ids
            .filter((id) => mockGraph[id])
            .map((id) => ({
              id,
              depends_on: mockGraph[id].depends_on,
              steps_json: mockGraph[id].steps_json,
            })),
          error: null,
        })),
      })),
    })),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn(async () => undefined) },
}));

import { IntentTestCaseService } from '../intent-test-case.service';

// One step per case, all sharing the same intra-case id `s` — proves the
// namespaced output id keeps them distinct across cases.
const step = (description: string) => [{ id: 's', type: 'click', description }];

beforeEach(() => {
  mockGraph = {};
});

describe('IntentTestCaseService.collectPreconditionSteps', () => {
  it('returns an empty array when the case has no dependencies', async () => {
    mockGraph = { A: { depends_on: [], steps_json: step('a') } };

    const result = await IntentTestCaseService.collectPreconditionSteps('A');

    expect(result).toEqual([]);
  });

  it('orders dependencies deepest-first (A→B→C yields C then B)', async () => {
    mockGraph = {
      A: { depends_on: ['B'], steps_json: step('a') },
      B: { depends_on: ['C'], steps_json: step('b') },
      C: { depends_on: [], steps_json: step('c') },
    };

    const result = await IntentTestCaseService.collectPreconditionSteps('A');

    // Root A's own steps are NOT included; deepest dependency C runs first.
    expect(result.map((s) => s._preconditionSource)).toEqual(['C', 'B']);
    expect(result.map((s) => s.description)).toEqual(['c', 'b']);
  });

  it('dedupes a shared ancestor in a diamond (Login appears once)', async () => {
    mockGraph = {
      B: { depends_on: ['A', 'C'], steps_json: step('b') },
      A: { depends_on: ['Login'], steps_json: step('a') },
      C: { depends_on: ['Login'], steps_json: step('c') },
      Login: { depends_on: [], steps_json: step('login') },
    };

    const result = await IntentTestCaseService.collectPreconditionSteps('B');

    expect(result.map((s) => s._preconditionSource)).toEqual(['Login', 'A', 'C']);
    expect(result.filter((s) => s._preconditionSource === 'Login')).toHaveLength(1);
  });

  it('does not loop on a cycle (A→B→A)', async () => {
    mockGraph = {
      A: { depends_on: ['B'], steps_json: step('a') },
      B: { depends_on: ['A'], steps_json: step('b') },
    };

    const result = await IntentTestCaseService.collectPreconditionSteps('A');

    expect(result.map((s) => s._preconditionSource)).toEqual(['B']);
  });

  it('tags provenance and namespaces borrowed step ids', async () => {
    mockGraph = {
      A: { depends_on: ['Login'], steps_json: step('a') },
      Login: { depends_on: [], steps_json: step('login') },
    };

    const result = await IntentTestCaseService.collectPreconditionSteps('A');

    expect(result).toHaveLength(1);
    expect(result[0]._preconditionSource).toBe('Login');
    // Namespaced: `pre_<sourceId>_<originalId>` — never collides with target ids.
    expect(result[0].id).toBe('pre_Login_s');
  });
});
