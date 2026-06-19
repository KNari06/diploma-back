/**
 * Tests for `StaleReaperService.reapStaleExplorations` — the backstop sweep that
 * marks exploration runs stuck 'running' as 'timed_out' when their worker died
 * without a terminal write. Stubbed at the storage boundary per the mock rule.
 */

jest.mock('@/services/testing/exploration/exploration-storage.service', () => ({
  ExplorationStorageService: {
    reapStaleRunningRuns: jest.fn(),
  },
}));

import { ExplorationStorageService } from '@/services/testing/exploration/exploration-storage.service';
import { StaleReaperService } from '@/services/testing/results/stale-reaper.service';

const mockReap = ExplorationStorageService.reapStaleRunningRuns as jest.MockedFunction<
  typeof ExplorationStorageService.reapStaleRunningRuns
>;

describe('StaleReaperService.reapStaleExplorations', () => {
  beforeEach(() => {
    mockReap.mockResolvedValue(0);
  });

  afterEach(() => {
    mockReap.mockReset();
  });

  it('reports zero when no exploration runs are stale', async () => {
    const result = await StaleReaperService.reapStaleExplorations();
    expect(result).toEqual({ scanned: 0 });
    expect(mockReap).toHaveBeenCalledTimes(1);
  });

  it('returns the count of runs the storage layer flipped', async () => {
    mockReap.mockResolvedValue(3);
    const result = await StaleReaperService.reapStaleExplorations();
    expect(result).toEqual({ scanned: 3 });
  });

  it('passes a cutoff older than now by the threshold (30 min default)', async () => {
    const before = Date.now();
    await StaleReaperService.reapStaleExplorations(30);

    expect(mockReap).toHaveBeenCalledTimes(1);
    const cutoffIso = mockReap.mock.calls[0][0];
    const cutoffMs = Date.parse(cutoffIso);
    // ~30 min in the past (allow a small execution window).
    const expected = before - 30 * 60 * 1000;
    expect(cutoffMs).toBeLessThanOrEqual(expected + 2000);
    expect(cutoffMs).toBeGreaterThanOrEqual(expected - 2000);
  });

  it('honors a custom threshold', async () => {
    const before = Date.now();
    await StaleReaperService.reapStaleExplorations(10);

    const cutoffMs = Date.parse(mockReap.mock.calls[0][0]);
    const expected = before - 10 * 60 * 1000;
    expect(cutoffMs).toBeLessThanOrEqual(expected + 2000);
    expect(cutoffMs).toBeGreaterThanOrEqual(expected - 2000);
  });
});
