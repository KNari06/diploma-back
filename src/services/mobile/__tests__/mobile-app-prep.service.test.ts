const mockGet = jest.fn();
// ioredis resolves these; the service chains `.catch()` on them, so the mocks
// must be thenable or the chain throws on a bare `undefined`.
const mockSet = jest.fn((..._args: unknown[]) => Promise.resolve('OK'));
const mockDel = jest.fn((..._args: unknown[]) => Promise.resolve(1));

jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    get: (...args: unknown[]) => mockGet(...args),
    set: (...args: unknown[]) => mockSet(...args),
    del: (...args: unknown[]) => mockDel(...args),
  },
}));

const mockGetProject = jest.fn();
jest.mock('@/services/core/project.service', () => ({
  ProjectService: { getProject: (...args: unknown[]) => mockGetProject(...args) },
}));

jest.mock('@/api/mobile/session.controller', () => ({
  WARMUP_PREFIX: 'mobile_warmup:',
  WARMUP_TTL: 900,
  PENDING_INSTALL_PREFIX: 'mobile_pending_install:',
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    getProjectDefaultVariant: jest.fn().mockResolvedValue(undefined),
    resolveAppForRun: jest.fn(),
    downloadApp: jest.fn(),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { MobileAppPrepService } from '../mobile-app-prep.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';

const PACKAGE = 'com.aitan.inexport';
const STORAGE_PATH = 'apps/com.aitan.inexport/app.apk';
const INSTALLED_BUILD_KEY_PREFIX = 'mobile_installed_build:';

/**
 * Redis `get` stub. Branch 2 is only allowed to run when SOMETHING records
 * which build is installed, so a test exercising it must say so explicitly —
 * either via the warmup entry or the durable installed-build record.
 */
function redisGet({ warmup, installedBuild }: { warmup?: unknown; installedBuild?: string } = {}) {
  mockGet.mockImplementation((key: string) => {
    if (key.startsWith('mobile_warmup:')) {
      return Promise.resolve(warmup ? JSON.stringify(warmup) : null);
    }
    if (key.startsWith(INSTALLED_BUILD_KEY_PREFIX)) {
      return Promise.resolve(installedBuild ?? null);
    }
    return Promise.resolve(null);
  });
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    client: { executeBatchCommands: jest.fn().mockResolvedValue({ results: [{ success: true, data: {} }] }) },
    sessionId: 'session-1',
    projectId: 'project-1',
    userId: 'user-1',
    ...overrides,
  } as any;
}

describe('MobileAppPrepService.prepApp — hard-reset vs skipLaunch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetProject.mockResolvedValue({
      settings: { mobileApp: { storagePath: STORAGE_PATH, originalName: 'app.apk', packageName: PACKAGE } },
    });
  });

  it('branch 1 (Redis cache hit): close_app(hard:true) AND launch_app both fire when skipLaunch is false', async () => {
    mockGet.mockImplementation((key: string) =>
      key.startsWith('mobile_warmup:')
        ? Promise.resolve(JSON.stringify({ installedPackage: PACKAGE, appStoragePath: STORAGE_PATH }))
        : Promise.resolve(null));
    const args = baseArgs({
      client: {
        executeBatchCommands: jest.fn()
          // check_package (branch 1's on-device verification)
          .mockResolvedValueOnce({ results: [{ data: { installed: true } }] })
          // close_app + launch_app batch
          .mockResolvedValueOnce({ results: [{ success: true }, { success: true }] }),
      },
    });

    await MobileAppPrepService.prepApp(args);

    const calls = args.client.executeBatchCommands.mock.calls;
    const resetCall = calls[calls.length - 1];
    const commandTypes = resetCall[1].map((c: any) => c.type);
    expect(commandTypes).toEqual(['close_app', 'launch_app']);
  });

  it('branch 1 (Redis cache hit): close_app(hard:true) STILL fires when skipLaunch is true — the bug this test guards', async () => {
    mockGet.mockImplementation((key: string) =>
      key.startsWith('mobile_warmup:')
        ? Promise.resolve(JSON.stringify({ installedPackage: PACKAGE, appStoragePath: STORAGE_PATH }))
        : Promise.resolve(null));
    const args = baseArgs({
      skipLaunch: true,
      client: {
        executeBatchCommands: jest.fn()
          .mockResolvedValueOnce({ results: [{ data: { installed: true } }] })
          .mockResolvedValueOnce({ results: [{ success: true }] }),
      },
    });

    await MobileAppPrepService.prepApp(args);

    const calls = args.client.executeBatchCommands.mock.calls;
    const resetCall = calls[calls.length - 1];
    const commandTypes = resetCall[1].map((c: any) => c.type);
    // The wipe must happen even though launch is skipped — otherwise the
    // caller's own subsequent launch (attachFlutter) inherits stale app data.
    expect(commandTypes).toContain('close_app');
    expect(resetCall[1][0].params).toEqual(expect.objectContaining({ packageName: PACKAGE, hard: true }));
    expect(commandTypes).not.toContain('launch_app');
  });

  it('branch 2 (device-check fast path): close_app(hard:true) STILL fires when skipLaunch is true', async () => {
    // Warmup expired, but the durable record still names the build we want →
    // falls through branch 1 into branch 2's on-device check.
    redisGet({ installedBuild: STORAGE_PATH });
    const args = baseArgs({
      skipLaunch: true,
      client: {
        executeBatchCommands: jest.fn()
          // branch 2's check_package
          .mockResolvedValueOnce({ results: [{ data: { installed: true } }] })
          .mockResolvedValueOnce({ results: [{ success: true }] }),
      },
    });

    await MobileAppPrepService.prepApp(args);

    const calls = args.client.executeBatchCommands.mock.calls;
    const resetCall = calls[calls.length - 1];
    const commandTypes = resetCall[1].map((c: any) => c.type);
    expect(commandTypes).toEqual(['close_app']);
  });

  it('branch 2 (device-check fast path): close_app(hard:true) AND launch_app both fire when skipLaunch is false', async () => {
    redisGet({ installedBuild: STORAGE_PATH });
    const args = baseArgs({
      client: {
        executeBatchCommands: jest.fn()
          .mockResolvedValueOnce({ results: [{ data: { installed: true } }] })
          .mockResolvedValueOnce({ results: [{ success: true }, { success: true }] }),
      },
    });

    await MobileAppPrepService.prepApp(args);

    const calls = args.client.executeBatchCommands.mock.calls;
    const resetCall = calls[calls.length - 1];
    const commandTypes = resetCall[1].map((c: any) => c.type);
    expect(commandTypes).toEqual(['close_app', 'launch_app']);
  });
});

describe('MobileAppPrepService.prepApp — Flutter host-lane artifact resolution', () => {
  const defaultVariant = MobileAppStorageService.getProjectDefaultVariant as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(null);
    // No app configured — we only assert which SLOT was queried, which happens
    // before the (empty) install decision.
    mockGetProject.mockResolvedValue({ settings: {} });
    defaultVariant.mockResolvedValue(undefined);
  });

  it('resolves a Flutter test against the IOS slot when hostPlatform is ios', async () => {
    await MobileAppPrepService.prepApp(baseArgs({ platform: 'flutter', hostPlatform: 'ios' }));
    expect(defaultVariant).toHaveBeenCalledWith('project-1', 'ios');
  });

  it('keeps the legacy flutter→android mapping when host is android (unchanged)', async () => {
    await MobileAppPrepService.prepApp(baseArgs({ platform: 'flutter', hostPlatform: 'android' }));
    // 'flutter' is passed through so resolveAppForRun applies its own android mapping.
    expect(defaultVariant).toHaveBeenCalledWith('project-1', 'flutter');
  });

  it('defaults an unset host to the android (flutter) lane', async () => {
    await MobileAppPrepService.prepApp(baseArgs({ platform: 'flutter' }));
    expect(defaultVariant).toHaveBeenCalledWith('project-1', 'flutter');
  });

  it('leaves a non-Flutter iOS test resolving its own ios slot', async () => {
    await MobileAppPrepService.prepApp(baseArgs({ platform: 'ios' }));
    expect(defaultVariant).toHaveBeenCalledWith('project-1', 'ios');
  });
});

describe('MobileAppPrepService.prepApp — installed-build identity gates the device fast path', () => {
  const downloadApp = MobileAppStorageService.downloadApp as jest.Mock;

  /** Client that can satisfy the full-install path (branch 3). */
  function installClient() {
    return {
      uploadApp: jest.fn().mockResolvedValue({ path: '/runner/app.apk' }),
      executeBatchCommands: jest.fn().mockResolvedValue({ results: [{ data: { packageName: PACKAGE } }] }),
    };
  }

  const commandTypesOf = (client: { executeBatchCommands: jest.Mock }) =>
    client.executeBatchCommands.mock.calls.flatMap((call) => call[1].map((c: any) => c.type));

  beforeEach(() => {
    jest.clearAllMocks();
    downloadApp.mockResolvedValue(Buffer.from('apk-bytes'));
    mockGetProject.mockResolvedValue({
      settings: { mobileApp: { storagePath: STORAGE_PATH, originalName: 'app.apk', packageName: PACKAGE } },
    });
  });

  it('reinstalls instead of relaunching when nothing records which build is on the device', async () => {
    redisGet(); // no warmup, no durable record — identity unknown
    const client = installClient();

    await MobileAppPrepService.prepApp(baseArgs({ client }));

    expect(downloadApp).toHaveBeenCalledWith(STORAGE_PATH);
    // Presence alone must no longer authorise skipping the install.
    expect(commandTypesOf(client)).not.toContain('check_package');
  });

  it('reinstalls when the recorded build differs from the target, even after the warmup entry expired', async () => {
    // The incident: a previously installed build is still on the device and
    // the warmup entry has expired, so only the durable record can catch it.
    redisGet({ installedBuild: 'apps/com.aitan.inexport/previous-build.apk' });
    const client = installClient();

    await MobileAppPrepService.prepApp(baseArgs({ client }));

    expect(downloadApp).toHaveBeenCalledWith(STORAGE_PATH);
    expect(commandTypesOf(client)).not.toContain('check_package');
    expect(commandTypesOf(client)).toContain('install_app');
  });

  it('records the installed build after a full install even when no warmup entry exists', async () => {
    // Without this the record could never be written in the very case it is
    // meant for, and the fast path would stay blind forever.
    redisGet();

    await MobileAppPrepService.prepApp(baseArgs({ client: installClient() }));

    expect(mockSet).toHaveBeenCalledWith(
      `${INSTALLED_BUILD_KEY_PREFIX}project-1:user-1`,
      STORAGE_PATH,
      'EX',
      expect.any(Number),
    );
  });

  it('relaunches without reinstalling once the durable record confirms the target build', async () => {
    redisGet({ installedBuild: STORAGE_PATH });
    const client = {
      uploadApp: jest.fn(),
      executeBatchCommands: jest.fn()
        .mockResolvedValueOnce({ results: [{ data: { installed: true } }] })
        .mockResolvedValueOnce({ results: [{ success: true }, { success: true }] }),
    };

    await MobileAppPrepService.prepApp(baseArgs({ client }));

    expect(downloadApp).not.toHaveBeenCalled();
    expect(client.uploadApp).not.toHaveBeenCalled();
    expect(commandTypesOf(client)).toEqual(['check_package', 'close_app', 'launch_app']);
  });
});
