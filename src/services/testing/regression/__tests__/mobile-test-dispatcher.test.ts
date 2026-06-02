import { MobileTestDispatcherService } from '../mobile-test-dispatcher.service';
import { ValidationError } from '@/types';
import * as regressionDb from '../db/regression.db';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../db/regression.db', () => ({
  getProjectWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    resolveAppForRun: jest.fn().mockResolvedValue(null),
    // Default: framework unknown → dispatcher keeps the stored platform.
    // Flutter-upgrade behaviour is asserted in its own test below.
    getDetectedFramework: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../intent-step-dispatch.service', () => ({
  normaliseIntentStep: jest.fn((raw: any, i: number) => ({
    id: raw?.id ?? `step_${i + 1}`,
    type: raw?.type ?? 'click',
    description: raw?.description ?? `Step ${i + 1}`,
  })),
}));

jest.mock('@/config/infrastructure/queues', () => ({
  QueueManager: {
    addMobileTestRunJob: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../results/intelligent-test-storage.service', () => ({
  IntelligentTestStorageService: {
    createSessionAnchor: jest.fn().mockResolvedValue('session-anchor-1'),
  },
}));

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {},
  dbAdminService: {
    createTest: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@/services/mobile/mobile-runner.types', () => ({
  buildMetadataFromTestCase: jest.fn().mockReturnValue({}),
}));

jest.mock('@/config/environment/env', () => ({
  env: {
    MOBILE_RUNNER_URL: 'http://runner.local',
    MOBILE_RUNNER_API_KEY: 'key-123',
  },
}));

jest.mock('@/utils/testing/parameter-substitution.utils', () => ({
  applyParameters: jest.fn((steps: any[], _params: any) => steps),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseCase(overrides: Record<string, any> = {}) {
  return {
    id: 'tc-1',
    name: 'Tap login',
    project_id: 'proj-1',
    platform: 'mobile_android',
    steps_json: [
      { id: 's1', type: 'tap', description: 'Tap login button' },
    ],
    resource_bindings: [],
    ...overrides,
  };
}

const { MobileAppStorageService } = jest.requireMock(
  '@/services/storage/mobile-app-storage.service',
);
const { QueueManager } = jest.requireMock('@/config/infrastructure/queues');
const { dbAdminService } = jest.requireMock('@/db/supabase');

beforeEach(() => {
  jest.clearAllMocks();
  (regressionDb.getProjectWorkspaceId as jest.Mock).mockResolvedValue('ws-1');
  MobileAppStorageService.resolveAppForRun.mockResolvedValue(null);
  // Default: framework unknown → no platform upgrade. Reset explicitly each
  // test (clearAllMocks wipes the factory default) so a per-test
  // mockResolvedValueOnce can't bleed into a later test.
  MobileAppStorageService.getDetectedFramework.mockResolvedValue(undefined);
  dbAdminService.createTest.mockResolvedValue(undefined);
  QueueManager.addMobileTestRunJob.mockResolvedValue(undefined);
});

// ── Platform / browser mapping ────────────────────────────────────────────────

describe('platform and browser mapping', () => {
  it('mobile_android → platform=android, browser=mobile-android', async () => {
    await MobileTestDispatcherService.dispatchMobileTest(
      baseCase({ platform: 'mobile_android' }),
      'user-1',
      'manual',
    );
    const jobData = QueueManager.addMobileTestRunJob.mock.calls[0][0];
    expect(jobData.platform).toBe('android');
    expect(jobData.browser).toBe('mobile-android');
  });

  it('mobile_ios → platform=ios, browser=mobile-ios', async () => {
    await MobileTestDispatcherService.dispatchMobileTest(
      baseCase({ platform: 'mobile_ios' }),
      'user-1',
      'manual',
    );
    const jobData = QueueManager.addMobileTestRunJob.mock.calls[0][0];
    expect(jobData.platform).toBe('ios');
    expect(jobData.browser).toBe('mobile-ios');
  });

  it('mobile_flutter → platform=flutter, browser=mobile-flutter', async () => {
    await MobileTestDispatcherService.dispatchMobileTest(
      baseCase({ platform: 'mobile_flutter' }),
      'user-1',
      'manual',
    );
    const jobData = QueueManager.addMobileTestRunJob.mock.calls[0][0];
    expect(jobData.platform).toBe('flutter');
    expect(jobData.browser).toBe('mobile-flutter');
  });

  it('unknown platform → defaults to android / mobile-android', async () => {
    await MobileTestDispatcherService.dispatchMobileTest(
      baseCase({ platform: 'mobile_tvos' }),
      'user-1',
      'manual',
    );
    const jobData = QueueManager.addMobileTestRunJob.mock.calls[0][0];
    expect(jobData.platform).toBe('android');
    expect(jobData.browser).toBe('mobile-android');
  });

  it('upgrades android→flutter when the project app is detected as Flutter', async () => {
    (MobileAppStorageService.getDetectedFramework as jest.Mock).mockResolvedValueOnce('flutter');
    await MobileTestDispatcherService.dispatchMobileTest(
      baseCase({ platform: 'mobile_android' }),
      'user-1',
      'manual',
    );
    const jobData = QueueManager.addMobileTestRunJob.mock.calls[0][0];
    expect(jobData.platform).toBe('flutter');
    expect(jobData.browser).toBe('mobile-flutter');
  });

  it('keeps android when detected framework is not Flutter', async () => {
    (MobileAppStorageService.getDetectedFramework as jest.Mock).mockResolvedValueOnce('android');
    await MobileTestDispatcherService.dispatchMobileTest(
      baseCase({ platform: 'mobile_android' }),
      'user-1',
      'manual',
    );
    const jobData = QueueManager.addMobileTestRunJob.mock.calls[0][0];
    expect(jobData.platform).toBe('android');
    expect(jobData.browser).toBe('mobile-android');
  });

  it('does not downgrade an explicit flutter case even if framework read fails', async () => {
    (MobileAppStorageService.getDetectedFramework as jest.Mock).mockRejectedValueOnce(
      new Error('db down'),
    );
    await MobileTestDispatcherService.dispatchMobileTest(
      baseCase({ platform: 'mobile_flutter' }),
      'user-1',
      'manual',
    );
    const jobData = QueueManager.addMobileTestRunJob.mock.calls[0][0];
    expect(jobData.platform).toBe('flutter');
    expect(jobData.browser).toBe('mobile-flutter');
  });
});

// ── Empty steps_json validation ──────────────────────────────────────────────

describe('steps_json validation', () => {
  it('throws ValidationError before createTest when steps_json is empty', async () => {
    await expect(
      MobileTestDispatcherService.dispatchMobileTest(
        baseCase({ steps_json: [] }),
        'user-1',
        'manual',
      ),
    ).rejects.toThrow(ValidationError);
    expect(dbAdminService.createTest).not.toHaveBeenCalled();
  });

  it('throws ValidationError before createTest when steps_json is null', async () => {
    await expect(
      MobileTestDispatcherService.dispatchMobileTest(
        baseCase({ steps_json: null }),
        'user-1',
        'manual',
      ),
    ).rejects.toThrow(ValidationError);
    expect(dbAdminService.createTest).not.toHaveBeenCalled();
  });
});

// ── App build ID resolution ──────────────────────────────────────────────────

describe('appBuildId in return value', () => {
  it('returns appBuildId=null when resolveAppForRun returns null', async () => {
    MobileAppStorageService.resolveAppForRun.mockResolvedValue(null);
    const result = await MobileTestDispatcherService.dispatchMobileTest(
      baseCase(),
      'user-1',
      'manual',
    );
    expect(result.appBuildId).toBeNull();
  });

  it('returns appBuildId=null when resolvedBuild.id is "legacy-settings"', async () => {
    MobileAppStorageService.resolveAppForRun.mockResolvedValue({
      id: 'legacy-settings',
      storagePath: 'gs://bucket/app.apk',
    });
    const result = await MobileTestDispatcherService.dispatchMobileTest(
      baseCase(),
      'user-1',
      'manual',
    );
    expect(result.appBuildId).toBeNull();
  });

  it('returns the real appBuildId when resolvedBuild has a real id', async () => {
    MobileAppStorageService.resolveAppForRun.mockResolvedValue({
      id: 'build-abc',
      storagePath: 'gs://bucket/app.apk',
    });
    const result = await MobileTestDispatcherService.dispatchMobileTest(
      baseCase(),
      'user-1',
      'manual',
    );
    expect(result.appBuildId).toBe('build-abc');
  });
});

// ── Happy path: return shape ──────────────────────────────────────────────────

describe('happy path', () => {
  it('returns testId (uuid), jobId, and appBuildId=null when no build', async () => {
    const result = await MobileTestDispatcherService.dispatchMobileTest(
      baseCase(),
      'user-1',
      'manual',
    );
    expect(result.testId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.jobId).toBe(`${result.testId}-mobile-android`);
    expect(result.appBuildId).toBeNull();
  });

  it('calls QueueManager.addMobileTestRunJob once', async () => {
    await MobileTestDispatcherService.dispatchMobileTest(baseCase(), 'user-1', 'manual');
    expect(QueueManager.addMobileTestRunJob).toHaveBeenCalledTimes(1);
  });

  it('calls dbAdminService.createTest with the generated testId', async () => {
    const result = await MobileTestDispatcherService.dispatchMobileTest(
      baseCase(),
      'user-1',
      'manual',
    );
    expect(dbAdminService.createTest).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.testId }),
    );
  });

  it('passes analyticsExecutionId to the job data when provided', async () => {
    await MobileTestDispatcherService.dispatchMobileTest(
      baseCase(),
      'user-1',
      'manual',
      undefined,
      undefined,
      'exec-id-123',
    );
    const jobData = QueueManager.addMobileTestRunJob.mock.calls[0][0];
    expect(jobData.analyticsExecutionId).toBe('exec-id-123');
  });
});
