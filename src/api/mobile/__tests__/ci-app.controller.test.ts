/**
 * Tests for the three CI app endpoints' HTTP contract.
 *
 * Locked here:
 *   - `pruneOldBuilds` IS fired with the RESOLVED lane; `autoBootAndInstall` is
 *     NOT (there is no emulator at publish time).
 *   - Build identity (commitSha OR versionName/versionCode) is required.
 *   - A duplicate commit is a 409, not a 500.
 *   - `whoami` returns projectId ONLY — its output lands in CI logs, which are
 *     public for OSS repos.
 *   - Both write endpoints are paid-gated, and the publish quota is consumed
 *     ONLY after the auth and plan gates.
 *   - `upload-url` takes NO mutex (it mints a signed URL and nothing more), so
 *     parallel matrix lanes do not block each other. `finalize` takes two:
 *     per-object (reject) and per-project (wait).
 *
 * The limiter and the mutex have their own unit tests — see
 * `middleware/__tests__/redis-rate-limit.middleware.test.ts` and
 * `utils/core/__tests__/redis-mutex.test.ts`. Here they are stubbed so these
 * tests speak about the CONTRACT, not about Redis.
 */

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: { set: jest.fn(), del: jest.fn(), incr: jest.fn(), expire: jest.fn(), get: jest.fn(), eval: jest.fn() },
  QueueManager: { isRedisAvailable: jest.fn().mockReturnValue(true) },
}));

jest.mock('@/middleware/redis-rate-limit.middleware', () => ({
  ...jest.requireActual('@/middleware/redis-rate-limit.middleware'),
  consumeRateLimit: jest.fn(),
}));

jest.mock('@/utils/core/redis-mutex', () => ({
  ...jest.requireActual('@/utils/core/redis-mutex'),
  withRedisMutex: jest.fn(),
}));

jest.mock('@/services/core/plan-access.service', () => ({ isPaidUser: jest.fn() }));

jest.mock('@/services/mobile/ci-app-publish.service', () => ({
  createCiUploadUrl: jest.fn(),
  finalizeCiUpload: jest.fn(),
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: { pruneOldBuilds: jest.fn().mockResolvedValue(undefined) },
  trimMobileBuildField: (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
}));

jest.mock('../session.controller', () => ({
  autoBootAndInstall: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { consumeRateLimit } from '@/middleware/redis-rate-limit.middleware';
import { isPaidUser } from '@/services/core/plan-access.service';
import * as CiAppPublishService from '@/services/mobile/ci-app-publish.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { RedisMutexUnavailableError, withRedisMutex } from '@/utils/core/redis-mutex';
import { autoBootAndInstall } from '../session.controller';
import { ciWhoami, createCiAppUploadUrl, finalizeCiAppUpload } from '../ci-app.controller';

const consumeMock = consumeRateLimit as jest.Mock;
const mutexMock = withRedisMutex as jest.Mock;
const isPaidUserMock = isPaidUser as jest.Mock;
const createUrlMock = CiAppPublishService.createCiUploadUrl as jest.Mock;
const finalizeMock = CiAppPublishService.finalizeCiUpload as jest.Mock;
const pruneMock = MobileAppStorageService.pruneOldBuilds as jest.Mock;
const autoBootMock = autoBootAndInstall as jest.Mock;

const PROJECT = { id: 'proj-1', user_id: 'owner-9', workspace_id: 'ws-1', settings: {} };
const STORAGE_PATH = 'mobile-apps/ws-1/proj-1/android/app_123.apk';

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq(body: Record<string, unknown> = {}) {
  return { ciProject: PROJECT, ciUserId: 'owner-9', body, ip: '10.0.0.1' } as any;
}

/** Let the fire-and-forget prune promise settle. */
const flush = () => new Promise((r) => setImmediate(r));

/** Real mutex semantics, minus Redis: run the body, report acquired. */
const passthroughMutex = async (_opts: unknown, fn: () => Promise<unknown>) => ({
  acquired: true,
  value: await fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  isPaidUserMock.mockResolvedValue(true);
  consumeMock.mockResolvedValue({ outcome: 'allowed' });
  mutexMock.mockImplementation(passthroughMutex);
  pruneMock.mockResolvedValue(undefined);
  createUrlMock.mockResolvedValue({
    uploadUrl: 'https://storage.example/put',
    storagePath: STORAGE_PATH,
    requiredHeaders: { 'x-ms-blob-type': 'BlockBlob' },
    variant: 'Production',
  });
  finalizeMock.mockResolvedValue({
    build: { id: 'build-1' },
    mobileApp: { storagePath: STORAGE_PATH },
    variant: 'Production',
    platform: 'android',
  });
});

describe('POST /ci/app/upload-url', () => {
  it('returns the upload target with the provider headers the PUT must carry', async () => {
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        uploadUrl: 'https://storage.example/put',
        storagePath: STORAGE_PATH,
        requiredHeaders: { 'x-ms-blob-type': 'BlockBlob' },
      }),
    );
  });

  it('takes NO mutex — parallel matrix lanes must not block each other', async () => {
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), res);

    expect(mutexMock).not.toHaveBeenCalled();
  });

  it('does NOT lock the project out after a successful publish', async () => {
    // The original defect: the success path held a 300s lock, so an immediate
    // retry 429'd. Nothing here may hold anything past the response.
    const first = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), first);
    const second = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), second);

    expect(first.status).not.toHaveBeenCalledWith(429);
    expect(second.status).not.toHaveBeenCalledWith(429);
    expect(createUrlMock).toHaveBeenCalledTimes(2);
  });

  it('403s a free-plan account before consuming a publish slot', async () => {
    isPaidUserMock.mockResolvedValue(false);
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(consumeMock).not.toHaveBeenCalled();
    expect(createUrlMock).not.toHaveBeenCalled();
  });

  it('400s when filename is missing', async () => {
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createUrlMock).not.toHaveBeenCalled();
  });

  it('429s with a Retry-After once the hourly publish quota is spent', async () => {
    consumeMock.mockResolvedValue({ outcome: 'limited', retryAfterSec: 1800 });
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '1800');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RATE_LIMITED', retryAfterSeconds: 1800 }),
    );
    expect(createUrlMock).not.toHaveBeenCalled();
  });

  it('503s rather than minting a storage-write URL it cannot meter', async () => {
    consumeMock.mockResolvedValue({ outcome: 'unavailable' });
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(createUrlMock).not.toHaveBeenCalled();
  });

  it('never lets the caller choose the project', async () => {
    const res = makeRes();
    const req = makeReq({ filename: 'app.apk', projectId: 'someone-elses-project' });
    await createCiAppUploadUrl(req, res);

    expect(createUrlMock).toHaveBeenCalledWith(expect.objectContaining({ project: PROJECT }));
  });
});

describe('POST /ci/app/finalize', () => {
  const okBody = { storagePath: STORAGE_PATH, commitSha: 'abc123' };

  it('responds 201 with the build, then prunes the lane the build landed in', async () => {
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);
    await flush();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, build: { id: 'build-1' }, variant: 'Production' }),
    );
    expect(pruneMock).toHaveBeenCalledWith('proj-1', 'android', 'Production');
  });

  it('runs under a per-object mutex that rejects, inside a per-project one that waits', async () => {
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    const [objectOpts] = mutexMock.mock.calls[0];
    const [projectOpts] = mutexMock.mock.calls[1];

    // Per storagePath: a resubmission of the SAME upload is a duplicate.
    expect(objectOpts.key).toBe(`ci_apk_finalize:${STORAGE_PATH}`);
    expect(objectOpts.waitMs ?? 0).toBe(0);

    // Per project: serialises the settings read-modify-write, and WAITS so
    // parallel lanes of one pipeline queue instead of failing.
    expect(projectOpts.key).toBe('ci_publish_lock:proj-1');
    expect(projectOpts.waitMs).toBeGreaterThan(0);
  });

  it('does not consume a second publish slot — the upload already paid for it', async () => {
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('does NOT auto-boot an emulator — there is no device at publish time', async () => {
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);
    await flush();

    expect(autoBootMock).not.toHaveBeenCalled();
  });

  it('400s when no build identity is supplied at all', async () => {
    const res = makeRes();
    await finalizeCiAppUpload(makeReq({ storagePath: STORAGE_PATH }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VERSION_IDENTITY_REQUIRED' }),
    );
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['commitSha alone', { storagePath: STORAGE_PATH, commitSha: 'abc123' }],
    ['versionName alone', { storagePath: STORAGE_PATH, versionName: '1.2.3' }],
    ['versionCode alone', { storagePath: STORAGE_PATH, versionCode: 42 }],
  ])('accepts %s as build identity', async (_label, body) => {
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(body), res);
    await flush();

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('409s a re-published commit instead of surfacing a database error', async () => {
    finalizeMock.mockResolvedValue({ kind: 'build_record_failed', code: '23505' });
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DUPLICATE_COMMIT' }));
  });

  it('403s with WRITE_DENIED when the key owner lost project write access', async () => {
    finalizeMock.mockResolvedValue({ kind: 'write_denied' });
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WRITE_DENIED' }));
  });

  it('429s a concurrent finalize of the SAME object without waiting', async () => {
    mutexMock.mockResolvedValueOnce({ acquired: false });
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FINALIZE_IN_PROGRESS' }),
    );
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('429s when another publish for the project outlasts the wait window', async () => {
    mutexMock
      .mockImplementationOnce(passthroughMutex) // per-object: acquired
      .mockResolvedValueOnce({ acquired: false }); // per-project: still busy
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    );
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('503s when the MUTEX itself cannot be reached', async () => {
    mutexMock.mockRejectedValue(new RedisMutexUnavailableError('ci_publish_lock:proj-1', new Error('down')));
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RATE_LIMITER_UNAVAILABLE' }),
    );
  });

  it('does NOT dress a real finalize failure up as a transient 503', async () => {
    // The regression this guards: a try/catch meant for the mutex once wrapped
    // the whole locked body, so a dead database was reported to the customer as
    // "Build publishing is briefly unavailable" and hidden from monitoring.
    const realError = new Error('supabase unreachable');
    finalizeMock.mockRejectedValue(realError);
    const res = makeRes();

    await expect(finalizeCiAppUpload(makeReq(okBody), res)).rejects.toBe(realError);
    expect(res.status).not.toHaveBeenCalledWith(503);
  });

  it('does not prune when the publish failed', async () => {
    finalizeMock.mockResolvedValue({ kind: 'object_missing' });
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);
    await flush();

    expect(pruneMock).not.toHaveBeenCalled();
  });

  it('403s a free-plan account', async () => {
    isPaidUserMock.mockResolvedValue(false);
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});

describe('GET /ci/whoami', () => {
  it('returns projectId only — no project name or other customer data', async () => {
    const res = makeRes();
    await ciWhoami(makeReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body).toEqual({ success: true, projectId: 'proj-1' });
    expect(Object.keys(body)).not.toContain('projectName');
  });
});
