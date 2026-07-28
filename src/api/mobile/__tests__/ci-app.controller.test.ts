/**
 * Tests for the three CI app endpoints' HTTP contract.
 *
 * Locked here:
 *   - `pruneOldBuilds` IS fired with the RESOLVED lane; `autoBootAndInstall` is
 *     NOT (there is no emulator at publish time).
 *   - Build identity (commitSha OR versionName/versionCode) is required.
 *   - A duplicate commit is a 409, not a 500.
 *   - `whoami` returns projectId ONLY — its output lands in CI logs, which are
 *     public for OSS repos — and is per-IP limited before it touches the DB.
 *   - Both write endpoints are paid-gated and rate limited.
 */

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    set: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
  },
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

import { redisConnection } from '@/config/infrastructure/queues';
import { isPaidUser } from '@/services/core/plan-access.service';
import * as CiAppPublishService from '@/services/mobile/ci-app-publish.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { autoBootAndInstall } from '../session.controller';
import {
  ciWhoami,
  ciWhoamiRateLimit,
  createCiAppUploadUrl,
  finalizeCiAppUpload,
} from '../ci-app.controller';

const redisSetMock = redisConnection.set as unknown as jest.Mock;
const redisDelMock = redisConnection.del as unknown as jest.Mock;
const redisIncrMock = redisConnection.incr as unknown as jest.Mock;
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
  return res;
}

function makeReq(body: Record<string, unknown> = {}) {
  return { ciProject: PROJECT, ciUserId: 'owner-9', body, ip: '10.0.0.1' } as any;
}

/** Let the fire-and-forget prune promise settle. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  isPaidUserMock.mockResolvedValue(true);
  redisSetMock.mockResolvedValue('OK');
  redisDelMock.mockResolvedValue(1);
  redisIncrMock.mockResolvedValue(1);
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

  it('403s a free-plan account before doing any work', async () => {
    isPaidUserMock.mockResolvedValue(false);
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(createUrlMock).not.toHaveBeenCalled();
  });

  it('400s when filename is missing', async () => {
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createUrlMock).not.toHaveBeenCalled();
  });

  it('429s when the project already uploaded inside the rate-limit window', async () => {
    redisSetMock.mockResolvedValue(null); // NX failed — lock already held
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(createUrlMock).not.toHaveBeenCalled();
  });

  it('releases the rate-limit lock when no URL was actually issued', async () => {
    createUrlMock.mockResolvedValue({ kind: 'invalid_filename', ext: '.txt' });
    const res = makeRes();
    await createCiAppUploadUrl(makeReq({ filename: 'notes.txt' }), res);

    expect(redisDelMock).toHaveBeenCalledWith('ci_apk_upload:proj-1');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('releases the rate-limit lock when the service throws unexpectedly', async () => {
    // Otherwise a transient failure costs the project its whole 5-minute
    // upload window for nothing.
    createUrlMock.mockRejectedValue(new Error('storage unreachable'));
    const res = makeRes();

    await expect(createCiAppUploadUrl(makeReq({ filename: 'app.apk' }), res)).rejects.toThrow(
      'storage unreachable',
    );
    expect(redisDelMock).toHaveBeenCalledWith('ci_apk_upload:proj-1');
  });

  it('never lets the caller choose the project', async () => {
    const res = makeRes();
    const req = makeReq({ filename: 'app.apk', projectId: 'someone-elses-project' });
    await createCiAppUploadUrl(req, res);

    expect(createUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ project: PROJECT }),
    );
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
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DUPLICATE_COMMIT' }),
    );
  });

  it('403s with WRITE_DENIED when the key owner lost project write access', async () => {
    finalizeMock.mockResolvedValue({ kind: 'write_denied' });
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WRITE_DENIED' }),
    );
  });

  it('429s a concurrent finalize of the same object', async () => {
    redisSetMock.mockResolvedValue(null);
    const res = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FINALIZE_IN_PROGRESS' }),
    );
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('releases the per-object mutex on both success and failure', async () => {
    const lockKey = `ci_apk_finalize:${STORAGE_PATH}`;

    const okRes = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), okRes);
    await flush();
    expect(redisDelMock).toHaveBeenCalledWith(lockKey);

    redisDelMock.mockClear();
    finalizeMock.mockResolvedValue({ kind: 'object_missing' });
    const failRes = makeRes();
    await finalizeCiAppUpload(makeReq(okBody), failRes);
    expect(redisDelMock).toHaveBeenCalledWith(lockKey);
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

  it('lets a request through under the per-IP limit', async () => {
    redisIncrMock.mockResolvedValue(5);
    const res = makeRes();
    const next = jest.fn();
    await ciWhoamiRateLimit(makeReq(), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('429s once the per-IP limit is exceeded', async () => {
    redisIncrMock.mockResolvedValue(31);
    const res = makeRes();
    const next = jest.fn();
    await ciWhoamiRateLimit(makeReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails open when Redis is unavailable — losing the limiter beats losing the endpoint', async () => {
    redisIncrMock.mockRejectedValue(new Error('redis down'));
    const res = makeRes();
    const next = jest.fn();
    await ciWhoamiRateLimit(makeReq(), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
