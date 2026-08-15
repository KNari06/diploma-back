/**
 * Integration tests for `revertDoctorFinding`. Uses the same in-memory
 * Supabase fake as `apply.service.db.test.ts` — duplicated here
 * on purpose so the two suites stay independent (each test file cleans
 * its own mocks).
 *
 * Scope:
 *   • Validation: not-found / access / non-applied findings / no snapshots
 *   • Happy path: full revert → finding flips to open, snapshots deleted
 *   • Refuses to revert manually-edited tests (modified_after_apply)
 *   • Optimistic concurrency (concurrent_edit)
 *   • Partial revert keeps finding in applied state
 *   • Per-snapshot isolation
 */

// ─── In-memory Supabase fake (same shape as apply integration test) ───────
type Row = Record<string, unknown> & { id?: string };

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
    return { data: null, error: null };
  }

  async single() {
    if (this.mode === 'insert') {
      const row = this.payload as Row;
      const id =
        (row.id as string | undefined) ?? `row-${Math.random().toString(36).slice(2)}`;
      const full: Row = { ...row, id };
      this.store.set(id, full);
      return { data: { id }, error: null };
    }
    return this.maybeSingle();
  }

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

const mockTables: Tables = {
  findings: new Map(),
  testCases: new Map(),
  snapshots: new Map(),
};

jest.mock('@/db/supabase', () => {
  return {
    get supabaseAdmin() {
      return buildFakeAdmin(mockTables);
    },
    get supabase() {
      return buildFakeAdmin(mockTables);
    },
  };
});

jest.mock('@/utils/core/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Import AFTER mocks are registered.
import {
  revertDoctorFinding,
} from '../revert.service';
import {
  ApplyAccessError,
  ApplyConflictError,
  ApplyNotFoundError,
} from '../apply.service';

// ─── Helpers ────────────────────────────────────────────────────────────
const USER_A = 'user-aaa';
const USER_B = 'user-bbb';

const stepsBefore = [
  {
    id: 's1',
    type: 'click',
    description: 'Click login',
    bindingHints: { tag: 'button', selector: '#old-btn' },
  },
];
const stepsAfter = [
  {
    id: 's1',
    type: 'click',
    description: 'Click login',
    bindingHints: { tag: 'button', selector: '#new-btn' }, // patched selector
  },
];

function seedAppliedFinding(overrides: Partial<Row> = {}): string {
  const id = (overrides.id as string | undefined) ?? 'finding-1';
  mockTables.findings.set(id, {
    id,
    user_id: USER_A,
    status: 'applied',
    applied_at: '2026-04-20T10:00:00.000Z',
    applied_by: USER_A,
    ...overrides,
  });
  return id;
}

function seedTestCase(id: string, overrides: Partial<Row> = {}): void {
  mockTables.testCases.set(id, {
    id,
    user_id: USER_A,
    // Default: current state matches stepsAfter (post-apply, unmodified).
    steps_json: stepsAfter,
    updated_at: '2026-04-20T11:00:00.000Z',
    ...overrides,
  });
}

function seedSnapshot(
  id: string,
  testCaseId: string,
  findingId: string,
  overrides: Partial<Row> = {},
): void {
  mockTables.snapshots.set(id, {
    id,
    finding_id: findingId,
    test_case_id: testCaseId,
    user_id: USER_A,
    steps_before: stepsBefore,
    steps_after: stepsAfter,
    before_updated_at: '2026-04-20T09:00:00.000Z',
    ...overrides,
  });
}

beforeEach(() => {
  mockTables.findings.clear();
  mockTables.testCases.clear();
  mockTables.snapshots.clear();
});

// ─── Validation ─────────────────────────────────────────────────────────
describe('revertDoctorFinding — validation', () => {
  it('throws ApplyNotFoundError when finding does not exist', async () => {
    await expect(
      revertDoctorFinding({ findingId: 'does-not-exist', userId: USER_A }),
    ).rejects.toBeInstanceOf(ApplyNotFoundError);
  });

  it('throws ApplyAccessError on wrong owner', async () => {
    seedAppliedFinding();
    await expect(
      revertDoctorFinding({ findingId: 'finding-1', userId: USER_B }),
    ).rejects.toBeInstanceOf(ApplyAccessError);
  });

  it('throws ApplyConflictError when finding is still open', async () => {
    seedAppliedFinding({ status: 'open' });
    await expect(
      revertDoctorFinding({ findingId: 'finding-1', userId: USER_A }),
    ).rejects.toBeInstanceOf(ApplyConflictError);
  });

  it('throws ApplyConflictError when finding was dismissed', async () => {
    seedAppliedFinding({ status: 'dismissed' });
    await expect(
      revertDoctorFinding({ findingId: 'finding-1', userId: USER_A }),
    ).rejects.toBeInstanceOf(ApplyConflictError);
  });

  it('throws ApplyConflictError when there are no snapshots', async () => {
    seedAppliedFinding();
    // no snapshots seeded
    await expect(
      revertDoctorFinding({ findingId: 'finding-1', userId: USER_A }),
    ).rejects.toBeInstanceOf(ApplyConflictError);
  });

  it('throws ApplyConflictError when snapshotIds intersects to empty set', async () => {
    seedAppliedFinding();
    seedTestCase('tc-1');
    seedSnapshot('snap-1', 'tc-1', 'finding-1');
    await expect(
      revertDoctorFinding({
        findingId: 'finding-1',
        userId: USER_A,
        snapshotIds: ['unknown-snap'],
      }),
    ).rejects.toBeInstanceOf(ApplyConflictError);
  });

  it('drops unknown snapshotIds silently (intersection)', async () => {
    seedAppliedFinding();
    seedTestCase('tc-1');
    seedSnapshot('snap-1', 'tc-1', 'finding-1');

    const result = await revertDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
      snapshotIds: ['snap-1', 'unknown-1', 'unknown-2'],
    });
    expect(result.totalRequested).toBe(1);
    expect(result.results).toHaveLength(1);
  });
});

// ─── Happy path ─────────────────────────────────────────────────────────
describe('revertDoctorFinding — happy path', () => {
  it('reverts all snapshots, deletes them, flips finding back to open and clears applied_* fields', async () => {
    seedAppliedFinding();
    seedTestCase('tc-1');
    seedTestCase('tc-2');
    seedSnapshot('snap-1', 'tc-1', 'finding-1');
    seedSnapshot('snap-2', 'tc-2', 'finding-1');

    const result = await revertDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.status === 'reverted')).toBe(true);
    expect(result.findingStatus).toBe('open');
    expect(result.remainingSnapshots).toBe(0);

    // Tests restored to stepsBefore.
    const tc1 = mockTables.testCases.get('tc-1') as Row;
    const tc1Steps = tc1.steps_json as Array<{ bindingHints?: { selector?: string } }>;
    expect(tc1Steps[0].bindingHints?.selector).toBe('#old-btn');

    const tc2 = mockTables.testCases.get('tc-2') as Row;
    const tc2Steps = tc2.steps_json as Array<{ bindingHints?: { selector?: string } }>;
    expect(tc2Steps[0].bindingHints?.selector).toBe('#old-btn');

    // Snapshots deleted.
    expect(mockTables.snapshots.size).toBe(0);

    // Finding back to open with applied_* cleared.
    const finding = mockTables.findings.get('finding-1') as Row;
    expect(finding.status).toBe('open');
    expect(finding.applied_at).toBeNull();
    expect(finding.applied_by).toBeNull();
  });
});

// ─── Safety: user edited after apply ────────────────────────────────────
describe('revertDoctorFinding — manual edits safety', () => {
  it('skips modified_after_apply when current steps_json differs from steps_after', async () => {
    seedAppliedFinding();
    // tc-1 — user manually tweaked description after apply
    seedTestCase('tc-1', {
      steps_json: [
        {
          id: 's1',
          type: 'click',
          description: 'Click login (updated by human)',
          bindingHints: { tag: 'button', selector: '#new-btn' },
        },
      ],
    });
    // tc-2 — pristine post-apply state
    seedTestCase('tc-2');
    seedSnapshot('snap-1', 'tc-1', 'finding-1');
    seedSnapshot('snap-2', 'tc-2', 'finding-1');

    const result = await revertDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    const outcomes = Object.fromEntries(
      result.results.map((r) => [r.testCaseId, r]),
    );
    expect(outcomes['tc-1'].status).toBe('skipped');
    if (outcomes['tc-1'].status === 'skipped') {
      expect(outcomes['tc-1'].reason).toBe('modified_after_apply');
    }
    expect(outcomes['tc-2'].status).toBe('reverted');

    // Modified test stays modified — we did NOT overwrite the user's work.
    const tc1 = mockTables.testCases.get('tc-1') as Row;
    const tc1Steps = tc1.steps_json as Array<{ description: string }>;
    expect(tc1Steps[0].description).toBe('Click login (updated by human)');

    // snap-1 stays (audit trail for unreverted test). snap-2 gone.
    expect(mockTables.snapshots.has('snap-1')).toBe(true);
    expect(mockTables.snapshots.has('snap-2')).toBe(false);
  });

  it('keeps finding in applied state on partial revert (some snapshots remain)', async () => {
    seedAppliedFinding();
    seedTestCase('tc-1', {
      // user edited — this snap will skip
      steps_json: [
        {
          id: 's1',
          type: 'click',
          description: 'Edited',
          bindingHints: { tag: 'button', selector: '#new-btn' },
        },
      ],
    });
    seedTestCase('tc-2');
    seedSnapshot('snap-1', 'tc-1', 'finding-1');
    seedSnapshot('snap-2', 'tc-2', 'finding-1');

    const result = await revertDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    // snap-2 reverted, snap-1 skipped → snap-1 still attached to finding.
    expect(result.findingStatus).toBe('applied');
    expect(result.remainingSnapshots).toBe(1);
    const finding = mockTables.findings.get('finding-1') as Row;
    expect(finding.status).toBe('applied');
    expect(finding.applied_by).toBe(USER_A); // untouched on partial revert
  });
});

// ─── Access ─────────────────────────────────────────────────────────────
describe('revertDoctorFinding — per-test access', () => {
  it('skips access_denied when a test case ownership has changed', async () => {
    seedAppliedFinding();
    seedTestCase('tc-1', { user_id: USER_B }); // ownership flipped somehow
    seedTestCase('tc-2');
    seedSnapshot('snap-1', 'tc-1', 'finding-1');
    seedSnapshot('snap-2', 'tc-2', 'finding-1');

    const result = await revertDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    const outcomes = Object.fromEntries(
      result.results.map((r) => [r.testCaseId, r]),
    );
    expect(outcomes['tc-1'].status).toBe('skipped');
    if (outcomes['tc-1'].status === 'skipped') {
      expect(outcomes['tc-1'].reason).toBe('access_denied');
    }
    expect(outcomes['tc-2'].status).toBe('reverted');
  });

  it('skips test_case_missing when test was deleted', async () => {
    seedAppliedFinding();
    seedTestCase('tc-2');
    // tc-1 NOT seeded
    seedSnapshot('snap-1', 'tc-1', 'finding-1');
    seedSnapshot('snap-2', 'tc-2', 'finding-1');

    const result = await revertDoctorFinding({
      findingId: 'finding-1',
      userId: USER_A,
    });

    const outcomes = Object.fromEntries(
      result.results.map((r) => [r.testCaseId, r]),
    );
    expect(outcomes['tc-1'].status).toBe('skipped');
    if (outcomes['tc-1'].status === 'skipped') {
      expect(outcomes['tc-1'].reason).toBe('test_case_missing');
    }
    expect(outcomes['tc-2'].status).toBe('reverted');
  });
});

// ─── Concurrency ────────────────────────────────────────────────────────
describe('revertDoctorFinding — optimistic concurrency', () => {
  it('skips concurrent_edit when updated_at changes between read and write, and does NOT delete the snapshot', async () => {
    seedAppliedFinding();
    seedTestCase('tc-1');
    seedTestCase('tc-2');
    seedSnapshot('snap-1', 'tc-1', 'finding-1');
    seedSnapshot('snap-2', 'tc-2', 'finding-1');

    // Right before the service's conditional UPDATE fires on tc-1, bump
    // its updated_at. The service's `.eq('updated_at', beforeUpdatedAt)`
    // will then match 0 rows and report concurrent_edit.
    const origUpdate = FakeQuery.prototype.update;
    const spy = jest
      .spyOn(FakeQuery.prototype, 'update')
      .mockImplementation(function (this: FakeQuery, payload: Row) {
        // Heuristic: the service updates `steps_json` on intent_test_cases.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isTestCaseStepsUpdate = 'steps_json' in (payload as any);
        if (isTestCaseStepsUpdate) {
          // Bump tc-1 only, on the first time we see a steps_json update.
          const row = mockTables.testCases.get('tc-1') as Row;
          if (row && row.updated_at === '2026-04-20T11:00:00.000Z') {
            mockTables.testCases.set('tc-1', {
              ...row,
              updated_at: '2099-12-31T00:00:00.000Z',
            });
          }
        }
        return origUpdate.call(this, payload);
      });

    try {
      const result = await revertDoctorFinding({
        findingId: 'finding-1',
        userId: USER_A,
      });

      const outcomes = Object.fromEntries(
        result.results.map((r) => [r.testCaseId, r]),
      );
      expect(outcomes['tc-1'].status).toBe('skipped');
      if (outcomes['tc-1'].status === 'skipped') {
        expect(outcomes['tc-1'].reason).toBe('concurrent_edit');
      }
      expect(outcomes['tc-2'].status).toBe('reverted');

      // snap-1 STAYS (revert didn't happen, audit trail remains).
      // snap-2 deleted (revert succeeded).
      expect(mockTables.snapshots.has('snap-1')).toBe(true);
      expect(mockTables.snapshots.has('snap-2')).toBe(false);

      // Finding stays 'applied' because one snap remains.
      expect(result.findingStatus).toBe('applied');
      expect(result.remainingSnapshots).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
