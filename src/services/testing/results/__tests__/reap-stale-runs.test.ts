/**
 * Tests for `StaleReaperService.reapStaleRuns` — the orchestration the
 * stale-run reaper relies on. The DB read is stubbed at the `db/` boundary
 * (`findStaleRuns`) per the repo's mock-boundary rule; the run-finalization
 * funnel `TestCompletionHandlerService.recomputeRunStatus` is spied so we
 * assert the loop behaviour without touching Supabase.
 *
 * What's pinned here is the contract the reaper depends on:
 *   - every stale run is finalized with side effects SUPPRESSED, and
 *   - one failing run never aborts the sweep.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { StaleRunRow } from '@/services/testing/results/db/test-completion.db';

// Stub the db/ boundary — the service must not query Supabase directly.
jest.mock('@/services/testing/results/db/test-completion.db', () => ({
  findStaleRuns: jest.fn(),
  findRunIdsWithStaleExecutions: jest.fn(),
  getRunsByIds: jest.fn(),
}));

import {
  findStaleRuns,
  findRunIdsWithStaleExecutions,
  getRunsByIds,
} from '@/services/testing/results/db/test-completion.db';
import { TestCompletionHandlerService } from '@/services/testing/results/test-completion-handler.service';
import { StaleReaperService } from '@/services/testing/results/stale-reaper.service';

const mockFindStaleRuns = findStaleRuns as jest.MockedFunction<typeof findStaleRuns>;
const mockFindExecRunIds = findRunIdsWithStaleExecutions as jest.MockedFunction<
  typeof findRunIdsWithStaleExecutions
>;
const mockGetRunsByIds = getRunsByIds as jest.MockedFunction<typeof getRunsByIds>;

const makeRun = (id: string): StaleRunRow => ({
  id,
  status: 'running',
  started_at: '2026-05-26T09:39:51.942+00:00',
  project_id: 'p1',
  user_id: 'u1',
  plan_id: 'pl1',
  trigger: 'manual',
  test_id: null,
  test_ids: ['t1'],
  summary: null,
  pending_segments: null,
  last_segment_dispatched_at: null,
});

describe('StaleReaperService.reapStaleRuns', () => {
  let recomputeSpy: jest.SpyInstance;

  beforeEach(() => {
    recomputeSpy = jest
      .spyOn(TestCompletionHandlerService, 'recomputeRunStatus')
      .mockResolvedValue(undefined);
    // Default every db boundary to "nothing found"; each test overrides.
    mockFindStaleRuns.mockResolvedValue([]);
    mockFindExecRunIds.mockResolvedValue([]);
    mockGetRunsByIds.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockFindStaleRuns.mockReset();
    mockFindExecRunIds.mockReset();
    mockGetRunsByIds.mockReset();
  });

  it('does nothing and reports zero when there are no stale runs', async () => {
    const result = await StaleReaperService.reapStaleRuns();

    expect(result).toEqual({ scanned: 0 });
    expect(recomputeSpy).not.toHaveBeenCalled();
  });

  it('finalizes every parent-level stale run with side effects suppressed', async () => {
    mockFindStaleRuns.mockResolvedValue([makeRun('r1'), makeRun('r2')]);

    const result = await StaleReaperService.reapStaleRuns();

    expect(result).toEqual({ scanned: 2 });
    expect(recomputeSpy).toHaveBeenCalledTimes(2);
    for (const call of recomputeSpy.mock.calls) {
      expect(call[1]).toEqual({ suppressSideEffects: true });
    }
  });

  // Regression: RUN_FIELDS used to omit pending_segments/last_segment_dispatched_at,
  // so a segmented chain surfaced via this reaper path (rather than the
  // event-driven test-completion path) reached recomputeRunStatus with those
  // fields silently undefined — its own pending-segments staleness guard read
  // `undefined` as "not segmented" and fell through to the legacy chain-wide
  // check the fix was specifically correcting. Asserts the fields now survive
  // the fetch all the way to the recomputeRunStatus call.
  it('passes pending_segments and last_segment_dispatched_at through to recomputeRunStatus', async () => {
    const segmentedRun = { ...makeRun('segmented-1'), pending_segments: 2, last_segment_dispatched_at: '2026-07-08T00:00:00.000Z' };
    mockFindStaleRuns.mockResolvedValue([segmentedRun]);

    await StaleReaperService.reapStaleRuns();

    expect(recomputeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pending_segments: 2, last_segment_dispatched_at: '2026-07-08T00:00:00.000Z' }),
      { suppressSideEffects: true },
    );
  });

  it('reaps child-level orphans whose parent run is already finalized', async () => {
    // Parent-status query finds nothing; the run surfaces only via a stuck
    // child execution — the exact 0c236ef0 scenario.
    mockFindStaleRuns.mockResolvedValue([]);
    mockFindExecRunIds.mockResolvedValue(['rX']);
    mockGetRunsByIds.mockResolvedValue([makeRun('rX')]);

    const result = await StaleReaperService.reapStaleRuns();

    expect(result).toEqual({ scanned: 1 });
    expect(mockGetRunsByIds).toHaveBeenCalledWith(['rX']);
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
    expect(recomputeSpy.mock.calls[0][0]).toMatchObject({ id: 'rX' });
    expect(recomputeSpy.mock.calls[0][1]).toEqual({ suppressSideEffects: true });
  });

  it('dedupes a run surfaced by both the parent and execution queries', async () => {
    mockFindStaleRuns.mockResolvedValue([makeRun('r1')]);
    mockFindExecRunIds.mockResolvedValue(['r1']); // same run

    const result = await StaleReaperService.reapStaleRuns();

    // r1 is already covered by the parent query → not re-hydrated, not double-recomputed.
    expect(mockGetRunsByIds).toHaveBeenCalledWith([]);
    expect(result).toEqual({ scanned: 1 });
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps sweeping when one run fails to recompute', async () => {
    mockFindStaleRuns.mockResolvedValue([makeRun('r1'), makeRun('r2'), makeRun('r3')]);
    recomputeSpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const result = await StaleReaperService.reapStaleRuns();

    // All three are still counted as scanned; the failure is isolated.
    expect(result).toEqual({ scanned: 3 });
    expect(recomputeSpy).toHaveBeenCalledTimes(3);
  });

  it('reports zero (and does not throw) when a db query fails', async () => {
    mockFindStaleRuns.mockRejectedValue(new Error('db down'));

    const result = await StaleReaperService.reapStaleRuns();

    expect(result).toEqual({ scanned: 0 });
    expect(recomputeSpy).not.toHaveBeenCalled();
  });
});
