/**
 * First tests for the `/ci/run` appUrl publish path. It had none, which is how
 * three lock leaks lived in it undetected.
 *
 * THE REGRESSION PROOF, in two halves. The leak was: three early `return`s
 * inside the branch's `try` bypassed the `catch` that released the lock, so a
 * download failure cost the project a 300s lockout on top of the error.
 *   1. Here: each of those three failures is now an ordinary tagged RETURN,
 *      not a response written mid-branch.
 *   2. In `utils/core/__tests__/redis-mutex.test.ts`: the lock is released in
 *      a `finally`, on every exit path including a plain return.
 * Together the leak is unrepresentable — the release no longer depends on
 * which branch the code took.
 */

jest.mock('@/services/core/workspace-access.service', () => ({
  PERMISSIONS: { PROJECT_WRITE: 'project:write' },
  WorkspaceAccessService: { hasPermission: jest.fn() },
}));

jest.mock('@/services/core/project.service', () => ({
  ProjectService: { updateProject: jest.fn().mockResolvedValue({}) },
}));

jest.mock('@/services/mobile/mobile-app.service', () => ({
  ALLOWED_UPLOAD_EXTENSIONS: ['.apk', '.ipa', '.zip'],
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    getProjectDefaultVariant: jest.fn(),
    uploadApp: jest.fn(),
    recordBuild: jest.fn(),
    pruneOldBuilds: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@/utils/validation/ssrf-host-guard', () => ({ checkSsrfHost: jest.fn() }));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ProjectService } from '@/services/core/project.service';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { checkSsrfHost } from '@/utils/validation/ssrf-host-guard';
import { publishFromUrl } from '../ci-url-publish.service';

const ssrfMock = checkSsrfHost as jest.Mock;
const canWriteMock = WorkspaceAccessService.hasPermission as jest.Mock;
const variantMock = MobileAppStorageService.getProjectDefaultVariant as jest.Mock;
const uploadMock = MobileAppStorageService.uploadApp as jest.Mock;
const recordMock = MobileAppStorageService.recordBuild as jest.Mock;
const pruneMock = MobileAppStorageService.pruneOldBuilds as jest.Mock;
const updateProjectMock = ProjectService.updateProject as jest.Mock;

const INPUT = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  userId: 'owner-9',
  platform: 'android' as const,
  appUrl: 'https://builds.example.com/app.apk',
  versionName: '1.2.3',
  commitSha: 'abc123',
};

/** Minimal stand-in for a fetch Response, including the stream the code reads. */
function fakeResponse(
  body: Buffer,
  init: { status?: number; contentLength?: string | null; location?: string } = {},
) {
  const status = init.status ?? 200;
  let delivered = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        if (name === 'location') return init.location ?? null;
        if (name === 'content-length') {
          return init.contentLength === undefined ? String(body.length) : init.contentLength;
        }
        return null;
      },
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: new Uint8Array(body) };
        },
        cancel: async () => undefined,
      }),
    },
  };
}

function mockFetchSequence(...responses: unknown[]) {
  const fn = jest.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  jest.clearAllMocks();
  canWriteMock.mockResolvedValue(true);
  ssrfMock.mockResolvedValue({ verdict: 'allowed' });
  variantMock.mockResolvedValue('Production');
  uploadMock.mockResolvedValue({
    storagePath: 'mobile-apps/ws-1/proj-1/android/Production/app_1.apk',
    originalName: 'app.apk',
    packageName: 'com.example.app',
  });
  recordMock.mockResolvedValue({ id: 'build-1' });
  updateProjectMock.mockResolvedValue({});
  mockFetchSequence(fakeResponse(Buffer.from('APKDATA')));
});

describe('publishFromUrl — the three failures that used to leak the lock', () => {
  it('returns download_failed on a non-2xx, without writing a response', async () => {
    mockFetchSequence(fakeResponse(Buffer.alloc(0), { status: 404 }));

    const result = await publishFromUrl(INPUT);

    expect(result).toEqual({ kind: 'download_failed', status: 404 });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('returns file_too_large when Content-Length exceeds the cap', async () => {
    mockFetchSequence(
      fakeResponse(Buffer.from('x'), { contentLength: String(600 * 1024 * 1024) }),
    );

    const result = await publishFromUrl(INPUT);

    expect(result).toMatchObject({ kind: 'file_too_large' });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('returns invalid_filename for a disallowed extension', async () => {
    const fetchMock = mockFetchSequence(fakeResponse(Buffer.from('x')));

    const result = await publishFromUrl({
      ...INPUT,
      appUrl: 'https://builds.example.com/notes.txt',
    });

    expect(result).toEqual({ kind: 'invalid_filename', ext: '.txt' });
    // Rejected on the filename BEFORE pulling the body.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('publishFromUrl — size cap', () => {
  it('rejects an oversize body that declared NO Content-Length, without buffering it whole', async () => {
    // A chunked response skips the declared-size check entirely, so reading
    // incrementally is the only real bound.
    const oversize = Buffer.alloc(600 * 1024 * 1024);
    mockFetchSequence(fakeResponse(oversize, { contentLength: null }));

    const result = await publishFromUrl(INPUT);

    expect(result).toMatchObject({ kind: 'file_too_large' });
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe('publishFromUrl — SSRF', () => {
  it('refuses a host that resolves to a private address, before fetching it', async () => {
    const fetchMock = mockFetchSequence(fakeResponse(Buffer.from('x')));
    ssrfMock.mockResolvedValue({ verdict: 'blocked', message: 'This host is not allowed.' });

    const result = await publishFromUrl({ ...INPUT, appUrl: 'http://169.254.169.254/app.apk' });

    expect(result).toMatchObject({ kind: 'blocked_host' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-http scheme', 'file:///etc/passwd'],
    ['garbage', 'not-a-url'],
  ])('rejects %s outright', async (_label, appUrl) => {
    const fetchMock = mockFetchSequence(fakeResponse(Buffer.from('x')));

    const result = await publishFromUrl({ ...INPUT, appUrl });

    expect(result).toEqual({ kind: 'invalid_url' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-checks the guard on a REDIRECT, so a public host cannot bounce us internally', async () => {
    // The whole point: fetch follows redirects by default, so guarding only the
    // customer-supplied URL guards nothing.
    mockFetchSequence(
      fakeResponse(Buffer.alloc(0), { status: 302, location: 'http://169.254.169.254/creds' }),
      fakeResponse(Buffer.from('SECRET')),
    );
    ssrfMock
      .mockResolvedValueOnce({ verdict: 'allowed' })
      .mockResolvedValue({ verdict: 'blocked', message: 'This host is not allowed.' });

    const result = await publishFromUrl(INPUT);

    expect(result).toMatchObject({ kind: 'blocked_host' });
    expect(ssrfMock).toHaveBeenCalledTimes(2);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('follows a redirect that stays on an allowed host', async () => {
    mockFetchSequence(
      fakeResponse(Buffer.alloc(0), { status: 302, location: 'https://cdn.example.com/app.apk' }),
      fakeResponse(Buffer.from('APKDATA')),
    );

    const result = await publishFromUrl(INPUT);

    expect(result).toMatchObject({ buildId: 'build-1' });
    expect(ssrfMock).toHaveBeenCalledTimes(2);
  });

  it('gives up rather than following a redirect loop forever', async () => {
    const loop = () =>
      fakeResponse(Buffer.alloc(0), { status: 302, location: 'https://builds.example.com/app.apk' });
    mockFetchSequence(loop(), loop(), loop(), loop(), loop(), loop(), loop());

    const result = await publishFromUrl(INPUT);

    expect(result).toMatchObject({ kind: 'download_error' });
  });
});

describe('publishFromUrl — access', () => {
  it('refuses when the key owner no longer has PROJECT_WRITE, before any download', async () => {
    const fetchMock = mockFetchSequence(fakeResponse(Buffer.from('x')));
    canWriteMock.mockResolvedValue(false);

    const result = await publishFromUrl(INPUT);

    expect(result).toEqual({ kind: 'write_denied' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe('publishFromUrl — success path', () => {
  it('stores, records and prunes the SAME resolved lane', async () => {
    const result = await publishFromUrl(INPUT);

    expect(result).toMatchObject({ variantLabel: 'Production', buildId: 'build-1' });
    expect(uploadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ variantLabel: 'Production' }),
    );
    expect(recordMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'ci', commitSha: 'abc123' }),
      expect.objectContaining({ variantLabel: 'Production' }),
    );
    expect(pruneMock).toHaveBeenCalledWith('proj-1', 'android', 'Production');
  });

  it('records the build BEFORE repointing the legacy slot', async () => {
    await publishFromUrl(INPUT);

    expect(recordMock.mock.invocationCallOrder[0])
      .toBeLessThan(updateProjectMock.mock.invocationCallOrder[0]);
  });

  it('maps a unique-violation to duplicate_commit and leaves the legacy slot alone', async () => {
    recordMock.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });

    const result = await publishFromUrl(INPUT);

    expect(result).toEqual({ kind: 'duplicate_commit' });
    expect(updateProjectMock).not.toHaveBeenCalled();
  });
});
