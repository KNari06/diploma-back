/**
 * Tests for the CI/CD API-key auth middleware.
 *
 * Security boundary: this gates external CI runs. The risks it must close are
 * (a) accepting a malformed / missing / wrong key, (b) leaking through on a DB
 * error, (c) attaching the wrong project, and (d) honouring a key whose owning
 * account is soft-deleted or un-approved — the two gates a JWT caller gets from
 * `requireAuth` + `requireApproved` that a CI caller historically never did.
 *
 * The `db/` sublayer is the mock boundary (not `supabaseAdmin` — see
 * .claude/rules/testing.md); crypto is real, so SHA-256 hashing is exercised
 * for real.
 */

import { requireCiApiKey, hashApiKey } from '../api-key.middleware';
import {
  CiKeyLookupError,
  findProjectByCiKeyHash,
  getCiOwnerAuthState,
} from '@/services/mobile/db/ci-auth.db';
import type { Request, Response, NextFunction } from 'express';

jest.mock('@/services/mobile/db/ci-auth.db', () => {
  class CiKeyLookupError extends Error {}
  return {
    CiKeyLookupError,
    findProjectByCiKeyHash: jest.fn(),
    getCiOwnerAuthState: jest.fn(),
  };
});
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFind = findProjectByCiKeyHash as jest.Mock;
const mockOwner = getCiOwnerAuthState as jest.Mock;

function mockReq(authorization?: string): Request {
  return {
    headers: authorization ? { authorization } : {},
    path: '/run',
    method: 'POST',
    ip: '10.0.0.1',
  } as Request;
}

function mockRes() {
  const res = {} as Response & { status: jest.Mock; json: jest.Mock };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const VALID_KEY = 'qai_ci_abcdef1234567890';
const PROJECT = {
  id: 'proj-1',
  user_id: 'owner-9',
  workspace_id: 'w1',
  settings: { ciApiKey: { hash: 'stored' } },
};
const APPROVED = { ok: true, owner: { deletedAt: null, status: 'approved' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockOwner.mockResolvedValue(APPROVED);
});

describe('hashApiKey', () => {
  it('is a deterministic 64-char hex SHA-256', () => {
    const h = hashApiKey('qai_ci_test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey('qai_ci_test')).toBe(h);
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
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('401 when the scheme is not Bearer', async () => {
    const res = mockRes();
    await requireCiApiKey(mockReq('Basic xyz'), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('401 when the key lacks the qai_ci_ prefix', async () => {
    const res = mockRes();
    await requireCiApiKey(mockReq('Bearer wrong_prefix_1234567890'), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/Invalid API key format/) }),
    );
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('401 when the key is too short (< 20 chars)', async () => {
    const res = mockRes();
    await requireCiApiKey(mockReq('Bearer qai_ci_x'), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockFind).not.toHaveBeenCalled();
  });
});

describe('requireCiApiKey — lookup paths', () => {
  it('looks the key up by its SHA-256 hash, never by the raw key', async () => {
    mockFind.mockResolvedValue(PROJECT);
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), mockRes(), jest.fn());
    expect(mockFind).toHaveBeenCalledWith(hashApiKey(VALID_KEY));
    expect(mockFind).not.toHaveBeenCalledWith(VALID_KEY);
  });

  it('does not depend on how many CI-keyed projects exist (single indexed lookup)', async () => {
    mockFind.mockResolvedValue(PROJECT);
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), mockRes(), jest.fn());
    // Regression for the old ".limit(100) then scan in Node" lookup, which
    // 401'd valid keys once a customer had >100 CI-keyed projects.
    expect(mockFind).toHaveBeenCalledTimes(1);
  });

  it('500 when the key lookup errors (fails closed, no next)', async () => {
    mockFind.mockRejectedValue(new CiKeyLookupError('db down'));
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 when no project hash matches', async () => {
    mockFind.mockResolvedValue(null);
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('authenticates and attaches ciProject/ciUserId on a hash match', async () => {
    mockFind.mockResolvedValue(PROJECT);
    const req = mockReq(`Bearer ${VALID_KEY}`);
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(req, res, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.ciProject).toEqual(PROJECT);
    expect(req.ciUserId).toBe('owner-9');
  });

  it('401 (fails closed) when the lookup throws unexpectedly', async () => {
    mockFind.mockRejectedValue(new Error('unexpected'));
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireCiApiKey — owning-account gates', () => {
  beforeEach(() => mockFind.mockResolvedValue(PROJECT));

  it('401 ACCOUNT_DELETED when the owning account is soft-deleted', async () => {
    mockOwner.mockResolvedValue({
      ok: true,
      owner: { deletedAt: '2026-07-01T00:00:00Z', status: 'approved' },
    });
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ACCOUNT_DELETED' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('401 OWNER_NOT_APPROVED when the owning account is not approved', async () => {
    mockOwner.mockResolvedValue({
      ok: true,
      owner: { deletedAt: null, status: 'pending_approval' },
    });
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'OWNER_NOT_APPROVED' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('401 OWNER_NOT_FOUND when the owning account row is gone', async () => {
    mockOwner.mockResolvedValue({ ok: true, owner: null });
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(mockReq(`Bearer ${VALID_KEY}`), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'OWNER_NOT_FOUND' }),
    );
  });

  it('fails OPEN when the owner lookup itself is unavailable', async () => {
    // A Supabase blip must not 401 every customer's pipeline — same trade-off
    // requireAuth makes for its deleted_at check.
    mockOwner.mockResolvedValue({ ok: false });
    const req = mockReq(`Bearer ${VALID_KEY}`);
    const res = mockRes();
    const next = jest.fn();
    await requireCiApiKey(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.ciProject).toEqual(PROJECT);
  });
});
