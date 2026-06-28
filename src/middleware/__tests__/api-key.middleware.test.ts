/**
 * Tests for the CI/CD API-key auth middleware.
 *
 * Security boundary: this gates external CI runs. The risks it must close are
 * (a) accepting a malformed / missing / wrong key, (b) leaking through on a DB
 * error, and (c) attaching the wrong project. Each rejection path returns 401
 * (or 500 on DB error), and only an exact stored-hash match authenticates.
 *
 * supabaseAdmin + logger are mocked; crypto is real so the SHA-256 hashing and
 * timing-safe compare are exercised for real.
 */

import { requireCiApiKey, hashApiKey } from '../api-key.middleware';
import { supabaseAdmin } from '@/db/supabase';
import type { Request, Response, NextFunction } from 'express';

jest.mock('@/db/supabase', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFrom = supabaseAdmin.from as jest.Mock;

/** Build the awaitable query chain from('projects').select().not().limit(). */
function mockQuery(result: { data: unknown; error: unknown }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: jest.fn(() => chain),
    not: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(result)),
  };
  mockFrom.mockReturnValue(chain);
  return chain;
}

function mockReq(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {}, path: '/ci/run', method: 'POST' } as Request;
}

function mockRes() {
  const res = {} as Response & { status: jest.Mock; json: jest.Mock };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const VALID_KEY = 'qai_ci_abcdef1234567890';

beforeEach(() => jest.clearAllMocks());

describe('hashApiKey', () => {
  it('is a deterministic 64-char hex SHA-256', () => {
    const h = hashApiKey('qai_ci_test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey('qai_ci_test')).toBe(h); // deterministic
  });

  it('differs for different inputs', () => {
    expect(hashApiKey('a')).not.toBe(hashApiKey('b'));
  });
});

describe('requireCiApiKey — rejection paths (no DB hit)', () => {
  it('401 when the Authorization header is missing', async () => {
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('401 when the scheme is not Bearer', async () => {
    const res = mockRes();
    await requireCiApiKey(mockReq('Basic xyz'), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('401 when the key lacks the qai_ci_ prefix', async () => {
    const res = mockRes();
    await requireCiApiKey(mockReq('Bearer wrong_prefix_1234567890'), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/Invalid API key format/) }));
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('401 when the key is too short (< 20 chars)', async () => {
    const res = mockRes();
    await requireCiApiKey(mockReq('Bearer qai_ci_x'), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('requireCiApiKey — lookup paths', () => {
  it('500 when the project query errors (fails closed, no next)', async () => {
    mockQuery({ data: null, error: { message: 'db down' } });
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 when no project hash matches', async () => {
    mockQuery({
      data: [{ id: 'p1', settings: { ciApiKey: { hash: hashApiKey('qai_ci_some_other_key_value') } } }],
      error: null,
    });
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 when a project has no stored hash / non-string hash', async () => {
    mockQuery({
      data: [{ id: 'p1', settings: {} }, { id: 'p2', settings: { ciApiKey: { hash: 12345 } } }],
      error: null,
    });
    const res = mockRes();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('authenticates and attaches ciProject/ciUserId on an exact hash match', async () => {
    const project = {
      id: 'proj-1',
      user_id: 'owner-9',
      workspace_id: 'w1',
      settings: { ciApiKey: { hash: hashApiKey(VALID_KEY) } },
    };
    mockQuery({ data: [{ id: 'other', settings: { ciApiKey: { hash: hashApiKey('qai_ci_nope_nope_nope') } } }, project], error: null });

    const req = mockReq(`Bearer ${VALID_KEY}`);
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.ciProject).toEqual(project);
    expect(req.ciUserId).toBe('owner-9');
  });

  it('401 (fails closed) when the query throws unexpectedly', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('unexpected');
    });
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
