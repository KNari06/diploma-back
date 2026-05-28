/**
 * Unit tests for mobile-session-authz.
 *
 * Covers:
 *   - happy path: warmup key binds session → resolves
 *   - foreign session: no warmup key matches → throws session_not_owned
 *   - missing inputs: empty userId / sessionId → throws fast
 *   - `_booting` placeholder never authorises
 *   - malformed JSON in a warmup payload is ignored, not granted
 *   - Redis error fails closed (throws redis_error)
 *   - cache: a second call with the same (userId, sessionId) reuses cache
 *   - negative cache: deny verdict is cached briefly
 */

import { Readable } from 'stream';

// ── Mock Redis BEFORE importing the module under test ─────────────────────

interface MockRedis {
  scanStream: jest.Mock;
  get: jest.Mock;
}

const mockRedis: MockRedis = {
  scanStream: jest.fn(),
  get: jest.fn(),
};

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: mockRedis,
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The authz module imports WARMUP_PREFIX from the session controller.
// Avoid pulling its full transitive graph (express/router) by stubbing
// just the constants we need.
jest.mock('@/api/mobile/session.controller', () => ({
  WARMUP_PREFIX: 'mobile_warmup:',
}));

import {
  assertMobileSessionOwnership,
  MobileSessionAuthzError,
  __resetAuthzCacheForTests,
} from '../mobile-session-authz';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a Readable that emits ONE 'data' event with the supplied keys,
 * then 'end'. Mimics ioredis's `scanStream()` minimal contract that the
 * authz module uses.
 */
function streamOfKeys(keys: string[]): Readable {
  const s = new Readable({ objectMode: true, read() {} });
  // Emit on next tick so the `await new Promise(...)` in the module
  // has time to attach its listeners.
  setImmediate(() => {
    if (keys.length > 0) s.push(keys);
    s.push(null);
  });
  return s;
}

function streamOfError(err: Error): Readable {
  const s = new Readable({ objectMode: true, read() {} });
  setImmediate(() => s.destroy(err));
  return s;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetAuthzCacheForTests();
});

// ══════════════════════════════════════════════════════════════════════════
// Input validation
// ══════════════════════════════════════════════════════════════════════════

describe('assertMobileSessionOwnership — input validation', () => {
  it('throws missing_userId when userId is empty', async () => {
    await expect(assertMobileSessionOwnership('', 'sess-1')).rejects.toMatchObject({
      name: 'MobileSessionAuthzError',
      reason: 'missing_userId',
    });
    expect(mockRedis.scanStream).not.toHaveBeenCalled();
  });

  it('throws missing_sessionId when sessionId is empty', async () => {
    await expect(assertMobileSessionOwnership('u1', '')).rejects.toMatchObject({
      name: 'MobileSessionAuthzError',
      reason: 'missing_sessionId',
    });
    expect(mockRedis.scanStream).not.toHaveBeenCalled();
  });

  it('throws missing_userId when userId is null/undefined', async () => {
    await expect(
      assertMobileSessionOwnership(null as unknown as string, 'sess-1'),
    ).rejects.toBeInstanceOf(MobileSessionAuthzError);
    await expect(
      assertMobileSessionOwnership(undefined, 'sess-1'),
    ).rejects.toBeInstanceOf(MobileSessionAuthzError);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Happy path
// ══════════════════════════════════════════════════════════════════════════

describe('assertMobileSessionOwnership — happy path', () => {
  it('resolves when warmup binds userId → sessionId', async () => {
    mockRedis.scanStream.mockReturnValueOnce(
      streamOfKeys(['mobile_warmup:proj-1:u1']),
    );
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ sessionId: 'sess-1', runnerUrl: 'x', platform: 'android' }),
    );

    await expect(assertMobileSessionOwnership('u1', 'sess-1')).resolves.toBeUndefined();
    expect(mockRedis.scanStream).toHaveBeenCalledTimes(1);
    expect(mockRedis.get).toHaveBeenCalledWith('mobile_warmup:proj-1:u1');
  });

  it('post-filters keys by `:{userId}` suffix — different user is ignored', async () => {
    // scanStream returns globbed `mobile_warmup:*` keys including
    // someone else's. The module must NOT call .get() on the foreign
    // user's key.
    mockRedis.scanStream.mockReturnValueOnce(
      streamOfKeys(['mobile_warmup:proj-1:u2', 'mobile_warmup:proj-2:u1']),
    );
    // Only the second key (ours) will be fetched.
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ sessionId: 'sess-1', runnerUrl: 'x', platform: 'android' }),
    );

    await expect(assertMobileSessionOwnership('u1', 'sess-1')).resolves.toBeUndefined();
    // Only the matching-suffix key was fetched.
    expect(mockRedis.get).toHaveBeenCalledTimes(1);
    expect(mockRedis.get).toHaveBeenCalledWith('mobile_warmup:proj-2:u1');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Rejection paths
// ══════════════════════════════════════════════════════════════════════════

describe('assertMobileSessionOwnership — rejections', () => {
  it('throws session_not_owned when user has no warmup keys at all', async () => {
    mockRedis.scanStream.mockReturnValueOnce(streamOfKeys([]));

    await expect(assertMobileSessionOwnership('u1', 'sess-1')).rejects.toMatchObject({
      reason: 'no_warmup',
    });
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('throws when warmup key exists but its sessionId is different', async () => {
    mockRedis.scanStream.mockReturnValueOnce(
      streamOfKeys(['mobile_warmup:proj-1:u1']),
    );
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ sessionId: 'other-sess', runnerUrl: 'x', platform: 'android' }),
    );

    await expect(
      assertMobileSessionOwnership('u1', 'attacker-supplied-sess'),
    ).rejects.toMatchObject({ reason: 'no_warmup' });
  });

  it('refuses `_booting` placeholder — even if the user supplies it explicitly', async () => {
    mockRedis.scanStream.mockReturnValueOnce(
      streamOfKeys(['mobile_warmup:proj-1:u1']),
    );
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ sessionId: '_booting', runnerUrl: 'x', platform: 'android' }),
    );

    await expect(
      assertMobileSessionOwnership('u1', '_booting'),
    ).rejects.toMatchObject({ reason: 'no_warmup' });
  });

  it('does NOT grant access on malformed warmup JSON (defence in depth)', async () => {
    mockRedis.scanStream.mockReturnValueOnce(
      streamOfKeys(['mobile_warmup:proj-1:u1']),
    );
    mockRedis.get.mockResolvedValueOnce('{not json at all}');

    await expect(
      assertMobileSessionOwnership('u1', 'sess-1'),
    ).rejects.toMatchObject({ reason: 'no_warmup' });
  });

  it('fails closed when Redis SCAN throws — redis_error, NOT a grant', async () => {
    mockRedis.scanStream.mockReturnValueOnce(streamOfError(new Error('redis down')));

    await expect(assertMobileSessionOwnership('u1', 'sess-1')).rejects.toMatchObject({
      reason: 'redis_error',
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Cache behaviour
// ══════════════════════════════════════════════════════════════════════════

describe('assertMobileSessionOwnership — cache', () => {
  it('does not hit Redis on a second call when the first authorised', async () => {
    mockRedis.scanStream.mockReturnValueOnce(
      streamOfKeys(['mobile_warmup:proj-1:u1']),
    );
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ sessionId: 'sess-1', runnerUrl: 'x', platform: 'android' }),
    );

    await assertMobileSessionOwnership('u1', 'sess-1');
    await assertMobileSessionOwnership('u1', 'sess-1');

    // Only the first call did I/O.
    expect(mockRedis.scanStream).toHaveBeenCalledTimes(1);
    expect(mockRedis.get).toHaveBeenCalledTimes(1);
  });

  it('does not hit Redis on a second call when the first denied (negative cache)', async () => {
    mockRedis.scanStream.mockReturnValueOnce(streamOfKeys([]));

    await expect(assertMobileSessionOwnership('u1', 'sess-1')).rejects.toBeDefined();
    await expect(assertMobileSessionOwnership('u1', 'sess-1')).rejects.toBeDefined();

    expect(mockRedis.scanStream).toHaveBeenCalledTimes(1);
  });

  it('Redis error is NOT cached — retries on next call', async () => {
    mockRedis.scanStream
      .mockReturnValueOnce(streamOfError(new Error('redis down')))
      .mockReturnValueOnce(streamOfKeys(['mobile_warmup:proj-1:u1']));
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ sessionId: 'sess-1', runnerUrl: 'x', platform: 'android' }),
    );

    await expect(
      assertMobileSessionOwnership('u1', 'sess-1'),
    ).rejects.toMatchObject({ reason: 'redis_error' });
    // Second call retries and now succeeds — the error did not poison the cache.
    await expect(
      assertMobileSessionOwnership('u1', 'sess-1'),
    ).resolves.toBeUndefined();

    expect(mockRedis.scanStream).toHaveBeenCalledTimes(2);
  });
});
