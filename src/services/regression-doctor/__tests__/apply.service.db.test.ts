/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Integration tests for `applyDoctorFinding`.
 *
 * Scope: the DB-backed paths the pure `apply.service.test.ts` can't cover —
 * optimistic concurrency, ownership denial, snapshot creation+cleanup,
 * finding state transitions, per-test isolation.
 *
 * How it works:
 *   We stand up an in-memory fake of `supabaseAdmin` that mimics the
 *   chainable query builder closely enough for the service to run its
 *   real code path. Three "tables" are kept as Maps keyed by id:
 *     • regression_doctor_findings
 *     • intent_test_cases
 *     • regression_doctor_apply_snapshots
 *   Each query collects `.eq/.in` filters, then the terminal method
 *   (`.maybeSingle`, `.select`, `.delete`) applies them.
 *
 * What we DON'T simulate:
 *   • RLS policies — service uses supabaseAdmin (RLS-bypassing). Ownership
 *     is enforced by explicit `user_id` checks in the service; we verify
 *     THOSE by feeding mismatched ids and asserting the right skip reason.
 *   • Concurrent writes at the SQL level — we simulate the race by
 *     manually bumping `updated_at` between the service's read and write.
 *   • Partial failures at the network layer — out of scope for logic tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { DriftProposedPatch } from '../drift-agent';

// ─── In-memory Supabase fake ─────────────────────────────────────────────

type Row = Record<string, unknown> & { id?: string };

/**
 * Chainable query builder backed by a single `rows` array. Records
 * filters into `filters` and resolves them when a terminal method is
 * called. Update/delete return the affected rows via `.select()`.
 *
 * Enough coverage for our service — NOT a complete Supabase client.
 */
class FakeQuery {
  private filters: { col: string; op: 'eq' | 'in'; val: unknown }[] = [];
  private mode: 'select' | 'insert' | 'update' | 'delete' | null = null;
  private payload: Row | Row[] | null = null;
  private selectCols: string | null = null;

  constructor(private store: Map<string, Row>, private tableName: string) {}

  select(cols?: string) {
    if (this.mode === null) this.mode = 'select';
    this.selectCols = cols || '*';
    return this;
  }
  insert(payload: Row | Row[]) {
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.mode = 'update';
    this.payload = payload;
    return this;
  }
  delete() {
    this.mode = 'delete';
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: 'eq', val });
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push({ col, op: 'in', val: vals });
    return this;
  }
  order() {
    return this;
  }

  private matches(row: Row): boolean {
    for (const f of this.filters) {
      const rv = row[f.col];
      if (f.op === 'eq' && rv !== f.val) return false;
      if (f.op === 'in') {
        const arr = f.val as unknown[];
        if (!arr.includes(rv)) return false;
      }
    }
    return true;
  }

  private allMatches(): Row[] {
    return Array.from(this.store.values()).filter((r) => this.matches(r));
  }

  async maybeSingle() {
    const mode = this.mode ?? 'select';
    if (mode === 'select') {
      const hits = this.allMatches();
      if (hits.length === 0) return { data: null, error: null };
      return { data: hits[0], error: null };
    }
    // Not expected for insert/update/delete paths.
    return { data: null, error: null };
  }

  async single() {
    // Used by the insert('...').select('id').single() path.
    if (this.mode === 'insert') {
      const row = this.payload as Row;
      // Assign id if missing (snapshots table sets default in DB).
      const id =
        (row.id as string | undefined) ?? `row-${Math.random().toString(36).slice(2)}`;
      const full: Row = { ...row, id };
      this.store.set(id, full);
      return { data: { id }, error: null };
    }
    return this.maybeSingle();
  }

  // Thenable for: const { data, error } = await query.
  // Update/delete/select resolve here when no terminal called.
  then<T>(onfulfilled: (v: { data: unknown; error: null | Error }) => T): Promise<T> {
    return this.resolve().then(onfulfilled);
  }

  private async resolve(): Promise<{ data: unknown; error: null | Error }> {
    const mode = this.mode ?? 'select';

    if (mode === 'select') {
      return { data: this.allMatches(), error: null };
    }

    if (mode === 'insert') {
      const row = this.payload as Row;
      const id =
        (row.id as string | undefined) ?? `row-${Math.random().toString(36).slice(2)}`;
      const full: Row = { ...row, id };
      this.store.set(id, full);
      return { data: this.selectCols ? [{ id }] : null, error: null };
    }

    if (mode === 'update') {
      const hits = this.allMatches();
      for (const h of hits) {
        const id = h.id as string;
        this.store.set(id, { ...h, ...(this.payload as Row) });
      }
      // Mimic Supabase: `.select()` after update returns updated rows.
      return {
        data: this.selectCols ? hits.map((h) => ({ id: h.id })) : null,
        error: null,
      };
    }

    if (mode === 'delete') {
      const hits = this.allMatches();
      for (const h of hits) this.store.delete(h.id as string);
      return { data: null, error: null };
    }

    return { data: null, error: null };
  }
}

interface Tables {
  findings: Map<string, Row>;
  testCases: Map<string, Row>;
  snapshots: Map<string, Row>;
}

function buildFakeAdmin(tables: Tables) {
  return {
    from: (name: string): FakeQuery => {
      switch (name) {
        case 'regression_doctor_findings':
          return new FakeQuery(tables.findings, name);
        case 'intent_test_cases':
          return new FakeQuery(tables.testCases, name);
        case 'regression_doctor_apply_snapshots':
          return new FakeQuery(tables.snapshots, name);
        default:
          throw new Error(`Unexpected table: ${name}`);
      }
    },
  };
}

// ─── Module mock ─────────────────────────────────────────────────────────
// `jest.mock` is hoisted, so we define the tables inside a factory closure
// that we re-seed per test via `mockTables`.
const mockTables: Tables = {
  findings: new Map(),
  testCases: new Map(),
  snapshots: new Map(),
};

jest.mock('@/db/supabase', () => {
  // Lazily resolved — tests seed mockTables in beforeEach before the
  // service is called, and the fake reads the current Map contents.
  return {
    get supabaseAdmin() {
      return buildFakeAdmin(mockTables);
    },
    get supabase() {
      return buildFakeAdmin(mockTables);
    },
  };
});

// Silence logger noise in tests.
jest.mock('@/utils/core/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Now import the service AFTER mocks are registered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import {
  applyDoctorFinding,
  ApplyAccessError,
  ApplyConflictError,
  ApplyNotFoundError,
} from '../apply.service';

// ─── Test helpers ────────────────────────────────────────────────────────

const USER_A = 'user-aaa';
const USER_B = 'user-bbb';
const PROJECT = 'proj-1';

const replaceSelectorPatch: DriftProposedPatch = {
  action: 'replace_selector',
  targetStepIndex: 0,
  newSelector: '#new-btn',
  reason: 'Selector moved',
};

function seedFinding(overrides: Partial<Row> = {}): string {
  const id = (overrides.id as string | undefined) ?? 'finding-1';
  mockTables.findings.set(id, {
    id,
    user_id: USER_A,
    project_id: PROJECT,
    status: 'open',
    url_pattern: '/login',
    target_element_key: 'button:Click login',
    error_shape: 'selector_not_found',
    proposed_patch: replaceSelectorPatch,
    affected_test_ids: ['tc-1', 'tc-2'],
    ...overrides,
  });
  return id;
}

function seedTestCase(id: string, overrides: Partial<Row> = {}): void {
  mockTables.testCases.set(id, {
    id,
    user_id: USER_A,
    project_id: PROJECT,
    steps_json: [
      {
        id: 's1',
        type: 'click',
        description: 'Click login',
        bindingHints: { tag: 'button', selector: '#old-btn' },
      },
    ],
    updated_at: '2026-04-20T10:00:00.000Z',
    ...overrides,
  });
}

beforeEach(() => {
  mockTables.findings.clear();
  mockTables.testCases.clear();
  mockTables.snapshots.clear();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('applyDoctorFinding — validation & ownership', () => {
  it('throws ApplyNotFoundError when finding does not exist', async () => {
    await expect(
      applyDoctorFinding({ findingId: 'does-not-exist', userId: USER_A }),
    ).rejects.toBeInstanceOf(ApplyNotFoundError);
  });

  it('throws ApplyAccessError when caller does not own the finding', async () => {
    seedFinding();
    seedTestCase('tc-1');
    seedTestCase('tc-2');
    await expect(
      applyDoctorFinding({ findingId: 'finding-1', userId: USER_B }),
    ).rejects.toBeInstanceOf(ApplyAccessError);
  });

  it('throws ApplyConflictError when finding is already applied', async () => {
    seedFinding({ status: 'applied' });
    await expect(
      applyDoctorFinding({ findingId: 'finding-1', userId: USER_A }),
    ).rejects.toBeInstanceOf(ApplyConflictError);
  });

  it('throws ApplyConflictError when finding has no proposed_patch', async () => {
    seedFinding({ proposed_patch: null });
    await expect(
      applyDoctorFinding({ findingId: 'finding-1', userId: USER_A }),
    ).rejects.toBeInstanceOf(ApplyConflictError);
  });

  it('throws ApplyConflictError when affected_test_ids is empty', async () => {
    seedFinding({ affected_test_ids: [] });
    await expect(
      applyDoctorFinding({ findingId: 'finding-1', userId: USER_A }),
    ).rejects.toBeInstanceOf(ApplyConflictError);
  });

  it('drops unknown testCaseIds silently (intersection with affected list)', async () => {
    seedFinding();
    seedTestCase('tc-1');
    seedTestCase('tc-2');
    // Pass one valid + two unknowns. Result should act on the valid one only.
    const result = await applyDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
      testCaseIds: ['tc-1', 'tc-99', 'tc-100'],
    });
    expect(result.totalRequested).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].testCaseId).toBe('tc-1');
  });

  it('throws ApplyConflictError when testCaseIds intersects to empty set', async () => {
    seedFinding();
    seedTestCase('tc-1');
    seedTestCase('tc-2');
    await expect(
      applyDoctorFinding({
        findingId: 'finding-1',
        userId: USER_A,
        testCaseIds: ['not-in-list'],
      }),
    ).rejects.toBeInstanceOf(ApplyConflictError);
  });
});

describe('applyDoctorFinding — happy path', () => {
  it('applies patch to all affected tests, writes snapshots, flips finding to applied', async () => {
    seedFinding();
    seedTestCase('tc-1');
    seedTestCase('tc-2');

    const result = await applyDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    // Both tests patched
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.status === 'applied')).toBe(true);
    expect(result.findingStatus).toBe('applied');

    // Snapshots: one per patched test case.
    expect(mockTables.snapshots.size).toBe(2);
    const snaps = Array.from(mockTables.snapshots.values());
    expect(snaps.every((s) => s.finding_id === 'finding-1')).toBe(true);
    expect(snaps.every((s) => s.user_id === USER_A)).toBe(true);
    expect(snaps.every((s) => Array.isArray(s.steps_before))).toBe(true);
    expect(snaps.every((s) => Array.isArray(s.steps_after))).toBe(true);

    // Test case rows actually updated — selector written into bindingHints.
    const tc1 = mockTables.testCases.get('tc-1') as Row;
    const tc1Steps = tc1.steps_json as Array<{ bindingHints?: { selector?: string } }>;
    expect(tc1Steps[0].bindingHints?.selector).toBe('#new-btn');

    // Finding status flipped.
    const finding = mockTables.findings.get('finding-1') as Row;
    expect(finding.status).toBe('applied');
    expect(finding.applied_by).toBe(USER_A);
    expect(typeof finding.applied_at).toBe('string');
  });

  it('returns already_patched when the same patch was applied before', async () => {
    seedFinding();
    // Seed test case that ALREADY has the new selector applied.
    seedTestCase('tc-1', {
      steps_json: [
        {
          id: 's1',
          type: 'click',
          description: 'Click login',
          bindingHints: { tag: 'button', selector: '#new-btn' },
        },
      ],
    });
    seedTestCase('tc-2');

    const result = await applyDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    const outcomes = Object.fromEntries(
      result.results.map((r) => [r.testCaseId, r]),
    );
    expect(outcomes['tc-1'].status).toBe('skipped');
    if (outcomes['tc-1'].status === 'skipped') {
      expect(outcomes['tc-1'].reason).toBe('already_patched');
    }
    expect(outcomes['tc-2'].status).toBe('applied');
    // Finding still flips because ≥1 succeeded.
    expect(result.findingStatus).toBe('applied');
  });

  it('returns test_case_missing when one of the affected tests was deleted', async () => {
    seedFinding();
    seedTestCase('tc-1');
    // tc-2 NOT seeded

    const result = await applyDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    const outcomes = Object.fromEntries(
      result.results.map((r) => [r.testCaseId, r]),
    );
    expect(outcomes['tc-1'].status).toBe('applied');
    expect(outcomes['tc-2'].status).toBe('skipped');
    if (outcomes['tc-2'].status === 'skipped') {
      expect(outcomes['tc-2'].reason).toBe('test_case_missing');
    }
    // Finding flips because one succeeded.
    expect(result.findingStatus).toBe('applied');
  });

  it('returns access_denied when one of the affected tests belongs to a different user', async () => {
    seedFinding();
    seedTestCase('tc-1');
    seedTestCase('tc-2', { user_id: USER_B }); // owned by someone else

    const result = await applyDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    const outcomes = Object.fromEntries(
      result.results.map((r) => [r.testCaseId, r]),
    );
    expect(outcomes['tc-1'].status).toBe('applied');
    expect(outcomes['tc-2'].status).toBe('skipped');
    if (outcomes['tc-2'].status === 'skipped') {
      expect(outcomes['tc-2'].reason).toBe('access_denied');
    }
    // Snapshot count = 1 (only the owned test got written).
    expect(mockTables.snapshots.size).toBe(1);
  });
});

describe('applyDoctorFinding — optimistic concurrency', () => {
  it('skips with concurrent_edit when updated_at changed between read and write, and cleans up the orphan snapshot', async () => {
    seedFinding();
    seedTestCase('tc-1');
    seedTestCase('tc-2');

    // Hook into the fake: when the service writes a snapshot for tc-2
    // (insert into snapshots table), bump tc-2's updated_at BEFORE the
    // service's conditional UPDATE fires. Simulates a real-world race
    // where another request updated the test row in the interval.
    const origInsert = FakeQuery.prototype.insert;
    const spy = jest
      .spyOn(FakeQuery.prototype, 'insert')
      .mockImplementation(function (this: FakeQuery, payload: Row | Row[]) {
        const p = payload as Row;
        if (p.test_case_id === 'tc-2') {
          const row = mockTables.testCases.get('tc-2') as Row;
          mockTables.testCases.set('tc-2', {
            ...row,
            updated_at: '2099-12-31T00:00:00.000Z', // collides with the service's eq check
          });
        }
        // Fall back to the real insert behaviour.
        return origInsert.call(this, payload);
      });

    try {
      const result = await applyDoctorFinding({
        findingId: 'finding-1',
        userId: USER_A,
      });

      const outcomes = Object.fromEntries(
        result.results.map((r) => [r.testCaseId, r]),
      );
      expect(outcomes['tc-1'].status).toBe('applied');
      expect(outcomes['tc-2'].status).toBe('skipped');
      if (outcomes['tc-2'].status === 'skipped') {
        expect(outcomes['tc-2'].reason).toBe('concurrent_edit');
      }

      // Orphan snapshot for tc-2 should have been deleted. Remaining
      // snapshots must only reference tc-1.
      const snapshotTestCaseIds = Array.from(mockTables.snapshots.values()).map(
        (s) => s.test_case_id,
      );
      expect(snapshotTestCaseIds).toEqual(['tc-1']);

      // tc-2 NOT updated (still has its bumped updated_at and the
      // original steps_json).
      const tc2 = mockTables.testCases.get('tc-2') as Row;
      const tc2Steps = tc2.steps_json as Array<{
        bindingHints?: { selector?: string };
      }>;
      expect(tc2Steps[0].bindingHints?.selector).toBe('#old-btn'); // untouched
    } finally {
      spy.mockRestore();
    }
  });

  it('does NOT flip finding to applied when ALL tests hit concurrent_edit', async () => {
    seedFinding();
    seedTestCase('tc-1');
    seedTestCase('tc-2');

    // Bump both tests on EVERY snapshot insert.
    const origInsert = FakeQuery.prototype.insert;
    const spy = jest
      .spyOn(FakeQuery.prototype, 'insert')
      .mockImplementation(function (this: FakeQuery, payload: Row | Row[]) {
        const p = payload as Row;
        const tcId = p.test_case_id as string | undefined;
        if (tcId) {
          const row = mockTables.testCases.get(tcId) as Row;
          if (row) {
            mockTables.testCases.set(tcId, {
              ...row,
              updated_at: '2099-12-31T00:00:00.000Z',
            });
          }
        }
        return origInsert.call(this, payload);
      });

    try {
      const result = await applyDoctorFinding({
        findingId: 'finding-1',
        userId: USER_A,
      });

      expect(result.results.every((r) => r.status === 'skipped')).toBe(true);
      // Finding stays 'open' for retry.
      expect(result.findingStatus).toBe('open');
      const finding = mockTables.findings.get('finding-1') as Row;
      expect(finding.status).toBe('open');
      expect(finding.applied_at).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('applyDoctorFinding — per-test isolation', () => {
  it('isolates step resolution: one test missing the target still lets others apply', async () => {
    seedFinding();
    // tc-1 has the target step; tc-2 has an unrelated step the matcher
    // won't find AND an invalid fallback index.
    seedTestCase('tc-1');
    seedTestCase('tc-2', {
      steps_json: [
        // step text doesn't contain "Click login" — primary match fails.
        // targetStepIndex 0 IS in bounds, so the fallback will pick it.
        // To force no_step_matched, we need both text miss + out-of-bounds
        // index. Patch's targetStepIndex is 0, so set steps to empty.
      ],
    });

    // Re-seed the finding with a patch whose targetStepIndex is way past
    // the tc-2 steps length.
    mockTables.findings.set('finding-1', {
      ...(mockTables.findings.get('finding-1') as Row),
      proposed_patch: { ...replaceSelectorPatch, targetStepIndex: 50 },
    });

    const result = await applyDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    const outcomes = Object.fromEntries(
      result.results.map((r) => [r.testCaseId, r]),
    );
    expect(outcomes['tc-1'].status).toBe('applied');
    expect(outcomes['tc-2'].status).toBe('skipped');
    if (outcomes['tc-2'].status === 'skipped') {
      expect(outcomes['tc-2'].reason).toBe('no_step_matched');
    }
    // Mixed result — finding flips because ≥1 succeeded.
    expect(result.findingStatus).toBe('applied');
  });
});
