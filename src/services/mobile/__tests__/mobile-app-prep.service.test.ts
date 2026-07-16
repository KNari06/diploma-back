const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDel = jest.fn();

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
    // No Redis hit at all → falls through branch 1 into branch 2's on-device check.
    mockGet.mockResolvedValue(null);
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
    mockGet.mockResolvedValue(null);
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
