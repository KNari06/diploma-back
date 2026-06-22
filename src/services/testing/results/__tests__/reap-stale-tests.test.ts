/**
 * Tests for `StaleReaperService.reapStaleTests` — the backstop sweep that
 * finalizes standalone `tests` rows stuck 'running'. The DB read/write are
 * stubbed at the `db/` boundary per the repo's mock-boundary rule.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/services/testing/results/db/test-completion.db', () => ({
  findStaleRunningTests: jest.fn(),
  forceFailStuckTests: jest.fn(),
}));

import {
  findStaleRunningTests,
  forceFailStuckTests,
} from '@/services/testing/results/db/test-completion.db';
import { StaleReaperService } from '@/services/testing/results/stale-reaper.service';

const mockFindStaleRunningTests = findStaleRunningTests as jest.MockedFunction<
  typeof findStaleRunningTests
>;
const mockForceFailStuckTests = forceFailStuckTests as jest.MockedFunction<
  typeof forceFailStuckTests
>;

describe('StaleReaperService.reapStaleTests', () => {
  beforeEach(() => {
    mockFindStaleRunningTests.mockResolvedValue([]);
    mockForceFailStuckTests.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    mockFindStaleRunningTests.mockReset();
    mockForceFailStuckTests.mockReset();
  });

  it('does nothing and reports zero when there are no stale tests', async () => {
    const result = await StaleReaperService.reapStaleTests();

    expect(result).toEqual({ scanned: 0 });
    expect(mockForceFailStuckTests).not.toHaveBeenCalled();
  });

  it('force-fails every stale test in one batch call', async () => {
    mockFindStaleRunningTests.mockResolvedValue([{ id: 't1' }, { id: 't2' }, { id: 't3' }]);

    const result = await StaleReaperService.reapStaleTests();

    expect(result).toEqual({ scanned: 3 });
    expect(mockForceFailStuckTests).toHaveBeenCalledTimes(1);
    expect(mockForceFailStuckTests).toHaveBeenCalledWith(['t1', 't2', 't3']);
  });

  it('reports zero (and does not throw) when the query fails', async () => {
    mockFindStaleRunningTests.mockRejectedValue(new Error('db down'));

    const result = await StaleReaperService.reapStaleTests();

    expect(result).toEqual({ scanned: 0 });
    expect(mockForceFailStuckTests).not.toHaveBeenCalled();
  });

  it('still reports scanned when the force-fail write returns an error (logged, non-bailing)', async () => {
    mockFindStaleRunningTests.mockResolvedValue([{ id: 't1' }]);
    mockForceFailStuckTests.mockResolvedValue({ error: { message: 'write failed' } });

    const result = await StaleReaperService.reapStaleTests();

    expect(result).toEqual({ scanned: 1 });
  });
});
