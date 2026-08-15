/**
 * The CI-publish limiter and mutex against a REAL Redis.
 *
 * Everything else about this change is covered by unit tests with a mocked
 * client, which cannot tell you the three things that actually carry risk here:
 *
 *   1. Whether the Lua scripts run at all, and what ioredis hands back for a
 *      Lua table (`{count, ttl}` arrives as a JS array; `HGET` results arrive
 *      as strings, not numbers).
 *   2. Whether the key genuinely ends up with a TTL in the SAME round trip —
 *      the whole reason these are scripts and not INCR-then-EXPIRE pairs. A
 *      key left without a TTL 429s that project forever, and no error fires.
 *   3. Whether a release really is owner-scoped — a mock will happily let a
 *      foreign token delete a lock.
 *
 * OPT-IN: skipped unless REDIS_TEST_URL is set. Run it with
 *   docker run -d --rm --name qait-redis-a1a-test -p 6399:6379 redis:7-alpine
 *   REDIS_TEST_URL=redis://localhost:6399 npx jest src/test/ci-publish-redis
 * Deliberately NOT the shared `qait-redis` from run-dev.sh, so it can run while
 * another clone holds the dev-stack lock.
 */

import IORedis from 'ioredis';

const TEST_REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6399';
const mockRedis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: mockRedis,
  QueueManager: { isRedisAvailable: () => true },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { consumeRateLimit, type RedisRateLimitConfig } from '@/middleware/redis-rate-limit.middleware';
import { withRedisMutex } from '@/utils/core/redis-mutex';

const LIMIT: RedisRateLimitConfig = {
  prefix: 'itest_rate:',
  windowSec: 60,
  max: 3,
  onUnavailable: 'deny',
  logTag: 'ITEST',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * OPT-IN, by setting REDIS_TEST_URL. Skipped otherwise.
 *
 * Two rejected alternatives, both worse:
 *  - connect in `beforeAll` and let it throw: a plain `npm test` then goes red
 *    for "a container you did not know you needed", and this branch already
 *    showed how much time goes into separating real failures from
 *    environmental ones.
 *  - connect, and no-op each test when unreachable: jest then reports 13
 *    PASSING tests that asserted nothing, which is worse than a red — a green
 *    that proves nothing is how a regression ships.
 * Gating on the variable is honest in both directions: silent when you have not
 * asked for it, and loudly red if you asked and Redis is not there.
 */
const describeWithRedis = process.env.REDIS_TEST_URL ? describe : describe.skip;

beforeAll(async () => {
  if (!process.env.REDIS_TEST_URL) return;
  await mockRedis.connect();
});

afterAll(async () => {
  if (!process.env.REDIS_TEST_URL) return;
  await mockRedis.quit();
});

beforeEach(async () => {
  if (!process.env.REDIS_TEST_URL) return;
  // Only ever touch this test's own namespaces.
  for (const pattern of ['itest_rate:*', 'itest_lock:*']) {
    const keys = await mockRedis.keys(pattern);
    if (keys.length) await mockRedis.del(...keys);
  }
});

describeWithRedis('rate limiter against real Redis', () => {
  it('allows exactly `max` requests in a window, then limits', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push((await consumeRateLimit(LIMIT, 'proj-a')).outcome);
    }

    expect(outcomes).toEqual(['allowed', 'allowed', 'allowed', 'limited', 'limited']);
  });

  it('sets the TTL in the SAME call as the increment', async () => {
    // The failure this guards: INCR and EXPIRE as two round trips can leave a
    // key with no expiry, which 429s that project forever with nothing erroring.
    await consumeRateLimit(LIMIT, 'proj-ttl');

    const ttl = await mockRedis.ttl('itest_rate:proj-ttl');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('reports a real remaining TTL as retryAfterSec, never a negative', async () => {
    for (let i = 0; i < 3; i++) await consumeRateLimit(LIMIT, 'proj-retry');
    const verdict = await consumeRateLimit(LIMIT, 'proj-retry');

    expect(verdict.outcome).toBe('limited');
    if (verdict.outcome === 'limited') {
      expect(verdict.retryAfterSec).toBeGreaterThan(0);
      expect(verdict.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });

  it('counts each project independently', async () => {
    for (let i = 0; i < 4; i++) await consumeRateLimit(LIMIT, 'proj-noisy');

    expect((await consumeRateLimit(LIMIT, 'proj-quiet')).outcome).toBe('allowed');
  });

  it('does not extend the window on later requests in it', async () => {
    await consumeRateLimit(LIMIT, 'proj-window');
    const first = await mockRedis.ttl('itest_rate:proj-window');
    await sleep(1100);
    await consumeRateLimit(LIMIT, 'proj-window');
    const second = await mockRedis.ttl('itest_rate:proj-window');

    // A fixed window: the expiry is anchored on the FIRST request, so the TTL
    // must be counting down, not resetting.
    expect(second).toBeLessThan(first);
  });
});

describeWithRedis('mutex against real Redis', () => {
  const opts = { key: 'itest_lock:proj-1', ttlSec: 30, logTag: 'ITEST' };

  it('serialises two real contenders — the second waits, then proceeds', async () => {
    const order: string[] = [];

    const slow = withRedisMutex(opts, async () => {
      order.push('A:start');
      await sleep(300);
      order.push('A:end');
      return 'A';
    });
    // Give A a moment to take the lock, then start B with a wait window.
    await sleep(50);
    const waiter = withRedisMutex({ ...opts, waitMs: 5000, pollMs: 25 }, async () => {
      order.push('B:start');
      return 'B';
    });

    const [a, b] = await Promise.all([slow, waiter]);

    expect(a).toEqual({ acquired: true, value: 'A' });
    expect(b).toEqual({ acquired: true, value: 'B' });
    // The critical section never overlapped.
    expect(order).toEqual(['A:start', 'A:end', 'B:start']);
  });

  it('rejects immediately, with the holder\'s real TTL, when no wait is asked for', async () => {
    await mockRedis.set(opts.key, 'someone-else', 'EX', 25);

    const result = await withRedisMutex(opts, async () => 'should not run');

    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.retryAfterSec).toBeGreaterThan(20);
      expect(result.retryAfterSec).toBeLessThanOrEqual(25);
    }
  });

  it('actually frees the key when the body finishes', async () => {
    await withRedisMutex(opts, async () => 'done');

    expect(await mockRedis.exists(opts.key)).toBe(0);
  });

  it('frees the key when the body throws', async () => {
    await expect(
      withRedisMutex(opts, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await mockRedis.exists(opts.key)).toBe(0);
  });

  it('will NOT delete a lock it does not own', async () => {
    // The cross-release this replaced: holder A outlives its TTL, B acquires,
    // A's release then frees B's lock and two bodies run at once.
    let observedDuringBody = '';
    await withRedisMutex(opts, async () => {
      // Simulate A's lock expiring and B taking the key mid-body.
      await mockRedis.set(opts.key, 'B-token', 'EX', 30);
      observedDuringBody = (await mockRedis.get(opts.key)) ?? '';
    });

    expect(observedDuringBody).toBe('B-token');
    // A's release must have been a no-op — B still holds it.
    expect(await mockRedis.get(opts.key)).toBe('B-token');
    await mockRedis.del(opts.key);
  });
});
