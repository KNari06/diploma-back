/**
 * Scoping tests for TestCaseResolverService — the security-relevant paths added
 * for the chat "confirm-or-explore" flow:
 *  - ownerOnly restricts candidate projects to user_id = userId (so the
 *    owner-scoped runner can actually run what we surface).
 *  - userHasAnyTests counts only the user's OWN published cases + plans.
 *
 * We mock @/db/supabase with a small chainable query-builder recorder so we can
 * assert WHICH filters were applied and feed canned rows.
 */

import { TestCaseResolverService } from '../test-case-resolver.service';

// ── Chainable Supabase query-builder mock ───────────────────────────────────
type Filters = Record<string, any>;
interface Recorded {
  table: string;
  filters: Filters;
  head: boolean;
}
const recorded: Recorded[] = [];
// Per-table canned responses, set by each test.
let responses: Record<string, { data?: any[]; count?: number; error?: any }> = {};

function makeBuilder(table: string) {
  const rec: Recorded = { table, filters: {}, head: false };
  recorded.push(rec);
  const resolveValue = () => {
    const r = responses[table] || {};
    return { data: r.data ?? [], count: r.count ?? 0, error: r.error ?? null };
  };
  const builder: any = {
    select: (_sel: string, opts?: { head?: boolean }) => {
      if (opts?.head) rec.head = true;
      return builder;
    },
    eq: (col: string, val: any) => { rec.filters[col] = val; return builder; },
    in: (col: string, val: any) => { rec.filters[col] = val; return builder; },
    order: () => builder,
    limit: () => builder,
    // Make the builder awaitable (thenable) like a Supabase query.
    then: (onF: any, onR: any) => Promise.resolve(resolveValue()).then(onF, onR),
  };
  return builder;
}

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}));

function reset() {
  recorded.length = 0;
  responses = {};
}

describe('TestCaseResolverService.userHasAnyTests', () => {
  beforeEach(reset);

  it('returns false when the user owns no projects in the workspace', async () => {
    responses['projects'] = { data: [] };
    const has = await TestCaseResolverService.userHasAnyTests('u1', 'w1');
    expect(has).toBe(false);
    // project lookup MUST be scoped to BOTH workspace and owner
    const proj = recorded.find((r) => r.table === 'projects')!;
    expect(proj.filters.workspace_id).toBe('w1');
    expect(proj.filters.user_id).toBe('u1');
  });

  it('returns true when the user has at least one published test case', async () => {
    responses['projects'] = { data: [{ id: 'p1' }] };
    responses['intent_test_cases'] = { count: 2 };
    responses['regression_plans'] = { count: 0 };
    const has = await TestCaseResolverService.userHasAnyTests('u1', 'w1');
    expect(has).toBe(true);
    // test-case count is restricted to published + the owner's projects
    const tc = recorded.find((r) => r.table === 'intent_test_cases')!;
    expect(tc.filters.status).toBe('published');
    expect(tc.filters.project_id).toEqual(['p1']);
    expect(tc.head).toBe(true);
  });

  it('returns true when the user has a regression plan but no test cases', async () => {
    responses['projects'] = { data: [{ id: 'p1' }] };
    responses['intent_test_cases'] = { count: 0 };
    responses['regression_plans'] = { count: 1 };
    expect(await TestCaseResolverService.userHasAnyTests('u1', 'w1')).toBe(true);
  });

  it('returns false (never throws) when a count query errors', async () => {
    responses['projects'] = { data: [{ id: 'p1' }] };
    responses['intent_test_cases'] = { error: new Error('boom') };
    // error path: count is undefined → treated as 0; plans 0 → false
    responses['regression_plans'] = { count: 0 };
    expect(await TestCaseResolverService.userHasAnyTests('u1', 'w1')).toBe(false);
  });
});

describe('TestCaseResolverService.resolve — ownerOnly scoping', () => {
  beforeEach(reset);

  it('ownerOnly:true scopes the project lookup to the user', async () => {
    responses['projects'] = { data: [] }; // short-circuits to matchType none
    const result = await TestCaseResolverService.resolve({
      message: 'run login test',
      userId: 'u1',
      workspaceId: 'w1',
      ownerOnly: true,
    });
    expect(result.matchType).toBe('none');
    const proj = recorded.find((r) => r.table === 'projects')!;
    expect(proj.filters.workspace_id).toBe('w1');
    expect(proj.filters.user_id).toBe('u1'); // owner filter applied
  });

  it('without ownerOnly the project lookup is workspace-wide (no user filter)', async () => {
    responses['projects'] = { data: [] };
    await TestCaseResolverService.resolve({
      message: 'run login test',
      userId: 'u1',
      workspaceId: 'w1',
    });
    const proj = recorded.find((r) => r.table === 'projects')!;
    expect(proj.filters.workspace_id).toBe('w1');
    expect(proj.filters.user_id).toBeUndefined(); // workspace-wide
  });
});
