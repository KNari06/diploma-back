/**
 * A finished regression must NEVER start the Regression Doctor on its own.
 *
 * This is a cost guard, not a style preference: the analysis spends one vision
 * call per failed test, so a nightly suite that fails for an environmental
 * reason would bill for findings nobody asked to see. The only producer is
 * `POST /regression/runs/:runId/doctor/analyze`, driven by a button.
 *
 * The regression this pins is easy to reintroduce — "the panel is empty, let's
 * just enqueue it when the run finishes" is a one-line change that no other
 * test would notice. Here it fails loudly.
 */

interface QueryCtx {
  table: string;
  op: 'select' | 'update';
  select: string;
  patch: any;
}

const responder = jest.fn<{ data: any; error: any }, [QueryCtx]>();

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from(table: string) {
      const ctx: QueryCtx = { table, op: 'select', select: '', patch: null };
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

const addRegressionDoctorJob = jest.fn(async () => ({ queued: true, alreadyRunning: false }));

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {},
  QueueManager: { addRegressionDoctorJob },
}));
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

const ago = (mins: number) => new Date(Date.now() - mins * 60 * 1000).toISOString();

const RUN = {
  id: 'run-1',
  status: 'running',
  started_at: ago(5),
  user_id: 'u1',
  project_id: 'p1',
  plan_id: 'pl1',
  trigger: 'manual',
  test_id: null,
  test_ids: ['t1', 't2'],
  summary: null,
  pending_segments: null,
  last_segment_dispatched_at: null,
};

/** Every child failed, seconds ago — a run finishing red, with progress. */
function respondWithFailures() {
  responder.mockImplementation((ctx) => {
    if (ctx.table === 'test_executions') {
      if (ctx.select.includes('app_setup_ms')) return { data: [], error: null };
      return {
        data: [
          { id: 'e1', status: 'failed', error_message: 'boom', started_at: ago(4), completed_at: ago(1) },
          { id: 'e2', status: 'failed', error_message: 'boom', started_at: ago(4), completed_at: ago(1) },
        ],
        error: null,
      };
    }
    if (ctx.table === 'regression_runs') return { data: { id: RUN.id }, error: null };
    return { data: null, error: null };
  });
}

describe('recomputeRunStatus — the Doctor is never started automatically', () => {
  beforeEach(() => {
    responder.mockReset();
    addRegressionDoctorJob.mockClear();
  });

  it('does not enqueue the analysis when a run finishes with failures', async () => {
    respondWithFailures();

    await TestCompletionHandlerService.recomputeRunStatus({ ...RUN });

    expect(addRegressionDoctorJob).not.toHaveBeenCalled();
  });

  it('does not enqueue it for a single failed test either', async () => {
    // The old threshold was ">= 2 failed"; when that became ">= 1" the cost
    // doubled for exactly the runs users care least about. Neither count runs.
    responder.mockImplementation((ctx) => {
      if (ctx.table === 'test_executions') {
        if (ctx.select.includes('app_setup_ms')) return { data: [], error: null };
        return {
          data: [
            { id: 'e1', status: 'failed', error_message: 'boom', started_at: ago(4), completed_at: ago(1) },
            { id: 'e2', status: 'passed', error_message: null, started_at: ago(4), completed_at: ago(1) },
          ],
          error: null,
        };
      }
      if (ctx.table === 'regression_runs') return { data: { id: RUN.id }, error: null };
      return { data: null, error: null };
    });

    await TestCompletionHandlerService.recomputeRunStatus({ ...RUN });

    expect(addRegressionDoctorJob).not.toHaveBeenCalled();
  });
});
