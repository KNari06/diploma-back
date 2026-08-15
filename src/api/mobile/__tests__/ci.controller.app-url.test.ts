/**
 * HTTP contract for `POST /ci/run`'s appUrl publish branch.
 *
 * The branch had no tests at all before the publish path was extracted, which
 * is how three lock leaks survived in it. The service half is covered in
 * `services/mobile/__tests__/ci-url-publish.service.test.ts`; this file covers
 * the wiring the controller still owns — the quota gate, the per-project
 * mutex, and the mapping from each tagged error onto a status code.
 */

// `env` is zod-parsed at import time, so process.env cannot be set later.
// Mocking it also removes dotenv's side effect, so `db/supabase` (which reads
// process.env directly at import and throws when it is empty) is stubbed too.
// The appUrl branch under test touches neither.
jest.mock('@/config/environment/env', () => ({
  env: { MOBILE_RUNNER_ENABLED: true, MAX_CI_PUBLISHES_PER_HOUR: 30 },
}));

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: { from: jest.fn() },
  dbAdminService: { createTest: jest.fn() },
}));

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: { set: jest.fn(), del: jest.fn(), eval: jest.fn(), ttl: jest.fn() },
  QueueManager: { isRedisAvailable: jest.fn().mockReturnValue(true) },
}));

jest.mock('@/middleware/redis-rate-limit.middleware', () => ({
  ...jest.requireActual('@/middleware/redis-rate-limit.middleware'),
  consumeRateLimit: jest.fn(),
}));

jest.mock('@/utils/core/redis-mutex', () => ({ withRedisMutex: jest.fn() }));

jest.mock('@/services/mobile/ci-url-publish.service', () => ({
  publishFromUrl: jest.fn(),
  isCiUrlPublishError: (v: unknown) => typeof v === 'object' && v !== null && 'kind' in v,
}));

jest.mock('@/services/core/plan-access.service', () => ({ isPaidUser: jest.fn() }));

jest.mock('@/services/mobile/mobile-runner-client', () => ({
  getMobileRunnerClient: () => ({ isHealthy: jest.fn().mockResolvedValue(true) }),
  resolveRunnerUrlForHost: jest.fn(),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { consumeRateLimit } from '@/middleware/redis-rate-limit.middleware';
import { isPaidUser } from '@/services/core/plan-access.service';
import * as CiUrlPublishService from '@/services/mobile/ci-url-publish.service';
import { withRedisMutex } from '@/utils/core/redis-mutex';
import { triggerCiRun } from '../ci.controller';

const consumeMock = consumeRateLimit as jest.Mock;
const mutexMock = withRedisMutex as jest.Mock;
const publishMock = CiUrlPublishService.publishFromUrl as jest.Mock;
const isPaidUserMock = isPaidUser as jest.Mock;

const PROJECT = { id: 'proj-1', user_id: 'owner-9', workspace_id: 'ws-1', settings: {} };

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq(body: Record<string, unknown> = {}) {
  return {
    ciProject: PROJECT,
    ciUserId: 'owner-9',
    body: { appUrl: 'https://builds.example.com/app.apk', versionName: '1.2.3', ...body },
  } as any;
}

const passthroughMutex = async (_opts: unknown, fn: () => Promise<unknown>) => ({
  acquired: true,
  value: await fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MOBILE_RUNNER_ENABLED = 'true';
  isPaidUserMock.mockResolvedValue(true);
  consumeMock.mockResolvedValue({ outcome: 'allowed' });
  mutexMock.mockImplementation(passthroughMutex);
  publishMock.mockResolvedValue({
    storagePath: 'mobile-apps/ws-1/proj-1/android/Production/app_1.apk',
    originalName: 'app.apk',
    packageName: 'com.example.app',
    variantLabel: 'Production',
    buildId: 'build-1',
    sizeBytes: 1024,
  });
});

describe('POST /ci/run with appUrl — quota and mutex', () => {
  it('429s with Retry-After once the hourly publish quota is spent, before downloading', async () => {
    consumeMock.mockResolvedValue({ outcome: 'limited', retryAfterSec: 1800 });
    const res = makeRes();

    await triggerCiRun(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '1800');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RATE_LIMITED', retryAfterSeconds: 1800 }),
    );
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('503s rather than downloading a build it cannot meter', async () => {
    consumeMock.mockResolvedValue({ outcome: 'unavailable' });
    const res = makeRes();

    await triggerCiRun(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('publishes under the per-project mutex, and that mutex WAITS', async () => {
    const res = makeRes();

    await triggerCiRun(makeReq(), res);

    const [opts] = mutexMock.mock.calls[0];
    expect(opts.key).toBe('ci_publish_lock:proj-1');
    expect(opts.waitMs).toBeGreaterThan(0);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', appUrl: 'https://builds.example.com/app.apk' }),
    );
  });

  it('429s with the holder\'s remaining time when the mutex stays busy', async () => {
    mutexMock.mockResolvedValue({ acquired: false, retryAfterSec: 17 });
    const res = makeRes();

    await triggerCiRun(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '17');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('requires version identity before spending a publish slot', async () => {
    const res = makeRes();

    await triggerCiRun(makeReq({ versionName: undefined }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(consumeMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('POST /ci/run with appUrl — error mapping', () => {
  it.each([
    ['write_denied', { kind: 'write_denied' }, 403],
    ['invalid_url', { kind: 'invalid_url' }, 400],
    ['blocked_host', { kind: 'blocked_host', message: 'nope' }, 400],
    ['download_failed', { kind: 'download_failed', status: 404 }, 400],
    ['download_timeout', { kind: 'download_timeout' }, 408],
    ['file_too_large', { kind: 'file_too_large', sizeBytes: 6e8, maxBytes: 5e8 }, 400],
    ['invalid_filename', { kind: 'invalid_filename', ext: '.txt' }, 400],
    ['duplicate_commit', { kind: 'duplicate_commit' }, 409],
    ['build_record_failed', { kind: 'build_record_failed', message: 'boom' }, 500],
    ['download_error', { kind: 'download_error', message: 'reset' }, 400],
  ])('maps %s onto HTTP %s', async (_label, tagged, status) => {
    publishMock.mockResolvedValue(tagged);
    const res = makeRes();

    await triggerCiRun(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(status);
  });

  it('does not leak a private address into the response for a blocked host', async () => {
    publishMock.mockResolvedValue({ kind: 'blocked_host', message: 'This host is not allowed.' });
    const res = makeRes();

    await triggerCiRun(makeReq(), res);

    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).not.toMatch(/169\.254|127\.0\.0\.1|10\.\d+\./);
  });
});
