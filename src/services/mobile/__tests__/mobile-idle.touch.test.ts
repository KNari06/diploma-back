/**
 * touchRunnerSessions: pings the runner to keep the user's editor session(s)
 * warm on `mobile:keepalive`, so an actively-edited session isn't
 * capacity-evicted during think-time (the 2026-06-29 lint-410 incident).
 *
 * Covers: resolves warmup sessionIds → touches each; throttles to one
 * runner round-trip per user per minute; best-effort (resolver / runner
 * failure is swallowed, never thrown — keepalive must not break).
 */

import { EventEmitter } from 'events';

const mockScanStream = jest.fn();
const mockGet = jest.fn();

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    scanStream: (...args: unknown[]) => mockScanStream(...args),
    get: (...args: unknown[]) => mockGet(...args),
    expire: jest.fn(),
    del: jest.fn(),
  },
}));

const mockTouchSession = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services/mobile/mobile-runner-client', () => ({
  getMobileRunnerClient: () => ({ touchSession: mockTouchSession }),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Import AFTER mocks so the module binds to them.
import { logger } from '@/utils/core/logger';
import { touchRunnerSessions, refreshIdle, cancelIdle } from '../mobile-idle.service';

const USER = 'user-1234567890';

/** Fake a `scanStream` that emits the given keys then ends. */
function streamReturning(keys: string[]) {
  return () => {
    const stream = new EventEmitter();
    // Defer so listeners are attached before events fire.
    setImmediate(() => {
      stream.emit('data', keys);
      stream.emit('end');
    });
    return stream;
  };
}

describe('touchRunnerSessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cancelIdle(USER); // reset the per-user throttle between tests
  });

  it('resolves warmup sessionIds and touches each on the runner', async () => {
    mockScanStream.mockImplementation(streamReturning([`mobile_warmup:proj-a:${USER}`]));
    mockGet.mockResolvedValue(JSON.stringify({ sessionId: 'sess-a' }));

    await touchRunnerSessions(USER);

    expect(mockTouchSession).toHaveBeenCalledTimes(1);
    expect(mockTouchSession).toHaveBeenCalledWith('sess-a', { userId: USER });
  });

  it('throttles to one runner round-trip per user within the interval', async () => {
    mockScanStream.mockImplementation(streamReturning([`mobile_warmup:proj-a:${USER}`]));
    mockGet.mockResolvedValue(JSON.stringify({ sessionId: 'sess-a' }));

    await touchRunnerSessions(USER);
    await touchRunnerSessions(USER); // immediate second call — should be throttled
    await touchRunnerSessions(USER);

    expect(mockTouchSession).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the user has no warmed sessions', async () => {
    mockScanStream.mockImplementation(streamReturning([])); // no matching keys
    await touchRunnerSessions(USER);
    expect(mockTouchSession).not.toHaveBeenCalled();
  });

  it('does not throw when sessionId resolution fails (Redis error)', async () => {
    mockScanStream.mockImplementation(() => {
      const stream = new EventEmitter();
      setImmediate(() => stream.emit('error', new Error('redis down')));
      return stream;
    });
    await expect(touchRunnerSessions(USER)).resolves.toBeUndefined();
    expect(mockTouchSession).not.toHaveBeenCalled();
  });

  it('ignores an empty userId', async () => {
    await touchRunnerSessions('');
    expect(mockScanStream).not.toHaveBeenCalled();
    expect(mockTouchSession).not.toHaveBeenCalled();
  });
});

describe('mobile idle expiry logging', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    cancelIdle(USER);
  });

  afterEach(() => {
    cancelIdle(USER);
    jest.useRealTimers();
  });

  it('emits the browser expiry event and a keyed session.expired log when idle fires', async () => {
    mockScanStream.mockImplementation(streamReturning([]));
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));

    refreshIdle(USER, { to } as never, 'test');
    expect(jest.getTimerCount()).toBe(1);
    await jest.runAllTimersAsync();

    expect(to).toHaveBeenCalledWith(`user:${USER}`);
    expect(emit).toHaveBeenCalledWith('mobile:session:expired', { reason: 'idle' });
    expect(logger.warn).toHaveBeenCalledWith('[MOBILE] session expired', expect.objectContaining({
      event: 'session.expired',
      severity: 'warning',
      code: 'SESSION_EXPIRED',
      reason: 'idle',
      surfacedBy: 'mobile_idle_timer',
      userId: USER,
    }));
  });
});
