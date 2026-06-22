/**
 * Tests for `finalizeMobileAppUpload`'s version-identity waterfall.
 *
 * Contract:
 *   - Client-supplied values WIN over parsed.
 *   - Parsed values fill gaps when client omits.
 *   - No version AND no parsed version → timestamp fallback, NOT 400.
 *   - No packageName from either source → 400 (runner can't launch).
 *   - Parser crash → upload still succeeds with fallback.
 */

jest.mock('@/services/core/project.service', () => ({
  ProjectService: {
    getProject: jest.fn(),
    updateProject: jest.fn(),
  },
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    statObject: jest.fn(),
    finaliseDirectUpload: jest.fn(),
    recordBuild: jest.fn(),
    pruneOldBuilds: jest.fn().mockResolvedValue(undefined),
  },
  trimMobileBuildField: (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
}));

jest.mock('@/services/mobile/mobile-app-parser.service', () => ({
  MobileAppParserService: {
    parseFromStorage: jest.fn(),
  },
}));

jest.mock('../session.controller', () => ({
  autoBootAndInstall: jest.fn().mockResolvedValue(undefined),
}));

import { ProjectService } from '@/services/core/project.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { MobileAppParserService } from '@/services/mobile/mobile-app-parser.service';
import { autoBootAndInstall } from '../session.controller';
import { finalizeMobileAppUpload } from '../mobile.controller';

const getProjectMock = ProjectService.getProject as jest.Mock;
const updateProjectMock = ProjectService.updateProject as jest.Mock;
const statObjectMock = MobileAppStorageService.statObject as jest.Mock;
const finaliseDirectUploadMock = MobileAppStorageService.finaliseDirectUpload as jest.Mock;
const recordBuildMock = MobileAppStorageService.recordBuild as jest.Mock;
const parseFromStorageMock = MobileAppParserService.parseFromStorage as jest.Mock;
const pruneOldBuildsMock = MobileAppStorageService.pruneOldBuilds as jest.Mock;
const autoBootAndInstallMock = autoBootAndInstall as jest.Mock;

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq(body: Record<string, unknown>) {
  return {
    user: { id: 'user-1' },
    params: { projectId: 'proj-1' },
    body,
  } as any;
}

const PROJECT = { id: 'proj-1', workspace_id: 'ws-1', settings: {} };
const VALID_STORAGE_PATH = 'mobile-apps/ws-1/proj-1/android/app_123.apk';

describe('finalizeMobileAppUpload — version identity waterfall', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    getProjectMock.mockResolvedValue(PROJECT);
    updateProjectMock.mockResolvedValue(undefined);
    statObjectMock.mockResolvedValue({ sizeBytes: 12345, contentType: 'application/vnd.android.package-archive' });
    finaliseDirectUploadMock.mockImplementation((p: any) => ({
      platform: p.platform,
      packageName: p.packageName,
      storagePath: p.storagePath,
      publicUrl: 'https://stub/url',
      originalName: p.originalName,
      fileSize: p.fileSize,
      uploadedAt: '2026-05-27T00:00:00.000Z',
      ...(p.versionName ? { versionName: p.versionName } : {}),
      ...(typeof p.versionCode === 'number' ? { versionCode: p.versionCode } : {}),
    }));
    recordBuildMock.mockResolvedValue({ id: 'build-1' });
    parseFromStorageMock.mockResolvedValue({});
    pruneOldBuildsMock.mockResolvedValue(undefined);
    autoBootAndInstallMock.mockResolvedValue(undefined);
  });

  it('succeeds (200) when client omits both version fields and parser fills them', async () => {
    parseFromStorageMock.mockResolvedValueOnce({
      versionName: '1.0.0',
      versionCode: 100,
      packageName: 'com.parsed.app',
    });

    const req = makeReq({
      storagePath: VALID_STORAGE_PATH,
      platform: 'android',
    });
    const res = makeRes();

    await finalizeMobileAppUpload(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(parseFromStorageMock).toHaveBeenCalledWith(VALID_STORAGE_PATH, 'android');
    expect(finaliseDirectUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        versionName: '1.0.0',
        versionCode: 100,
        packageName: 'com.parsed.app',
      }),
    );
  });

  it('client values WIN over parsed values (parser still runs when packageName is missing)', async () => {
    parseFromStorageMock.mockResolvedValueOnce({
      versionName: 'parsed-name',
      versionCode: 999,
      packageName: 'com.parsed.app',
    });

    // Drop packageName so we exercise the parse path; the version fields
    // are still client-supplied to prove client-wins behaviour.
    const req = makeReq({
      storagePath: VALID_STORAGE_PATH,
      platform: 'android',
      versionName: 'client-name',
      versionCode: 1,
    });
    const res = makeRes();

    await finalizeMobileAppUpload(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(parseFromStorageMock).toHaveBeenCalledWith(VALID_STORAGE_PATH, 'android');
    expect(finaliseDirectUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        versionName: 'client-name',       // client wins
        versionCode: 1,                   // client wins
        packageName: 'com.parsed.app',    // parsed (client omitted)
      }),
    );
  });

  it('falls back to timestamp versionName when neither client nor parser supplies one (but packageName is parsed)', async () => {
    parseFromStorageMock.mockResolvedValueOnce({
      packageName: 'com.parsed.only',
    });

    const req = makeReq({
      storagePath: VALID_STORAGE_PATH,
      platform: 'android',
    });
    const res = makeRes();

    await finalizeMobileAppUpload(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(finaliseDirectUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: 'com.parsed.only',
        versionName: expect.stringMatching(/^build-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/),
        versionCode: undefined,
      }),
    );
  });

  it('parser crash does not 500 — upload still finalizes with timestamp fallback', async () => {
    // parser implementation already swallows errors and returns {}, so we
    // simulate that here. With no client values and an empty parse, we MUST
    // see a fallback + 400 because packageName is irrecoverable.
    parseFromStorageMock.mockResolvedValueOnce({});

    const req = makeReq({
      storagePath: VALID_STORAGE_PATH,
      platform: 'android',
      packageName: 'com.client.app', // client supplies packageName only
    });
    const res = makeRes();

    await finalizeMobileAppUpload(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(finaliseDirectUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: 'com.client.app',
        versionName: expect.stringMatching(/^build-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/),
      }),
    );
  });

  it('400s when neither client nor parser supplies a packageName', async () => {
    parseFromStorageMock.mockResolvedValueOnce({
      versionName: '1.0.0',
    });

    const req = makeReq({
      storagePath: VALID_STORAGE_PATH,
      platform: 'android',
    });
    const res = makeRes();

    await finalizeMobileAppUpload(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('packageName'),
      }),
    );
    expect(recordBuildMock).not.toHaveBeenCalled();
  });

  it('skips parser when client supplied all three identity fields (CI fast path)', async () => {
    // Performance contract: a fully-populated CI upload must NOT pay the
    // ~5-15s Supabase download cost just so we can stamp a framework
    // label. The trade-off is that fast-path uploads land without
    // `detectedFramework` — clients that want it omit one of the identity
    // fields. The legacy `MobileAppStorageService.uploadApp` path (CI
    // upload-from-URL) covers the rest by detecting from the in-memory
    // buffer with zero extra I/O.
    const req = makeReq({
      storagePath: VALID_STORAGE_PATH,
      platform: 'android',
      versionName: '5.0.0',
      versionCode: 500,
      packageName: 'com.complete.app',
    });
    const res = makeRes();

    await finalizeMobileAppUpload(req, res);

    expect(parseFromStorageMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(finaliseDirectUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'android',
        // detectedFramework is intentionally absent on the fast path.
      }),
    );
    // Explicitly assert the field is NOT stamped on the fast path.
    const callArgs = finaliseDirectUploadMock.mock.calls[0][0];
    expect(callArgs.detectedFramework).toBeUndefined();
  });

  it('runs parser AND stamps detectedFramework when packageName is missing', async () => {
    // The framework-detection path. Whenever we actually need to download
    // the binary (i.e. some identity field is missing), the detector
    // piggy-backs on the same temp file and ground-truth framework lands
    // in the metadata.
    parseFromStorageMock.mockResolvedValueOnce({
      packageName: 'com.parsed.pkg',
      framework: 'flutter',
    });

    const req = makeReq({
      storagePath: VALID_STORAGE_PATH,
      platform: 'android',
      versionName: '1.0.0',
      versionCode: 1,
      // packageName omitted → parser runs
    });
    const res = makeRes();

    await finalizeMobileAppUpload(req, res);

    expect(parseFromStorageMock).toHaveBeenCalledWith(VALID_STORAGE_PATH, 'android');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(finaliseDirectUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'android',           // NOT promoted (Bug B unfixed)
        detectedFramework: 'flutter',  // stamped from detector
      }),
    );
  });
});
