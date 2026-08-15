/**
 * Locked here:
 *   - Counting is ONE atomic call, so a key can never be left without a TTL
 *     (which would 429 that project forever, with nothing erroring).
 *   - `Retry-After` comes from the key's real TTL, and is never negative.
 *   - The fail policy is explicit per endpoint: `allow` for the harmless
 *     read-only one, `deny` for the one that mints storage-write URLs.
 *   - Unavailability is detected BEFORE issuing a command — ioredis buffers
 *     commands while disconnected, so a bare try/catch would stall first.
 */

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: { eval: jest.fn() },
  QueueManager: { isRedisAvailable: jest.fn() },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { QueueManager, redisConnection } from '@/config/infrastructure/queues';
import {
  consumeRateLimit,
  createRedisRateLimiter,
  type RedisRateLimitConfig,
} from '../redis-rate-limit.middleware';

const evalMock = redisConnection.eval as unknown as jest.Mock;
const availableMock = QueueManager.isRedisAvailable as unknown as jest.Mock;

const DENY: RedisRateLimitConfig = {
  prefix: 'ci_publish_rate:',
  windowSec: 3600,
  max: 30,
  onUnavailable: 'deny',
  logTag: 'TEST',
};
const ALLOW: RedisRateLimitConfig = { ...DENY, onUnavailable: 'allow' };

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  availableMock.mockReturnValue(true);
  evalMock.mockResolvedValue([1, 3600]);
});

describe('consumeRateLimit', () => {
  it('allows a request inside the window', async () => {
    evalMock.mockResolvedValue([7, 3200]);

    expect(await consumeRateLimit(DENY, 'proj-1')).toEqual({ outcome: 'allowed' });
  });

  it('allows the request that exactly reaches the limit', async () => {
    evalMock.mockResolvedValue([30, 100]);

    expect(await consumeRateLimit(DENY, 'proj-1')).toEqual({ outcome: 'allowed' });
  });

  it('limits the request after the limit, reporting the real remaining TTL', async () => {
    evalMock.mockResolvedValue([31, 1234]);

    expect(await consumeRateLimit(DENY, 'proj-1')).toEqual({
      outcome: 'limited',
      retryAfterSec: 1234,
    });
  });

  it('increments and expires in a single atomic call, keyed by prefix + identity', async () => {
    await consumeRateLimit(DENY, 'proj-1');

    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, windowArg] = evalMock.mock.calls[0];
    expect(script).toContain("redis.call('incr', KEYS[1])");
    expect(script).toContain("redis.call('expire', KEYS[1], ARGV[1])");
    expect(numKeys).toBe(1);
    expect(key).toBe('ci_publish_rate:proj-1');
    expect(windowArg).toBe('3600');
  });

  it.each([
    ['no expiry set', -1],
    ['key already gone', -2],
  ])('falls back to a full window when TTL reads %s', async (_label, ttl) => {
    evalMock.mockResolvedValue([31, ttl]);

    expect(await consumeRateLimit(DENY, 'proj-1')).toEqual({
      outcome: 'limited',
      retryAfterSec: 3600,
    });
  });

  it('reports unavailable WITHOUT issuing a command when Redis is disconnected', async () => {
    availableMock.mockReturnValue(false);

    expect(await consumeRateLimit(DENY, 'proj-1')).toEqual({ outcome: 'unavailable' });
    // The whole point: ioredis would have queued this offline and stalled.
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('reports unavailable when the command itself errors', async () => {
    evalMock.mockRejectedValue(new Error('READONLY'));

    expect(await consumeRateLimit(DENY, 'proj-1')).toEqual({ outcome: 'unavailable' });
  });
});

describe('createRedisRateLimiter', () => {
  const middleware = (config: RedisRateLimitConfig) =>
    createRedisRateLimiter({
      ...config,
      keyOf: () => 'proj-1',
      limitMessage: 'too many',
      unavailableMessage: 'try later',
    });

  it('calls next() when under the limit', async () => {
    const res = makeRes();
    const next = jest.fn();

    await middleware(DENY)({} as any, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('429s with Retry-After in BOTH the header and the body', async () => {
    evalMock.mockResolvedValue([31, 900]);
    const res = makeRes();
    const next = jest.fn();

    await middleware(DENY)({} as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '900');
    // The body copy is not redundant: qait-publish.sh parses JSON with jq and
    // never captures response headers.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RATE_LIMITED', retryAfterSeconds: 900 }),
    );
  });

  it('503s rather than proceeding when a deny-policy limiter cannot reach Redis', async () => {
    availableMock.mockReturnValue(false);
    const res = makeRes();
    const next = jest.fn();

    await middleware(DENY)({} as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RATE_LIMITER_UNAVAILABLE' }),
    );
  });

  it('proceeds when an allow-policy limiter cannot reach Redis', async () => {
    availableMock.mockReturnValue(false);
    const res = makeRes();
    const next = jest.fn();

    await middleware(ALLOW)({} as any, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
