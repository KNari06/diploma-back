/**
 * The device-truth half of the install decision.
 *
 * Everything else that answers "is this build already installed" reads Redis,
 * which runs `allkeys-lru` with no volume — the record is evictable at any
 * moment and gone after a restart. When it vanishes the service reinstalls,
 * which is correct but, for a 324 MB APK, was a dead end: on 2026-08-28 the
 * backend was OOM-killed partway through the upload (exit 137 against a 2 GiB
 * limit) three retries running, for a build the device already had.
 *
 * These tests pin the two properties that make asking the device safe enough
 * to act on: it confirms ONLY an exact (signer, versionCode) match, and every
 * failure mode resolves to "reinstall".
 */
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));
jest.mock('@/services/core/project.service', () => ({ ProjectService: { getProject: jest.fn() } }));
jest.mock('@/api/mobile/session.controller', () => ({
  WARMUP_PREFIX: 'mobile_warmup:',
  WARMUP_TTL: 900,
  PENDING_INSTALL_PREFIX: 'mobile_pending_install:',
}));
jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    getBuildByStoragePath: jest.fn(),
    recordObservedIdentity: jest.fn(),
    getProjectDefaultVariant: jest.fn(),
    resolveAppForRun: jest.fn(),
    downloadApp: jest.fn(),
  },
}));
jest.mock('@/utils/core/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { MobileAppPrepService } from '../mobile-app-prep.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';

const STORAGE_PATH = 'mobile-apps/ws/proj/android/app-dev_1787134498101.apk';
const PKG = 'com.itsapp.klaraai.dev';
const SIGNER_DEBUG = 'E7:89:37:BF:21:64:18:3F:9B:7A:AF:E0:B2:00:C3:74:11:00:3C:19:45:B2:0E:54:DF:56:C7:79:64:87:9B:E4';
const SIGNER_RELEASE = 'AA:BB:37:BF:21:64:18:3F:9B:7A:AF:E0:B2:00:C3:74:11:00:3C:19:45:B2:0E:54:DF:56:C7:79:64:87:9B:E4';

const confirm = (args: Record<string, unknown>) =>
  (MobileAppPrepService as unknown as {
    confirmBuildOnDevice: (a: unknown) => Promise<boolean>;
  }).confirmBuildOnDevice({
    sessionId: 's1', projectId: 'p1', packageName: PKG, storagePath: STORAGE_PATH, ...args,
  });

const capture = (args: Record<string, unknown>) =>
  (MobileAppPrepService as unknown as {
    captureBuildIdentity: (a: unknown) => Promise<void>;
  }).captureBuildIdentity({
    sessionId: 's1', projectId: 'p1', packageName: PKG, storagePath: STORAGE_PATH, ...args,
  });

/** A runner reporting one slot holding `build`. */
function runnerWith(build: Record<string, unknown> | null) {
  return {
    getDeviceBuilds: jest.fn().mockResolvedValue({
      collectedAt: '2026-08-28T00:00:00.000Z',
      devices: [{
        serial: '127.0.0.1:5600',
        state: 'ready',
        packages: build ? [build.packageName] : [],
        agentInstalled: true,
        builds: build ? [build] : [],
      }],
    }),
  };
}

beforeEach(() => jest.clearAllMocks());

describe('confirmBuildOnDevice', () => {
  it('confirms when signer and versionCode both match the recorded identity', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: SIGNER_DEBUG, observedVersionCode: 416,
    });
    const client = runnerWith({ packageName: PKG, versionCode: 416, signerSha256: SIGNER_DEBUG });

    await expect(confirm({ client })).resolves.toBe(true);
  });

  it('REFUSES a build with the same versionCode but a different signing key', async () => {
    // The JanaPost pair: release and debug both at 426. Confirming this would
    // leave the release build in place and Flutter attach would fail with
    // FLUTTER_NOT_DETECTED — a release build ships no Dart VM Service.
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: SIGNER_DEBUG, observedVersionCode: 426,
    });
    const client = runnerWith({ packageName: PKG, versionCode: 426, signerSha256: SIGNER_RELEASE });

    await expect(confirm({ client })).resolves.toBe(false);
  });

  it('refuses when the signer matches but the version does not', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: SIGNER_DEBUG, observedVersionCode: 416,
    });
    const client = runnerWith({ packageName: PKG, versionCode: 421, signerSha256: SIGNER_DEBUG });

    await expect(confirm({ client })).resolves.toBe(false);
  });

  it('refuses when no identity has been recorded for this build yet', async () => {
    // First ever install of a build: nothing to compare against. That install
    // writes the record, so the project self-heals rather than staying blind.
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: undefined,
    });
    const client = runnerWith({ packageName: PKG, versionCode: 416, signerSha256: SIGNER_DEBUG });

    await expect(confirm({ client })).resolves.toBe(false);
    expect(client.getDeviceBuilds).not.toHaveBeenCalled();
  });

  it('refuses when the device reports the package without a digest', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: SIGNER_DEBUG, observedVersionCode: 416,
    });
    // Present-but-unidentified. Reading this as a match is exactly the
    // package-presence mistake this check exists to replace.
    const client = runnerWith({ packageName: PKG });

    await expect(confirm({ client })).resolves.toBe(false);
  });

  it('refuses when the device holds a different package entirely', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: SIGNER_DEBUG, observedVersionCode: 416,
    });
    const client = runnerWith({ packageName: 'com.someone.else', versionCode: 416, signerSha256: SIGNER_DEBUG });

    await expect(confirm({ client })).resolves.toBe(false);
  });

  it('falls through to install when the runner call fails', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: SIGNER_DEBUG, observedVersionCode: 416,
    });
    const client = { getDeviceBuilds: jest.fn().mockRejectedValue(new Error('timeout')) };

    // An optimisation must never fail the session it is optimising.
    await expect(confirm({ client })).resolves.toBe(false);
  });

  it('falls through when the runner is too old to report builds', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: SIGNER_DEBUG, observedVersionCode: 416,
    });
    const client = {
      getDeviceBuilds: jest.fn().mockResolvedValue({
        collectedAt: 'x',
        devices: [{ serial: 's', state: 'ready', packages: [PKG], agentInstalled: true }],
      }),
    };

    await expect(confirm({ client })).resolves.toBe(false);
  });
});

describe('captureBuildIdentity', () => {
  it('records what the device reports after a first install', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: undefined,
    });
    const client = runnerWith({ packageName: PKG, versionCode: 416, signerSha256: SIGNER_DEBUG });

    await capture({ client });

    expect(MobileAppStorageService.recordObservedIdentity).toHaveBeenCalledWith('b1', {
      signerSha256: SIGNER_DEBUG,
      versionCode: 416,
    });
  });

  it('does not re-record a build whose identity is already known', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: SIGNER_DEBUG,
    });
    const client = runnerWith({ packageName: PKG, versionCode: 416, signerSha256: SIGNER_DEBUG });

    await capture({ client });

    expect(client.getDeviceBuilds).not.toHaveBeenCalled();
    expect(MobileAppStorageService.recordObservedIdentity).not.toHaveBeenCalled();
  });

  it('stays silent when the device cannot describe the package', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockResolvedValue({
      id: 'b1', signerSha256: undefined,
    });
    const client = runnerWith({ packageName: PKG });

    await capture({ client });

    // Recording an unidentified build would poison every later comparison.
    expect(MobileAppStorageService.recordObservedIdentity).not.toHaveBeenCalled();
  });

  it('never throws into the install path', async () => {
    (MobileAppStorageService.getBuildByStoragePath as jest.Mock).mockRejectedValue(new Error('db down'));
    const client = runnerWith({ packageName: PKG, versionCode: 416, signerSha256: SIGNER_DEBUG });

    await expect(capture({ client })).resolves.toBeUndefined();
  });
});
