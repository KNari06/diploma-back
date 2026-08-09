/**
 * `recomputeRunStatus`'s force-fail guard, driven end-to-end against a
 * chainable `supabaseAdmin` stub. The pure predicate is covered separately in
 * `test-completion-handler.progress-stale.test.ts`; what this pins is the
 * WIRING the predicate depends on and a unit test of the predicate cannot see:
 *
 *   - the stuck-execution re-read actually asks for `started_at, completed_at`,
 *   - those rows (not `run.started_at`) decide whether to force-fail,
 *   - a long-but-progressing run is left completely alone — no force-fail
 *     write, no run finalization,
 *   - a genuinely stalled run still gets force-failed and finalized once.
 *
 * This is the check that replaces a >30-minute live regression run.
 */

interface QueryCtx {
  table: string;
  op: 'select' | 'update';
  select: string;
  patch: any;
}

const responder = jest.fn<{ data: any; error: any }, [QueryCtx]>();
const queries: QueryCtx[] = [];

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from(table: string) {
      const ctx: QueryCtx = { table, op: 'select', select: '', patch: null };
      queries.push(ctx);
      const builder: any = {
        select(cols?: string) {
          if (cols) ctx.select = cols;
          return builder;
        },
        update(patch: any) {
          ctx.op = 'update';
          ctx.patch = patch;
          return builder;
        },
        eq: () => builder,
        in: () => builder,
        lt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => builder,
        single: () => builder,
        then: (resolve: any, reject: any) =>
          Promise.resolve(responder(ctx)).then(resolve, reject),
      };
      return builder;
    },
  },
}));

jest.mock('@/config/infrastructure/queues', () => ({ redisConnection: {} }));
jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitRegressionRunProgress: jest.fn() },
}));
jest.mock('@/services/testing/regression/regression-report-assembler.service', () => ({
  getProjectWorkspaceMemberIds: jest.fn(async () => []),
}));
jest.mock('@/services/testing/results/db/test-completion.db', () => ({
  forceFailStuckExecutions: jest.fn(async () => ({ error: null })),
  forceFailStuckTests: jest.fn(async () => ({ error: null })),
  finalizeAbandonedTest: jest.fn(async () => ({ flipped: false, error: null })),
}));

import { TestCompletionHandlerService } from '../test-completion-handler.service';
import { forceFailStuckExecutions } from '../db/test-completion.db';

const mockForceFail = forceFailStuckExecutions as jest.MockedFunction<typeof forceFailStuckExecutions>;

const MINUTES = 60 * 1000;
const ago = (mins: number) => new Date(Date.now() - mins * MINUTES).toISOString();

const RUN = {
  id: 'run-1',
  status: 'running',
  started_at: ago(90), // three times the 30-minute threshold
  user_id: 'u1',
  project_id: 'p1',
  plan_id: 'pl1',
  trigger: 'manual',
  test_id: null,
  test_ids: ['t1', 't2', 't3'],
  summary: null,
  pending_segments: null,
  last_segment_dispatched_at: null,
};

/** Route each query by table + requested columns. */
function respondWith(execRows: any[]) {
  responder.mockImplementation((ctx) => {
    if (ctx.table === 'test_executions') {
      // The telemetry roll-up asks for the wallclock columns; nothing to sum here.
      if (ctx.select.includes('app_setup_ms')) return { data: [], error: null };
      return { data: execRows, error: null };
    }
    if (ctx.table === 'regression_runs') return { data: { id: RUN.id }, error: null };
    return { data: null, error: null };
  });
}

const progressSelects = () =>
  queries.filter(
    (q) =>
      q.table === 'test_executions' &&
      q.select.includes('started_at') &&
      q.select.includes('completed_at') &&
      !q.select.includes('app_setup_ms'),
  );

const runUpdates = () => queries.filter((q) => q.table === 'regression_runs' && q.op === 'update');

describe('recomputeRunStatus — force-fail guard uses the progress clock', () => {
  beforeEach(() => {
    queries.length = 0;
    responder.mockReset();
    mockForceFail.mockClear();
  });

  it('re-reads the executions WITH their progress timestamps', async () => {
    respondWith([
      { id: 'e1', status: 'passed', error_message: null, started_at: ago(80), completed_at: ago(2) },
      { id: 'e2', status: 'running', error_message: null, started_at: ago(2), completed_at: null },
    ]);

    await TestCompletionHandlerService.recomputeRunStatus({ ...RUN });

    expect(progressSelects().length).toBeGreaterThan(0);
  });

  it('leaves a long-but-progressing run alone — no force-fail, no finalization', async () => {
    // Run dispatched 90 minutes ago, but a child finished 2 minutes ago and
    // another started 1 minute ago. Under the old run-age clock both running
    // children would have been force-failed as timed out.
    respondWith([
      { id: 'e1', status: 'passed', error_message: null, started_at: ago(85), completed_at: ago(2) },
      { id: 'e2', status: 'running', error_message: null, started_at: ago(1), completed_at: null },
      { id: 'e3', status: 'pending', error_message: null, started_at: null, completed_at: null },
    ]);

    await TestCompletionHandlerService.recomputeRunStatus({ ...RUN });

    expect(mockForceFail).not.toHaveBeenCalled();
    expect(runUpdates()).toHaveLength(0);
  });

  it('force-fails and finalizes once nothing has progressed for the threshold', async () => {
    respondWith([
      { id: 'e1', status: 'passed', error_message: null, started_at: ago(90), completed_at: ago(75) },
      { id: 'e2', status: 'running', error_message: null, started_at: ago(74), completed_at: null },
      { id: 'e3', status: 'pending', error_message: null, started_at: null, completed_at: null },
    ]);

    await TestCompletionHandlerService.recomputeRunStatus({ ...RUN });

    expect(mockForceFail).toHaveBeenCalledTimes(1);
    const [ids, message] = mockForceFail.mock.calls[0];
    expect(ids).toEqual(['e2', 'e3']);
    expect(message).toMatch(/no run progress for \d+ minutes/);

    // Forced rows count as failures, so the run finalizes as failed — once.
    expect(runUpdates()).toHaveLength(1);
    expect(runUpdates()[0].patch).toMatchObject({ status: 'failed' });
  });
});
