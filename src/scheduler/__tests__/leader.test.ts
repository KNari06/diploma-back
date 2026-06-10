/**
 * Tests for the scheduler leader lock:
 *  - only the replica that wins SET NX starts the sweep bundle (losers stand by);
 *  - renew extends the lock atomically (eval) while it stays owned;
 *  - losing leadership (eval → 0) stops the bundle;
 *  - release on shutdown deletes the lock atomically.
 */

const mockSet = jest.fn();
const mockEval = jest.fn();

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    set: (...a: any[]) => mockSet(...a),
    eval: (...a: any[]) => mockEval(...a),
  },
}));

jest.mock('@/config/environment/env', () => ({ env: { QUEUE_PREFIX: 'test:' } }));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const startTestScheduler = jest.fn();
const stopTestScheduler = jest.fn();
jest.mock('@/jobs/test-scheduler.job', () => ({
  TestSchedulerJobHandler: { start: (...a: any[]) => startTestScheduler(...a), stop: () => stopTestScheduler() },
}));
jest.mock('@/jobs/auto-learn-retire.job', () => ({
  AutoLearnRetireJob: { start: jest.fn(), stop: jest.fn() },
}));
jest.mock('@/jobs/account-deletion-purge.job', () => ({
  AccountDeletionPurgeJob: { start: jest.fn(), stop: jest.fn() },
}));
jest.mock('@/jobs/stale-run-reaper.job', () => ({
  StaleRunReaperJob: { start: jest.fn(), stop: jest.fn() },
}));
jest.mock('@/jobs/ai-call-logs-retention.job', () => ({
  AiCallLogsRetentionJob: { start: jest.fn(), stop: jest.fn() },
}));
jest.mock('@/jobs/artifact-retention.job', () => ({
  ArtifactRetentionJob: { start: jest.fn(), stop: jest.fn() },
}));
jest.mock('@/config/features/screenshot-capture', () => ({
  ScreenshotCaptureFeature: { isEnabled: () => false, logStatus: jest.fn() },
}));

// Load a fresh copy of leader.ts so its module-level `isLeader` flag does not
// leak across tests. Returns the module so a test can call it MULTIPLE times on
// the SAME instance (needed to exercise the renew / lose-leadership paths).
function freshLeader(): typeof import('../leader') {
  let mod: typeof import('../leader');
  jest.isolateModules(() => {
    mod = require('../leader');
  });
  return mod!;
}

describe('scheduler leader lock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts the bundle when it wins the lock, using SET NX EX on the prefixed key', async () => {
    mockSet.mockResolvedValue('OK');
    await freshLeader().tryBecomeOrRenewLeader();
    expect(startTestScheduler).toHaveBeenCalledTimes(1);
    expect(startTestScheduler).toHaveBeenCalledWith(60000);
    // Lock the contract: prefixed key + 90s TTL + NX.
    const [key, , mode, ttl, nx] = mockSet.mock.calls[0];
    expect(key).toBe('test:scheduler:leader');
    expect(mode).toBe('EX');
    expect(ttl).toBe(90);
    expect(nx).toBe('NX');
  });

  it('does NOT start the bundle when another replica holds the lock (SET NX → null)', async () => {
    mockSet.mockResolvedValue(null);
    await freshLeader().tryBecomeOrRenewLeader();
    expect(startTestScheduler).not.toHaveBeenCalled();
  });

  it('swallows Redis errors and does not start the bundle', async () => {
    mockSet.mockRejectedValue(new Error('redis down'));
    await expect(freshLeader().tryBecomeOrRenewLeader()).resolves.toBeUndefined();
    expect(startTestScheduler).not.toHaveBeenCalled();
  });

  it('renews the lock atomically on a second tick while still owned (no re-start)', async () => {
    const mod = freshLeader();
    mockSet.mockResolvedValue('OK');
    await mod.tryBecomeOrRenewLeader(); // acquire → start bundle
    mockEval.mockResolvedValue(1); // still ours
    await mod.tryBecomeOrRenewLeader(); // renew

    expect(mockEval).toHaveBeenCalledTimes(1);
    const [script, numKeys, key] = mockEval.mock.calls[0];
    expect(script).toMatch(/expire/i);
    expect(numKeys).toBe(1);
    expect(key).toBe('test:scheduler:leader');
    // SET NX only once (acquire); renew must NOT re-acquire or re-start.
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(startTestScheduler).toHaveBeenCalledTimes(1);
    expect(stopTestScheduler).not.toHaveBeenCalled();
  });

  it('stops the bundle when it has lost leadership (renew eval → 0)', async () => {
    const mod = freshLeader();
    mockSet.mockResolvedValue('OK');
    await mod.tryBecomeOrRenewLeader(); // acquire → start
    mockEval.mockResolvedValue(0); // lock no longer ours
    await mod.tryBecomeOrRenewLeader(); // renew fails → stop

    expect(stopTestScheduler).toHaveBeenCalledTimes(1);
  });

  it('releases the lock atomically on shutdown when held', async () => {
    const mod = freshLeader();
    mockSet.mockResolvedValue('OK');
    await mod.tryBecomeOrRenewLeader(); // acquire
    mockEval.mockResolvedValue(1);
    await mod.stopLeaderElection();

    // last eval call is the compare-and-delete release
    const lastCall = mockEval.mock.calls[mockEval.mock.calls.length - 1];
    expect(lastCall[0]).toMatch(/del/i);
    expect(lastCall[2]).toBe('test:scheduler:leader');
    expect(stopTestScheduler).toHaveBeenCalled();
  });

  it('does not attempt release when it never held the lock', async () => {
    const mod = freshLeader();
    mockSet.mockResolvedValue(null); // never won
    await mod.tryBecomeOrRenewLeader();
    await mod.stopLeaderElection();
    expect(mockEval).not.toHaveBeenCalled();
  });
});
