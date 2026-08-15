/**
 * The release contract is the point of this module, so that is what is locked
 * here: the lock is freed on EVERY exit path, and only ever by its own holder.
 *
 * Why it matters: `/ci/run`'s appUrl branch used a hand-rolled
 * `SET NX EX` + `del` and released it in a `catch`, so three early `return`s
 * inside the same `try` leaked the lock for its full 300s TTL. A `finally` in
 * one place is what makes that class of bug unrepresentable.
 */

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: { set: jest.fn(), eval: jest.fn(), ttl: jest.fn() },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { redisConnection } from '@/config/infrastructure/queues';
import { RedisMutexUnavailableError, withRedisMutex } from '../redis-mutex';

const setMock = redisConnection.set as unknown as jest.Mock;
const evalMock = redisConnection.eval as unknown as jest.Mock;
const ttlMock = redisConnection.ttl as unknown as jest.Mock;

const OPTS = { key: 'test:lock', ttlSec: 60, logTag: 'TEST' };

beforeEach(() => {
  jest.clearAllMocks();
  setMock.mockResolvedValue('OK');
  evalMock.mockResolvedValue(1);
  ttlMock.mockResolvedValue(42);
});

describe('withRedisMutex', () => {
  it('runs the body and returns its value when the lock is free', async () => {
    const result = await withRedisMutex(OPTS, async () => 'done');

    expect(result).toEqual({ acquired: true, value: 'done' });
    expect(setMock).toHaveBeenCalledWith('test:lock', expect.any(String), 'EX', 60, 'NX');
  });

  it('releases the lock after a SUCCESSFUL body — the bug that started this', async () => {
    await withRedisMutex(OPTS, async () => 'done');

    expect(evalMock).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when the body returns early with a value', async () => {
    await withRedisMutex(OPTS, async () => ({ kind: 'download_failed' as const }));

    expect(evalMock).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when the body throws, and rethrows', async () => {
    await expect(
      withRedisMutex(OPTS, async () => {
        throw new Error('storage unreachable');
      }),
    ).rejects.toThrow('storage unreachable');

    expect(evalMock).toHaveBeenCalledTimes(1);
  });

  it('releases with a compare-and-delete against its own token, never a bare del', async () => {
    await withRedisMutex(OPTS, async () => null);

    const [script, numKeys, key, token] = evalMock.mock.calls[0];
    expect(script).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
    expect(numKeys).toBe(1);
    expect(key).toBe('test:lock');
    // The token must be the one this holder wrote — otherwise a holder that
    // outlived its TTL would delete the NEXT holder's lock.
    expect(token).toBe(setMock.mock.calls[0][1]);
  });

  it('hands out a distinct token per acquisition', async () => {
    await withRedisMutex(OPTS, async () => null);
    await withRedisMutex(OPTS, async () => null);

    expect(setMock.mock.calls[0][1]).not.toBe(setMock.mock.calls[1][1]);
  });

  it('does not run the body when the lock is busy and no wait was asked for', async () => {
    setMock.mockResolvedValue(null);
    const body = jest.fn();

    const result = await withRedisMutex(OPTS, body);

    expect(result).toEqual({ acquired: false, retryAfterSec: 42 });
    expect(body).not.toHaveBeenCalled();
    // Nothing was acquired, so nothing may be released.
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('waits for a busy lock and proceeds once it frees up', async () => {
    setMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('OK');
    const body = jest.fn().mockResolvedValue('published');

    const result = await withRedisMutex(
      { ...OPTS, waitMs: 1000, pollMs: 1 },
      body,
    );

    expect(result).toEqual({ acquired: true, value: 'published' });
    expect(body).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('gives up after the wait window rather than blocking forever', async () => {
    setMock.mockResolvedValue(null);
    const body = jest.fn();

    const result = await withRedisMutex({ ...OPTS, waitMs: 20, pollMs: 5 }, body);

    expect(result).toEqual({ acquired: false, retryAfterSec: 42 });
    expect(body).not.toHaveBeenCalled();
  });

  it('reports the HOLDER\'s remaining TTL, not the caller\'s own wait window', async () => {
    // Quoting our wait window would tell a client to sleep 90s even when the
    // holder is one second from releasing.
    setMock.mockResolvedValue(null);
    ttlMock.mockResolvedValue(3);

    const result = await withRedisMutex({ ...OPTS, waitMs: 10, pollMs: 5 }, jest.fn());

    expect(result).toEqual({ acquired: false, retryAfterSec: 3 });
  });

  it.each([
    ['no expiry', -1],
    ['key already gone', -2],
  ])('falls back to a poll interval when TTL reads %s', async (_label, ttl) => {
    setMock.mockResolvedValue(null);
    ttlMock.mockResolvedValue(ttl);

    const result = await withRedisMutex({ ...OPTS, waitMs: 10, pollMs: 2000 }, jest.fn());

    expect(result).toEqual({ acquired: false, retryAfterSec: 2 });
  });

  it('still answers 429-able when the TTL read itself fails', async () => {
    setMock.mockResolvedValue(null);
    ttlMock.mockRejectedValue(new Error('redis gone'));

    const result = await withRedisMutex({ ...OPTS, waitMs: 10, pollMs: 1000 }, jest.fn());

    expect(result).toEqual({ acquired: false, retryAfterSec: 1 });
  });

  it('tags an ACQUIRE failure so callers can answer 503 for it specifically', async () => {
    setMock.mockRejectedValue(new Error('READONLY You can\'t write against a replica'));

    await expect(withRedisMutex(OPTS, async () => 'never')).rejects.toBeInstanceOf(
      RedisMutexUnavailableError,
    );
  });

  it('does NOT tag an error thrown by the body — that is the caller\'s real error', async () => {
    // Otherwise a dead database inside the critical section gets reported to
    // the customer as "the mutex is briefly unavailable, retry shortly".
    const bodyError = new Error('supabase unreachable');

    await expect(withRedisMutex(OPTS, async () => { throw bodyError; })).rejects.toBe(bodyError);
  });

  it('still returns the body result when releasing fails — the TTL is the backstop', async () => {
    evalMock.mockRejectedValue(new Error('redis gone'));

    const result = await withRedisMutex(OPTS, async () => 'done');

    expect(result).toEqual({ acquired: true, value: 'done' });
  });
});
