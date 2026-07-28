/**
 * Where the build contract plugs into finalize.
 *
 * Two properties this locks, both of which are easy to break silently:
 *
 *  1. The gate runs BEFORE `recordBuild` and `updateProject`. Rejecting after
 *     the write would leave an audit row and a settings pointer for a build we
 *     just refused — worse than not gating at all.
 *  2. It is CI-ONLY. The editor path must keep accepting the exact same
 *     archives it accepts today, with advisory UI. A native Android test needs
 *     no driver extension, and a user may legitimately upload an AOT build to
 *     inspect it.
 *
 * Also covers the reason `enforceBuildContract` forces a parse: the parse is
 * normally SKIPPED when the client supplied full version identity, which is
 * precisely what a well-behaved CI pipeline does — so without the force, the
 * gate would evaluate `{}` and reject every CI upload as BUILD_UNVERIFIABLE.
 */

jest.mock('@/services/core/project.service', () => ({
  ProjectService: { getProject: jest.fn(), updateProject: jest.fn() },
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    statObject: jest.fn(),
    finaliseDirectUpload: jest.fn(),
    recordBuild: jest.fn(),
    listVariantLabels: jest.fn().mockResolvedValue([]),
  },
  trimMobileBuildField: (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
}));

jest.mock('@/services/mobile/mobile-app-parser.service', () => ({
  MobileAppParserService: { parseFromStorage: jest.fn() },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ProjectService } from '@/services/core/project.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { MobileAppParserService } from '@/services/mobile/mobile-app-parser.service';
import { finalizeMobileAppUpload } from '../mobile-app.service';

const getProjectMock = ProjectService.getProject as jest.Mock;
const updateProjectMock = ProjectService.updateProject as jest.Mock;
const statObjectMock = MobileAppStorageService.statObject as jest.Mock;
const finaliseDirectUploadMock = MobileAppStorageService.finaliseDirectUpload as jest.Mock;
const recordBuildMock = MobileAppStorageService.recordBuild as jest.Mock;
const parseMock = MobileAppParserService.parseFromStorage as jest.Mock;

const PROJECT = { id: 'proj-1', workspace_id: 'ws-1', settings: {} };
const STORAGE_PATH = 'mobile-apps/ws-1/proj-1/android/app_123.apk';

/** A CI upload that supplied full version identity — the parse-skipping case. */
const FULL_IDENTITY = {
  projectId: 'proj-1',
  userId: 'owner-9',
  storagePath: STORAGE_PATH,
  platform: 'android' as const,
  originalName: 'app.apk',
  clientPackageName: 'com.example.app',
  clientVersionName: '1.2.3',
  clientVersionCode: 42,
};

const GOOD_BUILD = {
  packageName: 'com.example.app',
  framework: 'flutter' as const,
  flutterBuildMode: 'debug' as const,
  driverExtension: 'present' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  getProjectMock.mockResolvedValue(PROJECT);
  updateProjectMock.mockResolvedValue(undefined);
  statObjectMock.mockResolvedValue({ sizeBytes: 12345, contentType: 'application/vnd.android.package-archive' });
  finaliseDirectUploadMock.mockImplementation((p: any) => ({ ...p, uploadedAt: '2026-07-27T00:00:00.000Z' }));
  recordBuildMock.mockResolvedValue({ id: 'build-1' });
  parseMock.mockResolvedValue(GOOD_BUILD);
});

describe('enforceBuildContract — CI publish', () => {
  it('accepts a Flutter debug build with the driver extension compiled in', async () => {
    const result = await finalizeMobileAppUpload({ ...FULL_IDENTITY, enforceBuildContract: true });

    expect('kind' in result).toBe(false);
    expect(recordBuildMock).toHaveBeenCalled();
  });

  it('forces the parse even when the client supplied full version identity', async () => {
    // Without this, a well-behaved pipeline skips the parse, the gate sees {}
    // and rejects every CI upload as BUILD_UNVERIFIABLE.
    await finalizeMobileAppUpload({ ...FULL_IDENTITY, enforceBuildContract: true });

    expect(parseMock).toHaveBeenCalledWith(STORAGE_PATH, 'android');
  });

  it.each([
    ['a release build', { packageName: 'x', framework: 'flutter', flutterBuildMode: 'aot' }, 'BUILD_NOT_DEBUG'],
    [
      'a debug build without the extension',
      { packageName: 'x', framework: 'flutter', flutterBuildMode: 'debug', driverExtension: 'absent' },
      'DRIVER_EXTENSION_MISSING',
    ],
    ['an unparseable archive', {}, 'BUILD_UNVERIFIABLE'],
  ])('rejects %s without writing anything', async (_label, parsedInfo, code) => {
    parseMock.mockResolvedValue(parsedInfo);

    const result = await finalizeMobileAppUpload({ ...FULL_IDENTITY, enforceBuildContract: true });

    expect(result).toEqual(expect.objectContaining({ kind: 'build_contract_rejected', code }));
    // The whole point of gating before the write.
    expect(recordBuildMock).not.toHaveBeenCalled();
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it('returns remediation the pipeline can act on', async () => {
    parseMock.mockResolvedValue({
      packageName: 'x',
      framework: 'flutter',
      flutterBuildMode: 'debug',
      driverExtension: 'absent',
    });

    const result = await finalizeMobileAppUpload({ ...FULL_IDENTITY, enforceBuildContract: true });

    if (!('kind' in result)) throw new Error('expected rejection');
    expect((result as any).remediation).toContain('enableFlutterDriverExtension()');
  });

  it('accepts a native Android build — it needs no driver extension', async () => {
    parseMock.mockResolvedValue({ packageName: 'com.example.app', framework: 'android' });

    const result = await finalizeMobileAppUpload({ ...FULL_IDENTITY, enforceBuildContract: true });

    expect('kind' in result).toBe(false);
    expect(recordBuildMock).toHaveBeenCalled();
  });
});

describe('editor path — advisory, never blocking', () => {
  it('still accepts a release Flutter build when the contract is not enforced', async () => {
    parseMock.mockResolvedValue({ packageName: 'x', framework: 'flutter', flutterBuildMode: 'aot' });

    const result = await finalizeMobileAppUpload({
      ...FULL_IDENTITY,
      clientPackageName: undefined, // force a parse the editor way
    });

    expect('kind' in result).toBe(false);
    expect(recordBuildMock).toHaveBeenCalled();
  });

  it('still accepts a debug build with no driver extension', async () => {
    parseMock.mockResolvedValue({
      packageName: 'x',
      framework: 'flutter',
      flutterBuildMode: 'debug',
      driverExtension: 'absent',
    });

    const result = await finalizeMobileAppUpload({ ...FULL_IDENTITY, clientPackageName: undefined });

    expect('kind' in result).toBe(false);
    expect(recordBuildMock).toHaveBeenCalled();
  });

  it('keeps skipping the parse when the client supplied full identity', async () => {
    await finalizeMobileAppUpload(FULL_IDENTITY);

    expect(parseMock).not.toHaveBeenCalled();
    expect(recordBuildMock).toHaveBeenCalled();
  });
});

describe('recorded build source', () => {
  it("stamps source 'ci' when the CI path finalizes", async () => {
    await finalizeMobileAppUpload({ ...FULL_IDENTITY, source: 'ci', enforceBuildContract: true });

    expect(recordBuildMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'ci' }),
      expect.anything(),
    );
  });

  it("defaults to source 'manual' for the editor path", async () => {
    await finalizeMobileAppUpload(FULL_IDENTITY);

    expect(recordBuildMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'manual' }),
      expect.anything(),
    );
  });
});
