/**
 * getProjectGraphRows — pagination + project-only scoping.
 *
 * Regression guard for the link-cycle-check completeness gap (see
 * IntentTestCaseService's create()/update() link validation): the query
 * must (a) scope by `project_id` only, NOT also `user_id` — a shared
 * workspace project can hold rows created by different members, and a
 * cycle spanning two members' rows would be invisible to the check if it
 * were also filtered by a single owner — and (b) paginate past
 * PostgREST's default row cap instead of silently truncating a large
 * project's graph.
 */

let mockPages: Record<number, { data: Array<{ id: string; depends_on: string[]; steps_json: unknown[] }> | null; error: { message: string } | null }> = {};
const rangeCalls: Array<[number, number]> = [];
const eqCalls: Array<[string, string]> = [];

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn((col: string, val: string) => {
          eqCalls.push([col, val]);
          return {
            order: jest.fn(() => ({
              range: jest.fn(async (from: number, to: number) => {
                rangeCalls.push([from, to]);
                return mockPages[from] || { data: [], error: null };
              }),
            })),
          };
        }),
      })),
    })),
  },
}));

import { getProjectGraphRows } from '../intent-test-case.db';

beforeEach(() => {
  mockPages = {};
  rangeCalls.length = 0;
  eqCalls.length = 0;
});

describe('getProjectGraphRows', () => {
  it('scopes strictly by project_id, not also user_id', async () => {
    mockPages = { 0: { data: [{ id: 'a', depends_on: [], steps_json: [] }], error: null } };

    await getProjectGraphRows('proj-1');

    expect(eqCalls).toEqual([['project_id', 'proj-1']]);
  });

  it('returns all rows for a project under a single page', async () => {
    mockPages = {
      0: {
        data: [
          { id: 'a', depends_on: [], steps_json: [] },
          { id: 'b', depends_on: ['a'], steps_json: [] },
        ],
        error: null,
      },
    };

    const { data, error } = await getProjectGraphRows('proj-1');

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    expect(rangeCalls).toEqual([[0, 999]]);
  });

  it('paginates past the first page instead of silently truncating a large project', async () => {
    const page0 = Array.from({ length: 1000 }, (_, i) => ({ id: `row-${i}`, depends_on: [], steps_json: [] }));
    const page1 = [{ id: 'row-1000', depends_on: [], steps_json: [] }];
    mockPages = {
      0: { data: page0, error: null },
      1000: { data: page1, error: null },
    };

    const { data, error } = await getProjectGraphRows('proj-1');

    expect(error).toBeNull();
    expect(data).toHaveLength(1001);
    expect(rangeCalls).toEqual([[0, 999], [1000, 1999]]);
  });

  it('surfaces a page error instead of returning a partial graph', async () => {
    mockPages = { 0: { data: null, error: { message: 'connection reset' } } };

    const { data, error } = await getProjectGraphRows('proj-1');

    expect(data).toBeNull();
    expect(error).toEqual({ message: 'connection reset' });
    // Stops at the failing page — never proceeds to a second range() call.
    expect(rangeCalls).toEqual([[0, 999]]);
  });
});
