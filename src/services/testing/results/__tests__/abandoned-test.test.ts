/**
 * Tests for `StaleReaperService.handleAbandonedTest` — the event-driven
 * finalization fired from the worker's BullMQ `failed` handler when a test job
 * dies without writing a terminal status.
 *
 * The DB guard is stubbed at the `db/` boundary;
 * `TestCompletionHandlerService.handleTestCompletion` is spied to assert the
 * downstream pipeline only runs on a real flip.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/services/testing/results/db/test-completion.db', () => ({
  finalizeAbandonedTest: jest.fn(),
}));

import { finalizeAbandonedTest } from '@/services/testing/results/db/test-completion.db';
import { TestCompletionHandlerService } from '@/services/testing/results/test-completion-handler.service';
import { StaleReaperService } from '@/services/testing/results/stale-reaper.service';

const mockFinalize = finalizeAbandonedTest as jest.MockedFunction<typeof finalizeAbandonedTest>;

describe('StaleReaperService.handleAbandonedTest', () => {
  let completionSpy: jest.SpyInstance;

  beforeEach(() => {
    completionSpy = jest
      .spyOn(TestCompletionHandlerService, 'handleTestCompletion')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockFinalize.mockReset();
  });

  it('runs the completion pipeline when the row was actually flipped', async () => {
    mockFinalize.mockResolvedValue({ flipped: true, error: null });

    await StaleReaperService.handleAbandonedTest('t1', 'Job failed: worker died');

    expect(mockFinalize).toHaveBeenCalledWith('t1', 'failed');
    expect(completionSpy).toHaveBeenCalledWith('t1');
  });

  it('is a no-op when the row was already terminal (not flipped)', async () => {
    // Graceful failure already finalized the row, or a peer worker won the race.
    mockFinalize.mockResolvedValue({ flipped: false, error: null });

    await StaleReaperService.handleAbandonedTest('t1', 'reason');

    expect(completionSpy).not.toHaveBeenCalled();
  });

  it('does not run the completion pipeline when the DB write errored', async () => {
    mockFinalize.mockResolvedValue({ flipped: false, error: { message: 'boom' } });

    await StaleReaperService.handleAbandonedTest('t1', 'reason');

    expect(completionSpy).not.toHaveBeenCalled();
  });
});
