import { deriveRunStatus } from '../run-status.utils';

describe('deriveRunStatus', () => {
  const derive = (cachedStatus: string | null, execStats: { total: number; failed: number; running?: number }) =>
    deriveRunStatus({ cachedStatus, execStats });

  it('trusts an in-progress cached status', () => {
    expect(derive('running', { total: 0, failed: 0 })).toBe('running');
    expect(derive('pending', { total: 0, failed: 0 })).toBe('pending');
  });

  it('trusts a cancelled cached status', () => {
    expect(derive('cancelled', { total: 5, failed: 2 })).toBe('cancelled');
  });

  it('derives "passed" for a terminal run whose executions all succeeded', () => {
    expect(derive('completed', { total: 3, failed: 0, running: 0 })).toBe('passed');
  });

  it('derives "failed" when any execution failed, overriding a stale "completed"', () => {
    expect(derive('completed', { total: 3, failed: 1, running: 0 })).toBe('failed');
  });

  it('surfaces "running" when a terminal parent still has live children', () => {
    // force-fail never landed in the DB — must not be masked as passed
    expect(derive('completed', { total: 3, failed: 0, running: 1 })).toBe('running');
  });

  it('prioritises live running children over failures', () => {
    expect(derive('failed', { total: 3, failed: 1, running: 2 })).toBe('running');
  });

  it('treats a missing running count as zero', () => {
    expect(derive('completed', { total: 2, failed: 0 })).toBe('passed');
  });

  it('normalises a cached "completed" to "passed" when there are no executions yet', () => {
    expect(derive('completed', { total: 0, failed: 0 })).toBe('passed');
  });

  it('falls back to the cached status when there are no executions and it is not "completed"', () => {
    expect(derive('failed', { total: 0, failed: 0 })).toBe('failed');
  });

  it('returns null when there is no cached status and no executions', () => {
    expect(derive(null, { total: 0, failed: 0 })).toBeNull();
  });
});
