// The module registers a 5-minute cleanup setInterval at load. We enable fake
// timers BEFORE requiring it so that interval is faked (no leaked handle) and
// Date.now is controllable for sliding-window expiry. Logger is globally mocked.
jest.useFakeTimers();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createRateLimiter, createIpRateLimiter } = require('../rate-limiter.middleware');

import type { Request, Response, NextFunction } from 'express';

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
};

let keyCounter = 0;
/** Unique prefix per test so the shared in-memory store never cross-contaminates. */
const uniquePrefix = () => `t${keyCounter++}`;

beforeEach(() => {
  jest.setSystemTime(0);
});
afterAll(() => {
  jest.useRealTimers();
});

describe('createRateLimiter (per-user)', () => {
  it('passes through unauthenticated requests untouched', () => {
    const mw = createRateLimiter({ keyPrefix: uniquePrefix() });
    const res = makeRes();
    const next = jest.fn();
    mw({} as Request, res, next as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows up to maxRequests within the window then returns 429', () => {
    const mw = createRateLimiter({ maxRequests: 2, windowMs: 10000, keyPrefix: uniquePrefix() });
    const req = { user: { id: 'user-1' } } as Request;

    const n1 = jest.fn();
    mw(req, makeRes(), n1 as NextFunction);
    expect(n1).toHaveBeenCalled();

    const n2 = jest.fn();
    mw(req, makeRes(), n2 as NextFunction);
    expect(n2).toHaveBeenCalled();

    const res3 = makeRes();
    const n3 = jest.fn();
    mw(req, res3, n3 as NextFunction);
    expect(n3).not.toHaveBeenCalled();
    expect(res3.status).toHaveBeenCalledWith(429);
    expect(res3.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'RATE_LIMIT_EXCEEDED', retryAfter: 10 }),
    );
  });

  it('resets the counter once the window has elapsed', () => {
    const mw = createRateLimiter({ maxRequests: 1, windowMs: 10000, keyPrefix: uniquePrefix() });
    const req = { user: { id: 'user-2' } } as Request;

    mw(req, makeRes(), jest.fn() as NextFunction); // count 1
    const blocked = makeRes();
    mw(req, blocked, jest.fn() as NextFunction); // blocked
    expect(blocked.status).toHaveBeenCalledWith(429);

    jest.setSystemTime(10000); // window expired
    const after = jest.fn();
    mw(req, makeRes(), after as NextFunction);
    expect(after).toHaveBeenCalled();
  });

  it('tracks separate users independently', () => {
    const prefix = uniquePrefix();
    const mw = createRateLimiter({ maxRequests: 1, windowMs: 10000, keyPrefix: prefix });
    mw({ user: { id: 'a' } } as Request, makeRes(), jest.fn() as NextFunction); // a: count 1
    const nB = jest.fn();
    mw({ user: { id: 'b' } } as Request, makeRes(), nB as NextFunction); // b: fresh
    expect(nB).toHaveBeenCalled();
  });

  it('applies sensible defaults (2 requests / 10s)', () => {
    const mw = createRateLimiter({ keyPrefix: uniquePrefix() });
    const req = { user: { id: 'user-3' } } as Request;
    mw(req, makeRes(), jest.fn() as NextFunction);
    mw(req, makeRes(), jest.fn() as NextFunction);
    const res3 = makeRes();
    mw(req, res3, jest.fn() as NextFunction);
    expect(res3.status).toHaveBeenCalledWith(429);
  });

  it('periodically evicts entries older than 10 minutes', () => {
    const mw = createRateLimiter({ maxRequests: 1, windowMs: 1000, keyPrefix: uniquePrefix() });
    const req = { user: { id: 'stale-user' } } as Request;
    mw(req, makeRes(), jest.fn() as NextFunction); // entry created at t=0

    // Fire the 5-minute cleanup interval until past the 10-minute eviction age.
    jest.advanceTimersByTime(15 * 60 * 1000);

    // After the sweep the limiter still works (and the eviction branch ran).
    const after = jest.fn();
    mw(req, makeRes(), after as NextFunction);
    expect(after).toHaveBeenCalled();
  });
});

describe('createIpRateLimiter', () => {
  const reqFrom = (over: Partial<Request>) =>
    ({ socket: { remoteAddress: undefined }, ...over } as Request);

  it('limits by req.ip and tracks IPs separately', () => {
    const mw = createIpRateLimiter({ maxRequests: 1, windowMs: 60000, keyPrefix: uniquePrefix() });
    mw(reqFrom({ ip: '1.1.1.1' }), makeRes(), jest.fn() as NextFunction); // ip1: count 1
    const blocked = makeRes();
    mw(reqFrom({ ip: '1.1.1.1' }), blocked, jest.fn() as NextFunction);
    expect(blocked.status).toHaveBeenCalledWith(429);

    const otherIp = jest.fn();
    mw(reqFrom({ ip: '2.2.2.2' }), makeRes(), otherIp as NextFunction);
    expect(otherIp).toHaveBeenCalled();
  });

  it('falls back to socket.remoteAddress when req.ip is absent', () => {
    const mw = createIpRateLimiter({ maxRequests: 1, windowMs: 60000, keyPrefix: uniquePrefix() });
    const req = { socket: { remoteAddress: '9.9.9.9' } } as unknown as Request;
    mw(req, makeRes(), jest.fn() as NextFunction);
    const blocked = makeRes();
    mw(req, blocked, jest.fn() as NextFunction);
    expect(blocked.status).toHaveBeenCalledWith(429);
  });

  it('falls back to "unknown" when neither ip nor socket address is present', () => {
    const mw = createIpRateLimiter({ maxRequests: 1, windowMs: 60000, keyPrefix: uniquePrefix() });
    const req = { socket: {} } as unknown as Request;
    const first = jest.fn();
    mw(req, makeRes(), first as NextFunction);
    expect(first).toHaveBeenCalled();
    const blocked = makeRes();
    mw(req, blocked, jest.fn() as NextFunction);
    expect(blocked.status).toHaveBeenCalledWith(429);
  });

  it('applies sensible defaults (30 requests / 60s)', () => {
    const mw = createIpRateLimiter({ keyPrefix: uniquePrefix() });
    const req = reqFrom({ ip: '3.3.3.3' });
    for (let i = 0; i < 30; i++) mw(req, makeRes(), jest.fn() as NextFunction);
    const res31 = makeRes();
    mw(req, res31, jest.fn() as NextFunction);
    expect(res31.status).toHaveBeenCalledWith(429);
  });
});
