/**
 * Tests for withResourceMutex — per-resource serialization for heal/refresh.
 *
 * The bug it prevents: two parallel tests whose shared login session dies at
 * the same instant each trigger a recipe replay → two concurrent logins → app
 * rate-limit or state clobber. So the contract under test is: same resourceId
 * runs STRICTLY one-at-a-time (FIFO), different resourceIds run concurrently,
 * and a thrown critical section neither blocks nor poisons the next caller.
 */

import { withResourceMutex } from '../resource-mutex';

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('withResourceMutex', () => {
  it('runs the critical section and returns its value', async () => {
    await expect(withResourceMutex('r', async () => 42)).resolves.toBe(42);
  });

  it('serializes two concurrent calls for the SAME resourceId (FIFO, no overlap)', async () => {
    const events: string[] = [];
    const gate1 = deferred();

    const p1 = withResourceMutex('same', async () => {
      events.push('fn1:start');
      await gate1.promise;
      events.push('fn1:end');
      return 1;
    });
    const p2 = withResourceMutex('same', async () => {
      events.push('fn2:start');
      return 2;
    });

    await flush();
    // fn2 must NOT have started while fn1 holds the lock
    expect(events).toEqual(['fn1:start']);

    gate1.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect([r1, r2]).toEqual([1, 2]);
    expect(events).toEqual(['fn1:start', 'fn1:end', 'fn2:start']);
  });

  it('runs DIFFERENT resourceIds concurrently (no cross-resource blocking)', async () => {
    const events: string[] = [];
    const gateA = deferred();

    const pA = withResourceMutex('A', async () => {
      events.push('A:start');
      await gateA.promise;
      events.push('A:end');
    });
    const pB = withResourceMutex('B', async () => {
      events.push('B:start');
      return 'b';
    });

    await flush();
    // B is not blocked by A's still-held lock
    expect(events).toContain('A:start');
    expect(events).toContain('B:start');

    gateA.resolve();
    await Promise.all([pA, pB]);
  });

  it('propagates an error from the critical section to its caller', async () => {
    await expect(
      withResourceMutex('err', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('a thrown section does not block or poison the next caller', async () => {
    const events: string[] = [];
    const gate1 = deferred();

    const p1 = withResourceMutex('chain', async () => {
      events.push('fn1:start');
      await gate1.promise;
      throw new Error('fn1 failed');
    });
    const p2 = withResourceMutex('chain', async () => {
      events.push('fn2:start');
      return 'recovered';
    });

    await flush();
    expect(events).toEqual(['fn1:start']); // fn2 waits even though fn1 will throw

    gate1.resolve();
    await expect(p1).rejects.toThrow('fn1 failed');
    await expect(p2).resolves.toBe('recovered');
    expect(events).toEqual(['fn1:start', 'fn2:start']);
  });

  it('a later call for the same id after the queue drains starts immediately', async () => {
    await withResourceMutex('drain', async () => 'first');
    // Chain should be cleared; a fresh call runs without waiting on a stale promise.
    const order: string[] = [];
    await withResourceMutex('drain', async () => {
      order.push('second');
    });
    expect(order).toEqual(['second']);
  });
});
