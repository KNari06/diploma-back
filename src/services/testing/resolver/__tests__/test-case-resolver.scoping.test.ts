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
    like: (col: string, val: any) => { rec.filters[`${col}__like`] = val; return builder; },
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

// Deterministic embeddings so findSimilar's hybrid scoring is stable offline.
// A name containing "login" embeds as [1,0]; anything else as [0,1] — so a
// "login" query scores ~1.0 against login candidates, ~0 against others.
jest.mock('@/services/ai/core/embedding.service', () => ({
  generateEmbedding: jest.fn(async (text: string) =>
    /login/i.test(text) ? [1, 0] : [0, 1],
  ),
  cosineSimilarity: (a: number[], b: number[]) =>
    a[0] * b[0] + a[1] * b[1], // unit vectors → dot product
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

describe('TestCaseResolverService.findSimilar', () => {
  beforeEach(reset);

  it('scopes to owner projects and applies the platform prefix in the DB query (before the cap)', async () => {
    responses['projects'] = { data: [{ id: 'p1' }] };
    responses['intent_test_cases'] = {
      data: [
        { id: 'tc1', name: 'Login with email', platform: 'mobile_android', updated_at: '2026-07-01' },
      ],
    };
    const hits = await TestCaseResolverService.findSimilar({
      query: 'log in with email and password',
      userId: 'u1',
      workspaceId: 'w1',
      platformPrefix: 'mobile_',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('tc1');
    // owner-scoped project lookup + platform filter in the candidate query
    const proj = recorded.find((r) => r.table === 'projects')!;
    expect(proj.filters.user_id).toBe('u1');
    const tc = recorded.find((r) => r.table === 'intent_test_cases')!;
    expect(tc.filters['platform__like']).toBe('mobile_%');
    expect(tc.filters.status).toBe('published');
  });

  it('ranks a semantically-matching case above an unrelated one', async () => {
    responses['projects'] = { data: [{ id: 'p1' }] };
    responses['intent_test_cases'] = {
      data: [
        { id: 'settings', name: 'Change settings', platform: 'mobile_android', updated_at: '2026-07-02' },
        { id: 'login', name: 'Login with email', platform: 'mobile_android', updated_at: '2026-07-01' },
      ],
    };
    const hits = await TestCaseResolverService.findSimilar({
      query: 'login flow',
      userId: 'u1',
      workspaceId: 'w1',
      platformPrefix: 'mobile_',
    });
    expect(hits[0].id).toBe('login'); // embedding + name both favour the login row
  });

  it('returns [] when no candidates exist', async () => {
    responses['projects'] = { data: [{ id: 'p1' }] };
    responses['intent_test_cases'] = { data: [] };
    const hits = await TestCaseResolverService.findSimilar({
      query: 'anything',
      userId: 'u1',
      workspaceId: 'w1',
      platformPrefix: 'mobile_',
    });
    expect(hits).toEqual([]);
  });

  it('never throws — returns [] on a candidate query error', async () => {
    responses['projects'] = { data: [{ id: 'p1' }] };
    responses['intent_test_cases'] = { error: new Error('boom'), data: [] };
    const hits = await TestCaseResolverService.findSimilar({
      query: 'x',
      userId: 'u1',
      workspaceId: 'w1',
    });
    expect(hits).toEqual([]);
  });
});
