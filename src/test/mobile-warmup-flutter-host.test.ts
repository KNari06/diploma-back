/**
 * Integration coverage for the Flutter HOST lane in the mobile warmup
 * controller (`src/api/mobile/session.controller.ts`).
 *
 * Two behaviours locked here (both introduced by the iOS-simulator Flutter
 * parity feature):
 *
 *  1. A `platform: 'flutter'` + `hostPlatform: 'ios'` warmup with no
 *     deviceSelector must create the underlying session on the IOS host
 *     (`sessionCreatePlatform === 'ios'`), default the deviceSelector to
 *     `{ source: 'local-emulator' }` (simulator, never a hot-plugged iPhone),
 *     and persist `hostPlatform: 'ios'` so the reuse gate can tell the hosts
 *     apart later.
 *
 *  2. A cached Flutter-on-iOS session must NOT be reused for an android-host
 *     Flutter request — both report `platform: 'flutter'`, so only the
 *     recorded `hostPlatform` distinguishes them. The gate must invalidate the
 *     cached session (drop the Redis pointer + destroy on the runner) and
 *     create fresh.
 *
 * These exercise the controller flow directly (mock req/res) rather than over
 * HTTP: supertest is not a dependency here, and mounting the full app would
 * pull in the entire route/service graph. Every external collaborator (runner
 * client, Redis, project/app services) is mocked; the controller's own
 * host-lane + reuse-gate logic is what's under test.
 */

import type { Request, Response } from 'express';

// ── Module mocks ────────────────────────────────────────────────────────────
// Env: enable mobile testing + provide a runner URL. Overrides the broad
// default in jest.setup.ts for this file.
jest.mock('@/config/environment/env', () => ({
  env: {
    NODE_ENV: 'test',
    MOBILE_RUNNER_ENABLED: true,
    MOBILE_RUNNER_URL: 'http://runner.local:4100',
    MOBILE_RUNNER_API_KEY: '',
    MOBILE_MULTI_USER_ISOLATION: false,
  },
  isDevelopment: false,
  isProduction: false,
}));

// The runner client: one fake instance returned by every accessor. Prefixed
// with `mock` so jest's factory-hoist allows the reference.
const mockRunnerClient = {
  isHealthy: jest.fn(),
  claimSession: jest.fn(),
  createSession: jest.fn(),
  sessionExists: jest.fn(),
  destroySession: jest.fn(),
  attachFlutter: jest.fn(),
};

jest.mock('@/services/mobile/mobile-runner-client', () => ({
  getMobileRunnerClient: jest.fn(() => mockRunnerClient),
  MobileRunnerClient: class {},
}));

// In-memory Redis backing the warmup key + lock. NX honoured so lock
// acquisition behaves like production.
const mockRedisStore = new Map<string, string>();
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    set: jest.fn(async (key: string, val: string, ...rest: unknown[]) => {
      if (rest.includes('NX') && mockRedisStore.has(key)) return null;
      mockRedisStore.set(key, val);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => (mockRedisStore.has(key) ? mockRedisStore.get(key)! : null)),
    del: jest.fn(async (key: string) => (mockRedisStore.delete(key) ? 1 : 0)),
    eval: jest.fn(async () => 1),
  },
  QueueManager: {},
}));

jest.mock('@/services/mobile/session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(async () => mockRunnerClient),
  storeSessionRunnerBinding: jest.fn(async () => undefined),
  clearSessionRunnerBinding: jest.fn(async () => undefined),
  runnerUrlToSocketUrl: jest.fn((u: string) => u.replace(/^http/, 'ws')),
}));

jest.mock('@/services/mobile/dedicated-device.service', () => ({
  resolveDedicatedDevice: jest.fn(async () => null),
}));

jest.mock('@/services/core/project.service', () => ({
  ProjectService: { getProject: jest.fn(async () => ({ id: 'proj-1', workspace_id: 'ws-1' })) },
}));

jest.mock('@/services/mobile/mobile-app-prep.service', () => ({
  MobileAppPrepService: { prepApp: jest.fn(async () => 'com.demo.app') },
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: { getDetectedFramework: jest.fn(async () => undefined) },
}));

jest.mock('@/services/mobile/permission-policy.service', () => ({
  applyProjectPolicyToSession: jest.fn(async () => undefined),
}));

jest.mock('@/config/features/companion', () => ({
  CompanionFeature: { isEnabled: jest.fn(() => false) },
}));

jest.mock('@/services/mobile/companion/companion-registry', () => ({
  companionRegistry: { isConnected: jest.fn(async () => false) },
}));

jest.mock('@/services/mobile/companion/companion-runner-client', () => ({
  CompanionRunnerClient: class {},
}));

jest.mock('@/services/mobile/mobile-idle.service', () => ({
  refreshIdle: jest.fn(),
  cancelIdle: jest.fn(),
}));

jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitToUser: jest.fn() },
}));

jest.mock('@/websocket/core/server', () => ({
  getIO: jest.fn(() => ({})),
}));

// Trace/editor helpers pulled in by the controller module but unused on the
// warmup path — stub so importing the controller doesn't drag in heavy deps.
jest.mock('@/services/testing/ui/preview/editor-trace.service', () => ({ EditorTraceService: {} }));
jest.mock('@/services/testing/ui/preview/editor-trace-upload', () => ({
  uploadEditorTrace: jest.fn(),
  closeAndUploadEditorTrace: jest.fn(),
}));
jest.mock('@/services/mobile/project-mobile-app.helper', () => ({ getProjectMobileApp: jest.fn() }));

// ── Imports (after mocks) ───────────────────────────────────────────────────
import { warmupSession, WARMUP_PREFIX, type WarmupData } from '@/api/mobile/session.controller';
import { redisConnection } from '@/config/infrastructure/queues';

// ── Helpers ─────────────────────────────────────────────────────────────────

const USER_ID = 'user-1';
const PROJECT_ID = 'proj-1';
const redisKey = `${WARMUP_PREFIX}${PROJECT_ID}:${USER_ID}`;

function mkReq(body: Record<string, unknown>): Request {
  return { user: { id: USER_ID }, body } as unknown as Request;
}

function mkRes(): Response & { statusCode: number; body: any } {
  const res: any = { statusCode: 200 };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: unknown) => {
    res.body = payload;
    return res;
  });
  return res;
}

/** Find the JSON persisted to the warmup Redis key (last write wins). */
function storedWarmupData(): WarmupData | null {
  const setMock = redisConnection.set as jest.Mock;
  const writes = setMock.mock.calls.filter((c) => c[0] === redisKey);
  const last = writes[writes.length - 1];
  return last ? (JSON.parse(last[1] as string) as WarmupData) : null;
}

beforeEach(() => {
  mockRedisStore.clear();
  mockRunnerClient.isHealthy.mockResolvedValue(true);
  mockRunnerClient.claimSession.mockReset();
  mockRunnerClient.createSession.mockReset();
  mockRunnerClient.sessionExists.mockReset();
  mockRunnerClient.destroySession.mockReset().mockResolvedValue(undefined);
  mockRunnerClient.attachFlutter.mockReset().mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('warmupSession — Flutter host=ios lane', () => {
  it('creates the session on the iOS host and defaults deviceSelector to local-emulator', async () => {
    // Pool claim fails → falls to cold createSession, where the defaulted
    // deviceSelector becomes observable.
    mockRunnerClient.claimSession.mockRejectedValue(new Error('pool exhausted'));
    mockRunnerClient.createSession.mockResolvedValue({ sessionId: 'sess-ios-1' });

    const req = mkReq({ projectId: PROJECT_ID, platform: 'flutter', hostPlatform: 'ios' });
    const res = mkRes();
    await warmupSession(req, res);

    // Host lane: the runner session is created for the 'ios' host, not 'flutter'
    // and not 'android'.
    expect(mockRunnerClient.createSession).toHaveBeenCalledWith(
      'ios',
      expect.objectContaining({ deviceSelector: { source: 'local-emulator' } }),
    );
    expect(mockRunnerClient.claimSession).toHaveBeenCalledWith('ios', expect.anything());

    // Flutter attach ran on the freshly created iOS session.
    expect(mockRunnerClient.attachFlutter).toHaveBeenCalledWith(
      'sess-ios-1',
      { packageName: 'com.demo.app' },
      { userId: USER_ID },
    );

    // Response reports the logical 'flutter' platform, fresh (not reused).
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, sessionId: 'sess-ios-1', platform: 'flutter', reused: false });

    // The host is persisted so a later host switch can be detected.
    expect(storedWarmupData()).toMatchObject({ platform: 'flutter', hostPlatform: 'ios' });
  });

  it('does not reuse a cached Flutter-iOS session for an android-host request', async () => {
    // Seed a live cached Flutter session that was warmed on the iOS host.
    const cached: WarmupData = {
      sessionId: 'old-ios-sess',
      runnerUrl: 'http://runner.local:4100',
      runnerSocketUrl: 'ws://runner.local:4100',
      platform: 'flutter',
      hostPlatform: 'ios',
      createdAt: new Date().toISOString(),
    };
    mockRedisStore.set(redisKey, JSON.stringify(cached));
    mockRunnerClient.sessionExists.mockResolvedValue(true); // cached session still alive on the runner

    // Fresh android-host create after the gate invalidates the ios session.
    mockRunnerClient.claimSession.mockResolvedValue({ sessionId: 'new-android-sess' });

    const req = mkReq({ projectId: PROJECT_ID, platform: 'flutter', hostPlatform: 'android' });
    const res = mkRes();
    await warmupSession(req, res);

    // Reuse gate: the wrong-host cached session was invalidated, not reused.
    expect(mockRunnerClient.destroySession).toHaveBeenCalledWith('old-ios-sess', { userId: USER_ID });
    expect(redisConnection.del as jest.Mock).toHaveBeenCalledWith(redisKey);

    // A fresh session was created on the android host and returned.
    expect(mockRunnerClient.claimSession).toHaveBeenCalledWith('android', expect.anything());
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, sessionId: 'new-android-sess', reused: false });
    expect(res.body.sessionId).not.toBe('old-ios-sess');

    // The new session records the android host.
    expect(storedWarmupData()).toMatchObject({ platform: 'flutter', hostPlatform: 'android' });
  });
});
