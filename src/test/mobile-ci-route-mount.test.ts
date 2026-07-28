/**
 * Regression coverage for the CI/CD mount — the gap that let an entire feature
 * ship unreachable.
 *
 * `POST /api/v1/mobile/ci/run` shipped inside `mobile.route.ts`, which is
 * mounted behind `requireAuth, requireApproved`. A `qai_ci_<hex>` key is not a
 * Supabase JWT, so `requireAuth` answered 401 before `requireCiApiKey` ever
 * ran — the endpoint had never once worked with a CI key, and no test noticed
 * because every test called the controller directly.
 *
 * So these tests go over real HTTP through a real Express mount stack. The
 * `/mobile/ci` router is the REAL one (`ci.route.ts` + `requireCiApiKey`); the
 * authed `/mobile` router is a stand-in that reproduces `requireAuth`'s
 * behaviour (401 on a non-JWT bearer), because mounting the real one would pull
 * in the whole service graph. What is under test is the MOUNT ORDER and the
 * terminal 404 — not the controllers, which are stubbed.
 *
 * The last test asserts the ordering directly against `src/index.ts`'s source,
 * so reordering the real mounts fails here even though the app itself is never
 * booted.
 */

import express from 'express';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';

// ── Module mocks ────────────────────────────────────────────────────────────
jest.mock('@/api/mobile/ci.controller', () => ({
  triggerCiRun: jest.fn(async (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ success: true, handler: 'triggerCiRun' }),
  ),
  getCiRunStatus: jest.fn(async (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ success: true, handler: 'getCiRunStatus' }),
  ),
}));

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

import ciRoutes from '@/api/mobile/ci.route';
import {
  findProjectByCiKeyHash,
  getCiOwnerAuthState,
} from '@/services/mobile/db/ci-auth.db';

const mockFind = findProjectByCiKeyHash as jest.Mock;
const mockOwner = getCiOwnerAuthState as jest.Mock;

const CI_KEY = 'qai_ci_abcdef1234567890';
const PROJECT = {
  id: 'proj-1',
  user_id: 'owner-9',
  workspace_id: 'w1',
  settings: { ciApiKey: { hash: 'stored' } },
};

/** Stand-in for `requireAuth`: rejects anything that is not a Supabase JWT. */
function requireAuthStub(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token || token.startsWith('qai_ci_')) {
    res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
    return;
  }
  next();
}

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Mount order mirrors src/index.ts — the CI router FIRST.
  app.use('/api/v1/mobile/ci', ciRoutes);
  app.use(
    '/api/v1/mobile',
    requireAuthStub,
    express
      .Router()
      .get('/projects/:id/ci-key', (_req, res) =>
        res.json({ success: true, handler: 'getCiKeyStatus' }),
      ),
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockOwner.mockResolvedValue({ ok: true, owner: { deletedAt: null, status: 'approved' } });
});

describe('CI mount reachability', () => {
  it('lets a CI API key reach POST /mobile/ci/run (regression: used to 401 at requireAuth)', async () => {
    mockFind.mockResolvedValue(PROJECT);

    const res = await fetch(`${baseUrl}/api/v1/mobile/ci/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CI_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'plan-1' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, handler: 'triggerCiRun' });
  });

  it('lets a CI API key reach GET /mobile/ci/run/:runId/status', async () => {
    mockFind.mockResolvedValue(PROJECT);

    const res = await fetch(`${baseUrl}/api/v1/mobile/ci/run/run-7/status`, {
      headers: { authorization: `Bearer ${CI_KEY}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, handler: 'getCiRunStatus' });
  });

  it('still rejects an unknown CI key with 401 from requireCiApiKey', async () => {
    mockFind.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/v1/mobile/ci/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CI_KEY}`, 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ error: expect.stringMatching(/Invalid API key/) }),
    );
  });
});

describe('CI mount isolation', () => {
  it('answers 404, not a baffling 401, for an unmatched /mobile/ci/* path', async () => {
    mockFind.mockResolvedValue(PROJECT);

    const res = await fetch(`${baseUrl}/api/v1/mobile/ci/nope`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CI_KEY}`, 'content-type': 'application/json' },
      body: '{}',
    });

    // Without the terminal 404 this falls through to the authed mount and
    // returns "401 No token provided" — which reads as "your key is wrong"
    // in a customer's CI log.
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({ error: 'Not found' }),
    );
  });

  it('does not swallow the authed /mobile/projects/:id/ci-key route', async () => {
    // Express matches a mount only at a segment boundary, so /mobile/ci must
    // not capture /mobile/projects/... — the JWT route still works.
    const res = await fetch(`${baseUrl}/api/v1/mobile/projects/p1/ci-key`, {
      headers: { authorization: 'Bearer some.jwt.token' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, handler: 'getCiKeyStatus' });
  });

  it('leaves the authed /mobile mount rejecting a CI key, as before', async () => {
    const res = await fetch(`${baseUrl}/api/v1/mobile/projects/p1/ci-key`, {
      headers: { authorization: `Bearer ${CI_KEY}` },
    });

    expect(res.status).toBe(401);
  });
});

describe('src/index.ts mount order', () => {
  it('mounts /mobile/ci BEFORE the JWT-gated /mobile mount', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'index.ts'),
      'utf8',
    );

    const ciMount = source.indexOf('/mobile/ci`, ciRoutes)');
    const authedMount = source.indexOf('/mobile`, logWarmupOutcome');

    expect(ciMount).toBeGreaterThan(-1);
    expect(authedMount).toBeGreaterThan(-1);
    // Express matches mounts in registration order: if this flips, every CI
    // request 401s at requireAuth again and no other test would notice.
    expect(ciMount).toBeLessThan(authedMount);
  });
});
