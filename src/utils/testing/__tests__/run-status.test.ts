import { deriveRunStatus } from '../run-status.utils';

describe('deriveRunStatus', () => {
  // ── The bug scenario ────────────────────────────────────────────────────────

  it('returns "failed" when cached status is "completed" but executions have failures', () => {
    expect(
      deriveRunStatus({ cachedStatus: 'completed', execStats: { total: 2, failed: 2 } }),
    ).toBe('failed');
  });

  it('returns "failed" when cached status is "completed" and some (not all) executions failed', () => {
    expect(
      deriveRunStatus({ cachedStatus: 'completed', execStats: { total: 3, failed: 1 } }),
    ).toBe('failed');
  });

  // ── Stuck-execution guard ───────────────────────────────────────────────────

  it('returns "running" when cached status is "completed" but an execution is still running', () => {
    // Regression: force-fail DB write failed → execution stays 'running' in DB.
    // deriveRunStatus must surface the inconsistency rather than masking it as 'passed'.
    expect(
      deriveRunStatus({ cachedStatus: 'completed', execStats: { total: 2, failed: 0, running: 1 } }),
    ).toBe('running');
  });

  // ── Correct terminal states ─────────────────────────────────────────────────

  it('returns "passed" when cached status is "completed" and no executions failed', () => {
    expect(
      deriveRunStatus({ cachedStatus: 'completed', execStats: { total: 2, failed: 0 } }),
    ).toBe('passed');
  });

  it('returns "failed" when cached status is already "failed"', () => {
    expect(
      deriveRunStatus({ cachedStatus: 'failed', execStats: { total: 2, failed: 2 } }),
    ).toBe('failed');
  });

  it('returns "failed" when cached status is "failed" and execStats total is 0', () => {
    // No executions — fall back to cached
    expect(
      deriveRunStatus({ cachedStatus: 'failed', execStats: { total: 0, failed: 0 } }),
    ).toBe('failed');
  });

  // ── In-progress states are trusted as-is ───────────────────────────────────

  it('returns "running" when cached status is "running", regardless of execStats', () => {
    expect(
      deriveRunStatus({ cachedStatus: 'running', execStats: { total: 2, failed: 1 } }),
    ).toBe('running');
  });

  it('returns "pending" when cached status is "pending", regardless of execStats', () => {
    expect(
      deriveRunStatus({ cachedStatus: 'pending', execStats: { total: 0, failed: 0 } }),
    ).toBe('pending');
  });

  // ── Cancelled state ─────────────────────────────────────────────────────────

  it('returns "cancelled" when cached status is "cancelled"', () => {
    expect(
      deriveRunStatus({ cachedStatus: 'cancelled', execStats: { total: 1, failed: 1 } }),
    ).toBe('cancelled');
  });

  // ── Zero-execution fallback ─────────────────────────────────────────────────

  it('returns "passed" when no executions exist and cached status is "completed"', () => {
    expect(
      deriveRunStatus({ cachedStatus: 'completed', execStats: { total: 0, failed: 0 } }),
    ).toBe('passed');
  });

  it('returns null when cached status is null and no executions', () => {
    expect(
      deriveRunStatus({ cachedStatus: null, execStats: { total: 0, failed: 0 } }),
    ).toBeNull();
  });

  it('returns null when cached status is empty string and no executions', () => {
    expect(
      deriveRunStatus({ cachedStatus: '', execStats: { total: 0, failed: 0 } }),
    ).toBeNull();
  });
});
