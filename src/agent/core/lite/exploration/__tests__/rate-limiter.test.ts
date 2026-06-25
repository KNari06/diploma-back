// sleep() is mocked to resolve instantly so backoff/pacing logic is tested
// without real waits. Date.now and Math.random are spied for determinism.
// Logger is globally mocked in jest.setup.ts.
jest.mock('@/services/skills/retry', () => ({ sleep: jest.fn().mockResolvedValue(undefined) }));

import { RateLimiter } from '../rate-limiter';
import { sleep } from '@/services/skills/retry';

const sleepMock = sleep as jest.Mock;

/** A fake BudgetTracker — only markDegraded is used by the limiter. */
const makeBudget = () => ({ markDegraded: jest.fn().mockResolvedValue(undefined) });

const err429 = () => Object.assign(new Error('Too Many Requests'), { status: 429 });

beforeEach(() => {
  sleepMock.mockResolvedValue(undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('RateLimiter.isRateLimitError', () => {
  it('matches a 429 status or statusCode', () => {
    expect(RateLimiter.isRateLimitError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(RateLimiter.isRateLimitError(Object.assign(new Error('x'), { statusCode: 429 }))).toBe(true);
  });

  it.each(['Rate limit exceeded', 'Too Many Requests', 'got a 429 back'])('matches the message %p', (msg) => {
    expect(RateLimiter.isRateLimitError(new Error(msg))).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(RateLimiter.isRateLimitError(new Error('connection refused'))).toBe(false);
  });
});

describe('acquireSlot — pacing', () => {
  it('does not wait on the first request and returns true', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const rl = new RateLimiter(undefined, makeBudget() as any);
    await expect(rl.acquireSlot('navigation')).resolves.toBe(true);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('waits the configured navigation delay for a back-to-back request', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000); // time frozen
    const rl = new RateLimiter({ minDelayBetweenNavigationsMs: 500 }, makeBudget() as any);
    await rl.acquireSlot('navigation'); // reserves slot until 1500
    await rl.acquireSlot('navigation'); // now=1000, must wait until 1500 → 500ms
    expect(sleepMock).toHaveBeenCalledWith(500);
  });

  it('uses the AI delay for ai slots', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(0);
    const rl = new RateLimiter({ minDelayBetweenAiCallsMs: 200 }, makeBudget() as any);
    await rl.acquireSlot('ai');
    await rl.acquireSlot('ai');
    expect(sleepMock).toHaveBeenCalledWith(200);
  });

  it('returns false without sleeping when the target is degraded', async () => {
    const rl = new RateLimiter({ maxConsecutiveRateLimits: 1 }, makeBudget() as any);
    await rl.recordFailure('target_site', err429()); // degrades immediately (max=1)
    sleepMock.mockClear();
    await expect(rl.acquireSlot('navigation')).resolves.toBe(false);
    expect(sleepMock).not.toHaveBeenCalled();
  });
});

describe('recordFailure', () => {
  it('ignores non-rate-limit errors', async () => {
    const rl = new RateLimiter(undefined, makeBudget() as any);
    const res = await rl.recordFailure('openai', new Error('network down'));
    expect(res).toEqual({ shouldRetry: false, isDegraded: false, backoffMs: 0 });
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('backs off and signals retry on the first 429', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // zero jitter
    const rl = new RateLimiter({ baseBackoffMs: 5000, maxConsecutiveRateLimits: 3 }, makeBudget() as any);
    const res = await rl.recordFailure('openai', err429());
    expect(res).toMatchObject({ shouldRetry: true, isDegraded: false, backoffMs: 5000 });
    expect(sleepMock).toHaveBeenCalledWith(5000);
  });

  it('doubles the backoff per consecutive failure', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const rl = new RateLimiter({ baseBackoffMs: 5000, maxConsecutiveRateLimits: 5 }, makeBudget() as any);
    await rl.recordFailure('openai', err429()); // 5000
    const second = await rl.recordFailure('openai', err429()); // 10000
    expect(second.backoffMs).toBe(10000);
  });

  it('caps the backoff at maxBackoffMs', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const rl = new RateLimiter({ baseBackoffMs: 5000, maxBackoffMs: 6000, maxConsecutiveRateLimits: 5 }, makeBudget() as any);
    await rl.recordFailure('openai', err429());
    const second = await rl.recordFailure('openai', err429()); // 10000 → capped 6000
    expect(second.backoffMs).toBe(6000);
  });

  it('applies ±20% jitter around the capped delay', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(1); // max positive jitter → +20%
    const rl = new RateLimiter({ baseBackoffMs: 5000, maxConsecutiveRateLimits: 3 }, makeBudget() as any);
    const res = await rl.recordFailure('openai', err429());
    expect(res.backoffMs).toBe(6000); // 5000 * 1.2
  });

  it('degrades the target and notifies the budget after maxConsecutiveRateLimits', async () => {
    const budget = makeBudget();
    const rl = new RateLimiter({ maxConsecutiveRateLimits: 2 }, budget as any);
    await rl.recordFailure('openai', err429()); // count 1
    sleepMock.mockClear();
    const res = await rl.recordFailure('openai', err429()); // count 2 → degraded
    expect(res).toEqual({ shouldRetry: false, isDegraded: true, backoffMs: 0 });
    expect(budget.markDegraded).toHaveBeenCalledWith('openai');
    expect(sleepMock).not.toHaveBeenCalled(); // returns before sleeping
    expect(rl.isDegraded('openai')).toBe(true);
  });
});

describe('recordSuccess', () => {
  it('resets the consecutive-failure count so the next 429 starts over', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const rl = new RateLimiter({ baseBackoffMs: 5000, maxConsecutiveRateLimits: 5 }, makeBudget() as any);
    await rl.recordFailure('openai', err429()); // count 1
    await rl.recordFailure('openai', err429()); // count 2
    rl.recordSuccess('openai'); // reset to 0
    const res = await rl.recordFailure('openai', err429()); // count 1 again → 5000
    expect(res.backoffMs).toBe(5000);
  });

  it('is a no-op when the target has no recorded failures', () => {
    const rl = new RateLimiter(undefined, makeBudget() as any);
    expect(() => rl.recordSuccess('openai')).not.toThrow();
  });
});

describe('isDegraded', () => {
  it('is false for a fresh target and true once degraded', async () => {
    const rl = new RateLimiter({ maxConsecutiveRateLimits: 1 }, makeBudget() as any);
    expect(rl.isDegraded('target_site')).toBe(false);
    await rl.recordFailure('target_site', err429());
    expect(rl.isDegraded('target_site')).toBe(true);
  });
});
