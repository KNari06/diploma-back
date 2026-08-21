/**
 * The warmup entry must not vouch for a Flutter attach that never happened.
 *
 * On 2026-08-21 the API container was OOM-killed (exit 137) four times, each
 * within 5-8s of `[MOBILE_APP_PREP] Installing app on session` — a 309 MiB
 * debug APK is downloaded into a Buffer and concatenated into a multipart body
 * inside a 2 GiB container. The kill landed between install and
 * `attachFlutter`.
 *
 * Every failure path in the warmup deletes the Redis entry, but SIGKILL runs
 * no catch block, so the entry survived saying `platform: 'flutter'` while the
 * runner-side session was a plain Android one. The reuse gate compared request
 * against entry, saw flutter == flutter and the right host, and took the
 * skip-re-prep branch. The editor got a session with no Dart VM Service: a
 * Point pick walked the native tree, found the FlutterView's container, and
 * returned `FrameLayout` as the step's INTENT. The run failed ~20s later
 * inside resolve, with nothing pointing at the crash.
 *
 * `flutterAttachPending` makes the entry honest across a crash: set when the
 * session is created, cleared only once attach returns. Same harness as
 * mobile-warmup-flutter-host.test.ts — collaborators mocked, the controller's
 * own gate under test.
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
  // Host-lane routing: unset iOS URL → both hosts resolve to the env runner,
  // so warmup keeps using the getMobileRunnerClient() singleton above.
  resolveRunnerUrlForHost: jest.fn(() => 'http://runner.local:4100'),
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

// `resolveDedicatedDevices` is PLURAL and returns a list — the multi-device work
// renamed it, and this mock kept the old singular `resolveDedicatedDevice`. The
// stub therefore didn't cover the name the controller actually calls, and every
// test here died on `TypeError: resolveDedicatedDevices is not a function` at
// session.controller.ts:513. Nothing caught it because the backend has no CI
// gate yet — this is exactly the rot the gate exists to stop.
// Keep the shape in step with the real module's exports, not with its history.
jest.mock('@/services/mobile/dedicated-device.service', () => ({
  resolveDedicatedDevices: jest.fn(async () => []),
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
jest.mock('@/services/mobile/project-mobile-app.helper', () => ({
  // Keep the real pure host/variant resolvers (resolveFlutterHost,
  // getFlutterDefaultHost, getDefaultVariantLabel, normaliseHostOverride) — the
  // warmup + auto-boot paths call them; only the app-slot reader is stubbed.
  ...jest.requireActual('@/services/mobile/project-mobile-app.helper'),
  getProjectMobileApp: jest.fn(),
}));

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
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload: unknown) => { res.body = payload; return res; });
  return res;
}

/** Every JSON body written to the warmup key, in order. */
function warmupWrites(): WarmupData[] {
  return (redisConnection.set as jest.Mock).mock.calls
    .filter((c) => c[0] === redisKey)
    .map((c) => JSON.parse(c[1] as string) as WarmupData);
}

function lastWarmupWrite(): WarmupData | null {
  const w = warmupWrites();
  return w.length ? w[w.length - 1] : null;
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

const flutterReq = () => mkReq({ projectId: PROJECT_ID, platform: 'flutter' });

describe('warmupSession — flutterAttachPending', () => {
  it('marks the entry pending before attach and clears it once attach returns', async () => {
    mockRunnerClient.claimSession.mockResolvedValue({ sessionId: 'sess-1' });

    const res = mkRes();
    await warmupSession(flutterReq(), res);

    // The entry written before prep/attach must be self-describing as
    // incomplete — this is the value a SIGKILL would leave behind.
    expect(warmupWrites()[0]).toMatchObject({
      sessionId: 'sess-1',
      platform: 'flutter',
      flutterAttachPending: true,
    });

    // After a successful attach the flag is GONE (not `false` — absent, so the
    // gate's `=== true` reads the same for new and legacy entries).
    expect(mockRunnerClient.attachFlutter).toHaveBeenCalled();
    expect(lastWarmupWrite()).not.toHaveProperty('flutterAttachPending');
    expect(res.statusCode).toBe(201);
  });

  it('never marks a non-Flutter warmup pending', async () => {
    mockRunnerClient.claimSession.mockResolvedValue({ sessionId: 'sess-android' });

    await warmupSession(mkReq({ projectId: PROJECT_ID, platform: 'android' }), mkRes());

    expect(mockRunnerClient.attachFlutter).not.toHaveBeenCalled();
    for (const w of warmupWrites()) expect(w).not.toHaveProperty('flutterAttachPending');
  });

  it('does not reuse a Flutter entry whose attach never completed', async () => {
    // Exactly what the OOM left behind: platform and host both correct, so the
    // pre-existing mismatch gates cannot see anything wrong with it.
    mockRedisStore.set(redisKey, JSON.stringify({
      sessionId: 'orphaned-sess',
      runnerUrl: 'http://runner.local:4100',
      runnerSocketUrl: 'ws://runner.local:4100',
      platform: 'flutter',
      hostPlatform: 'android',
      flutterAttachPending: true,
      createdAt: new Date().toISOString(),
    } satisfies WarmupData));
    mockRunnerClient.sessionExists.mockResolvedValue(true);
    mockRunnerClient.claimSession.mockResolvedValue({ sessionId: 'fresh-sess' });

    const res = mkRes();
    await warmupSession(flutterReq(), res);

    expect(mockRunnerClient.destroySession).toHaveBeenCalledWith('orphaned-sess', { userId: USER_ID });
    expect(res.body).toMatchObject({ sessionId: 'fresh-sess', reused: false });
    // The replacement went through a real attach.
    expect(mockRunnerClient.attachFlutter).toHaveBeenCalledWith(
      'fresh-sess', { packageName: 'com.demo.app' }, { userId: USER_ID },
    );
  });

  it('still reuses a Flutter entry that did complete its attach', async () => {
    // Regression guard: the new gate must not cost a recreate on the happy
    // path. A legacy entry predating this field has no flag at all.
    mockRedisStore.set(redisKey, JSON.stringify({
      sessionId: 'good-sess',
      runnerUrl: 'http://runner.local:4100',
      runnerSocketUrl: 'ws://runner.local:4100',
      platform: 'flutter',
      hostPlatform: 'android',
      createdAt: new Date().toISOString(),
    } satisfies WarmupData));
    mockRunnerClient.sessionExists.mockResolvedValue(true);

    const res = mkRes();
    await warmupSession(flutterReq(), res);

    expect(mockRunnerClient.destroySession).not.toHaveBeenCalled();
    expect(mockRunnerClient.claimSession).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ sessionId: 'good-sess', reused: true });
  });

  it('does not clear the flag when a concurrent warmup has taken over the key', async () => {
    // The warmup lock is released before prep, so a second warmup can replace
    // the entry while the first is still attaching. Clearing unconditionally
    // would vouch for an attach that never happened for the NEW session.
    mockRunnerClient.claimSession.mockResolvedValue({ sessionId: 'sess-slow' });
    mockRunnerClient.attachFlutter.mockImplementation(async () => {
      mockRedisStore.set(redisKey, JSON.stringify({
        sessionId: 'sess-from-other-warmup',
        runnerUrl: 'http://runner.local:4100',
        runnerSocketUrl: 'ws://runner.local:4100',
        platform: 'flutter',
        hostPlatform: 'android',
        flutterAttachPending: true,
        createdAt: new Date().toISOString(),
      } satisfies WarmupData));
    });

    await warmupSession(flutterReq(), mkRes());

    const stored = JSON.parse(mockRedisStore.get(redisKey)!) as WarmupData;
    expect(stored.sessionId).toBe('sess-from-other-warmup');
    expect(stored.flutterAttachPending).toBe(true);
  });
});
