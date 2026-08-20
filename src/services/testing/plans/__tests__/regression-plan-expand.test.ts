/**
 * Tests for `RegressionPlanService.expandPlan` / `getMemberTestCaseIds`.
 *
 * Background: expansion used to walk plan items sequentially and issue 3
 * queries per flow, so a 43-flow plan cost 133 serial round trips (~46s
 * against a remote Supabase) — the reason the regressions page's runs list
 * sat on skeletons. It is now batched into two waves of `.in(...)` queries.
 *
 * These tests pin BOTH halves of that contract: the query count must not
 * scale with the number of flows, and the expanded output (order, module
 * context, dedup, archived exclusion) must be what the per-flow walk
 * produced.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Fixture tables ───────────────────────────────────────────────────

const FLOWS = [
  { id: 'f1', module_id: 'm1' },
  { id: 'f2', module_id: 'm1' },
  { id: 'f3', module_id: null },
  { id: 'f4', module_id: 'm2' },
];

const UI_CASES = [
  { id: 'ui1', name: 'UI 1', platform: 'web', flow_id: 'f1', status: 'active' },
  { id: 'ui-archived', name: 'Archived', platform: 'web', flow_id: 'f1', status: 'archived' },
  { id: 'ui2', name: 'UI 2', platform: 'mobile_android', flow_id: 'f2', status: 'active' },
  { id: 'ui3', name: 'UI 3', platform: null, flow_id: 'f3', status: 'active' },
  { id: 'ui9', name: 'UI 9', platform: 'web', flow_id: 'f4', status: 'active' },
];

const API_CASES = [
  { id: 'api1', name: 'API 1', flow_id: 'f1' },
  { id: 'api9', name: 'API 9', flow_id: null },
];

const PLAN_ITEMS = [
  { id: 'i1', plan_id: 'plan-1', item_type: 'module', module_id: 'm1', order_index: 0 },
  // Same flow the module already covers — must dedup, not duplicate.
  { id: 'i2', plan_id: 'plan-1', item_type: 'flow', flow_id: 'f1', order_index: 1 },
  { id: 'i3', plan_id: 'plan-1', item_type: 'flow', flow_id: 'f3', order_index: 2 },
  { id: 'i4', plan_id: 'plan-1', item_type: 'test_case', test_case_id: 'ui9', test_case_type: 'ui', order_index: 3, parameters_override: { env: 'stage' } },
  { id: 'i5', plan_id: 'plan-1', item_type: 'test_case', test_case_id: 'api9', test_case_type: 'api', order_index: 4 },
];

/** Every `supabaseAdmin.from(...)` issued during a test. */
const fromCalls: string[] = [];

/**
 * Minimal chainable stub: records the filters applied, then resolves rows
 * from the fixture tables when awaited. Mirrors only the operators the
 * service actually uses (`eq`, `in`, `not('status','eq','archived')`).
 */
/** Tables the stub should answer with an error instead of rows. */
const failingTables = new Set<string>();

/** Every `.in(col, ids)` list the stub was handed, for chunk-size assertions. */
const inFilterSizes: number[] = [];

/** Every `.range(from, to)` the stub was handed, for paging assertions. */
const rangeCalls: Array<[number, number]> = [];

function makeBuilder(table: string) {
  const rows: any[] =
    table === 'test_flows' ? FLOWS :
    table === 'intent_test_cases' ? UI_CASES :
    table === 'api_test_configs' ? API_CASES :
    table === 'regression_plan_items' ? PLAN_ITEMS : [];

  const filters: Array<(r: any) => boolean> = [];
  const matched = () => rows.filter((r) => filters.every((f) => f(r)));

  const result = (from?: number, to?: number) => {
    if (failingTables.has(table)) {
      return { data: null, error: { message: `boom on ${table}` } };
    }
    const all = matched();
    return { data: from === undefined ? all : all.slice(from, (to as number) + 1), error: null };
  };

  const builder: any = {
    select: () => builder,
    order: () => builder,
    eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return builder; },
    in: (col: string, vals: any[]) => {
      inFilterSizes.push(vals.length);
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    not: (col: string, _op: string, val: any) => { filters.push((r) => r[col] !== val); return builder; },
    range: (from: number, to: number) => {
      rangeCalls.push([from, to]);
      return { then: (resolve: any) => resolve(result(from, to)) };
    },
    then: (resolve: any) => resolve(result()),
  };

  return builder;
}

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      fromCalls.push(table);
      return makeBuilder(table);
    }),
  },
}));

const mockExpandNegatives = jest.fn(async (): Promise<any[]> => []);
jest.mock('../negative-toggle-resolver.service', () => ({
  NegativeToggleResolverService: { expandNegatives: (...a: any[]) => mockExpandNegatives(...(a as [])) },
}));

const mockListNegativesBySources = jest.fn(async (): Promise<any[]> => []);
jest.mock('@/services/testing/negative/db/negative.db', () => ({
  listNegativesBySources: (...a: any[]) => mockListNegativesBySources(...(a as [])),
}));

// Heavy collaborators the SUT's module graph pulls in but this surface never calls.
jest.mock('@/services/integrations/git-integration.service', () => ({
  GitIntegrationService: { onPlanCreated: jest.fn(), onPlanUpdated: jest.fn() },
}));
jest.mock('@/services/testing/schedules/schedule.service', () => ({
  ScheduleService: { syncForPlan: jest.fn() },
}));
jest.mock('@/utils/core/redis-cache', () => ({
  cache: { get: jest.fn(async () => null), set: jest.fn(async () => undefined), del: jest.fn(async () => undefined) },
}));

import { RegressionPlanService } from '../regression-plan.service';

beforeEach(() => {
  fromCalls.length = 0;
  inFilterSizes.length = 0;
  rangeCalls.length = 0;
  failingTables.clear();
  mockExpandNegatives.mockClear();
  mockListNegativesBySources.mockClear();
});

describe('RegressionPlanService.expandPlan', () => {
  it('expands modules, flows and test cases in plan-item order', async () => {
    const cases = await RegressionPlanService.expandPlan('plan-1');

    expect(cases.map((c) => `${c.testType}:${c.testCaseId}`)).toEqual([
      // module m1 → f1 (ui before api), then f2
      'ui:ui1',
      'api:api1',
      'ui:ui2',
      // f1 item deduped against the module above; f3 next
      'ui:ui3',
      // direct test-case items last, in item order
      'ui:ui9',
      'api:api9',
    ]);
  });

  it('carries module context, platform and per-item parameter overrides', async () => {
    const cases = await RegressionPlanService.expandPlan('plan-1');
    const byId = Object.fromEntries(cases.map((c) => [c.testCaseId, c]));

    expect(byId.ui1).toMatchObject({ moduleId: 'm1', flowId: 'f1', name: 'UI 1', platform: 'web' });
    expect(byId.ui2).toMatchObject({ moduleId: 'm1', flowId: 'f2', platform: 'mobile_android' });
    // Flow with no module, and a null platform, stay undefined rather than null.
    expect(byId.ui3).toMatchObject({ flowId: 'f3' });
    expect(byId.ui3.moduleId).toBeUndefined();
    expect(byId.ui3.platform).toBeUndefined();
    // A test-case item resolves its module through the case's own flow.
    expect(byId.ui9).toMatchObject({ moduleId: 'm2', flowId: 'f4', parameters: { env: 'stage' } });
    expect(byId.api9.flowId).toBeUndefined();
  });

  it('excludes archived test cases', async () => {
    const cases = await RegressionPlanService.expandPlan('plan-1');
    expect(cases.map((c) => c.testCaseId)).not.toContain('ui-archived');
  });

  it('appends negatives from the toggle resolver', async () => {
    mockExpandNegatives.mockResolvedValueOnce([
      { testCaseId: 'neg1', testType: 'ui', flowId: 'f1', name: 'neg', isNegative: true } as any,
    ]);

    const cases = await RegressionPlanService.expandPlan('plan-1');
    expect(cases[cases.length - 1].testCaseId).toBe('neg1');
  });

  it('issues a constant number of queries regardless of flow count', async () => {
    await RegressionPlanService.expandPlan('plan-1');

    // items + flows-by-module + flows-by-id + ui-by-id + api-by-id
    // + ui-by-flow + api-by-flow + flows-by-id (test-case flows).
    // The old per-flow walk cost 3 queries per flow on top of this.
    expect(fromCalls.length).toBeLessThanOrEqual(8);
    expect(fromCalls.filter((t) => t === 'test_flows').length).toBeLessThanOrEqual(3);
  });
});

describe('RegressionPlanService.getMemberTestCaseIds', () => {
  it('returns every member id without resolving names or ordering', async () => {
    const ids = await RegressionPlanService.getMemberTestCaseIds('plan-1');

    expect([...ids].sort()).toEqual(['api1', 'api9', 'ui1', 'ui2', 'ui3', 'ui9']);
    expect(ids.has('ui-archived')).toBe(false);
    // The expensive toggle resolution is not on this path.
    expect(mockExpandNegatives).not.toHaveBeenCalled();
  });

  it('includes negatives by source, regardless of toggle or staleness', async () => {
    mockListNegativesBySources.mockResolvedValueOnce([{ id: 'neg-stale' }, { id: 'neg-off' }]);

    const ids = await RegressionPlanService.getMemberTestCaseIds('plan-1');

    expect(ids.has('neg-stale')).toBe(true);
    expect(ids.has('neg-off')).toBe(true);
    expect(mockListNegativesBySources).toHaveBeenCalledWith(expect.arrayContaining(['ui1', 'ui2', 'ui3']));
  });

  it('is cheaper than a full expansion', async () => {
    await RegressionPlanService.getMemberTestCaseIds('plan-1');

    // items + flows-by-module + ui-by-flow + api-by-flow
    expect(fromCalls.length).toBeLessThanOrEqual(4);
  });
});

describe('batched reads', () => {
  it('pages every `.in(...)` read so PostgREST\'s row cap cannot silently truncate a plan', async () => {
    await RegressionPlanService.expandPlan('plan-1');

    // Every batched read must go through .range(); an unpaged select would be
    // capped at db-max-rows (1000 on this project) with no error, and the plan
    // would quietly expand to fewer test cases than it has.
    expect(rangeCalls.length).toBeGreaterThan(0);
    expect(rangeCalls.every(([from, to]) => to - from + 1 === 1000)).toBe(true);
  });

  it('keeps each `.in(...)` id list small enough for a query string', async () => {
    await RegressionPlanService.expandPlan('plan-1');
    expect(Math.max(...inFilterSizes)).toBeLessThanOrEqual(100);
  });

  it('throws instead of expanding a plan from a half-read table', async () => {
    failingTables.add('intent_test_cases');

    // Silently returning the rows it did get would look exactly like a smaller
    // plan to runPlan, which would then dispatch a subset of the tests.
    await expect(RegressionPlanService.expandPlan('plan-1')).rejects.toThrow(/ui-cases/);
  });
});
