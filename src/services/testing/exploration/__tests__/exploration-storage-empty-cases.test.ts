/**
 * `saveTestCases` must not persist step-less discovered cases.
 *
 * `TestCaseBuilder` emits one zero-step `not_explored` placeholder per unexplored
 * entry point (budget exhausted / Strategist-skipped). The web save path had no
 * guard, so each became a real `intent_test_cases` row with `steps_json: []` —
 * unrunnable, and indistinguishable from a genuine draft except by a tag. The
 * mobile snapshot path in the same service already guarded exactly this.
 */

import { ExplorationStorageService } from '../exploration-storage.service';
import { supabaseAdmin } from '@/db/supabase';
import type { DiscoveredTestCase } from '@/agent/core/lite/exploration/types';

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

const mockedFrom = supabaseAdmin.from as jest.MockedFunction<any>;

/** Capture what would be inserted. */
let inserted: any[] | null = null;
/** Every insert attempt, so a retry can be inspected. */
let insertAttempts: any[][] = [];
/** When set, the FIRST insert fails with this PostgREST code. */
let failFirstWithCode: string | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  inserted = null;
  insertAttempts = [];
  failFirstWithCode = null;
  mockedFrom.mockReturnValue({
    insert: (records: any[]) => {
      insertAttempts.push(records);
      inserted = records;
      if (failFirstWithCode && insertAttempts.length === 1) {
        const code = failFirstWithCode;
        return {
          select: () => ({
            data: null,
            error: { code, message: `column "network_assertions" does not exist` },
          }),
        };
      }
      return { select: () => ({ data: records.map((_, i) => ({ id: `id-${i}` })), error: null }) };
    },
  });
});

const testCase = (over: Partial<DiscoveredTestCase> = {}): DiscoveredTestCase =>
  ({
    id: 'ep-1',
    name: 'Login',
    description: 'Log in',
    category: 'authentication',
    priority: 'critical',
    testType: 'positive',
    explored: true,
    status: 'passed',
    steps: [{ stepNumber: 1, action: 'navigate', description: 'Open', value: 'https://acme.com/' }],
    entryUrl: 'https://acme.com/',
    requiresAuth: false,
    tags: ['authentication', 'critical', 'positive'],
    errors: [],
    errorClassification: 'no_errors',
    sourcePageUrl: 'https://acme.com/',
    ...over,
  }) as unknown as DiscoveredTestCase;

describe('saveTestCases — step-less cases are dropped', () => {
  it('saves a case that has steps', async () => {
    const ids = await ExplorationStorageService.saveTestCases([testCase()], 'proj-1', 'user-1');

    expect(ids).toHaveLength(1);
    expect(inserted).toHaveLength(1);
  });

  it('drops a zero-step not_explored placeholder', async () => {
    const ids = await ExplorationStorageService.saveTestCases(
      [testCase({ id: 'ep-2', status: 'not_explored', explored: false, steps: [] })],
      'proj-1',
      'user-1',
    );

    expect(ids).toEqual([]);
    // No insert attempted at all — not an insert of an empty array.
    expect(inserted).toBeNull();
  });

  it('saves only the runnable cases from a mixed batch', async () => {
    const ids = await ExplorationStorageService.saveTestCases(
      [
        testCase({ id: 'ep-1' }),
        testCase({ id: 'ep-2', status: 'not_explored', explored: false, steps: [] }),
        testCase({ id: 'ep-3', status: 'not_explored', explored: false, steps: [] }),
      ],
      'proj-1',
      'user-1',
    );

    expect(ids).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    expect(inserted![0].name).toBe('Login');
  });

  it('treats a missing steps array as not runnable', async () => {
    const ids = await ExplorationStorageService.saveTestCases(
      [testCase({ steps: undefined as any })],
      'proj-1',
      'user-1',
    );

    expect(ids).toEqual([]);
    expect(inserted).toBeNull();
  });

  it('returns [] for an empty input without touching the DB', async () => {
    const ids = await ExplorationStorageService.saveTestCases([], 'proj-1', 'user-1');

    expect(ids).toEqual([]);
    expect(mockedFrom).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// network_assertions persistence
// ═══════════════════════════════════════════════════════════════════════════

describe('saveTestCases — network assertions', () => {
  const withAssertions = () =>
    testCase({
      assertions: [
        { type: 'network', expect: 'POST /api/auth returns 2xx', source: { method: 'POST', urlPattern: 'https://acme.com/api/auth', status: 200 } },
        { type: 'console', expect: 'no console errors' },
      ],
    } as any);

  it('persists the FULL assertion shape, not just the lossy tag', async () => {
    await ExplorationStorageService.saveTestCases([withAssertions()], 'proj-1', 'user-1');

    const row = inserted![0];
    expect(row.network_assertions).toHaveLength(1);
    // `expect` is what the tag dropped entirely.
    expect(row.network_assertions[0].expect).toBe('POST /api/auth returns 2xx');
    expect(row.network_assertions[0].source).toMatchObject({ method: 'POST', status: 200 });
  });

  it('keeps the human-filterable assert: tag as well', async () => {
    await ExplorationStorageService.saveTestCases([withAssertions()], 'proj-1', 'user-1');

    expect(inserted![0].tags.some((t: string) => t.startsWith('assert:network:'))).toBe(true);
  });

  it('carries only network assertions — other kinds have no verifier yet', async () => {
    await ExplorationStorageService.saveTestCases([withAssertions()], 'proj-1', 'user-1');

    // Persisting a console assertion nothing can check would be decoration that
    // LOOKS like verification.
    expect(inserted![0].network_assertions.every((a: any) => a.type === 'network')).toBe(true);
  });

  it('writes NULL (not []) when there are no assertions', async () => {
    await ExplorationStorageService.saveTestCases([testCase()], 'proj-1', 'user-1');

    // NULL must read as "nothing recorded", never as "verified and empty".
    expect(inserted![0].network_assertions).toBeNull();
  });

  it('still saves the test cases when the migration has not been applied', async () => {
    // PostgREST fails the WHOLE insert on a missing column, so without the
    // retry this feature would break every exploration save until the migration
    // lands. Losing assertions is degraded; losing test cases is a regression.
    failFirstWithCode = 'PGRST204';

    const ids = await ExplorationStorageService.saveTestCases([withAssertions()], 'proj-1', 'user-1');

    expect(ids).toHaveLength(1);
    expect(insertAttempts).toHaveLength(2);
    expect(insertAttempts[0][0]).toHaveProperty('network_assertions');
    expect(insertAttempts[1][0]).not.toHaveProperty('network_assertions');
    // The rest of the row must survive the retry intact.
    expect(insertAttempts[1][0].name).toBe('Login');
    expect(insertAttempts[1][0].steps_json).toBeDefined();
  });

  it('does NOT retry on an unrelated DB error', async () => {
    failFirstWithCode = '23505'; // unique violation

    const ids = await ExplorationStorageService.saveTestCases([withAssertions()], 'proj-1', 'user-1');

    expect(ids).toEqual([]);
    expect(insertAttempts).toHaveLength(1);
  });
});
