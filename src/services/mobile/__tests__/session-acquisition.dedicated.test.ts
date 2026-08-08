import { MobileSessionAcquisitionService } from '../session-acquisition.service';
import { resolveDedicatedDevice } from '../dedicated-device.service';
import { DedicatedDeviceFeature } from '@/config/features/dedicated-device';
import { claimWarmedSession } from '@/api/mobile/session.controller';
import { logger } from '@/utils/core/logger';
import { storeSessionRunnerBinding, getSessionRunnerBinding } from '../session-runner-routing';
import { MobileRunnerError } from '../mobile-runner.types';

jest.mock('../dedicated-device.service', () => ({
  resolveDedicatedDevice: jest.fn(),
}));
jest.mock('@/config/features/dedicated-device', () => ({
  DedicatedDeviceFeature: { isEnabled: jest.fn() },
}));
jest.mock('@/api/mobile/session.controller', () => ({
  claimWarmedSession: jest.fn(),
}));
jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitTestProgress: jest.fn() },
}));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('../session-runner-routing', () => ({
  storeSessionRunnerBinding: jest.fn().mockResolvedValue(undefined),
  getSessionRunnerBinding: jest.fn().mockResolvedValue(null),
}));
// Capture the runner a dedicated session is CREATED on. The whole point of the
// dedicated path is that this must be the workspace's own runner, not the job's
// shared-runner default.
const mockDedicatedCtor = jest.fn();
const mockDedicatedCreateSession = jest.fn();
jest.mock('../mobile-runner-client', () => ({
  MobileRunnerClient: jest.fn().mockImplementation((cfg) => {
    mockDedicatedCtor(cfg);
    return { createSession: mockDedicatedCreateSession, claimSession: jest.fn() };
  }),
}));

const mockResolve = resolveDedicatedDevice as jest.Mock;
const mockFlag = DedicatedDeviceFeature.isEnabled as jest.Mock;
const mockWarmed = claimWarmedSession as jest.Mock;
const mockWarn = logger.warn as jest.Mock;
const mockStoreBinding = storeSessionRunnerBinding as jest.Mock;
const mockGetBinding = getSessionRunnerBinding as jest.Mock;

function makeClient() {
  return {
    claimSession: jest.fn(),
    createSession: jest.fn(),
  };
}

const baseParams = (client: ReturnType<typeof makeClient>) => ({
  client: client as never,
  testId: 'test-1',
  platform: 'android' as const,
  browser: 'mobile-android',
  userId: 'user-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  chatSessionId: undefined,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('acquireSession — dedicated intercept', () => {
  it('pins to the dedicated device and skips pool/warmup/cold', async () => {
    mockResolve.mockResolvedValue({ serial: '10.0.0.5:5606', runnerUrl: null });
    const client = makeClient();
    client.createSession.mockResolvedValue({ sessionId: 'sess-ded' });

    const r = await MobileSessionAcquisitionService.acquireSession(baseParams(client));

    expect(r.sessionId).toBe('sess-ded');
    expect(r.sessionSource).toBe('dedicated');
    expect(r.coldStartUsed).toBe(false);
    // Pinned with the resolved serial, ownerId=workspaceId, and the dedicated
    // flag so the runner excludes it from TTL/eviction + applies the serial lock.
    expect(client.createSession).toHaveBeenCalledWith('android', {
      deviceSelector: { serial: '10.0.0.5:5606' },
      ownerId: 'ws-1',
      userId: 'user-1',
      dedicated: true,
    });
    // Binding stored so getMobileRunnerClientForSession resolves the dedicated runner.
    expect(mockStoreBinding).toHaveBeenCalledWith(
      'sess-ded',
      { runnerUrl: null, runnerApiKey: undefined },
      900,
    );
    // The shared ladder is never touched.
    expect(client.claimSession).not.toHaveBeenCalled();
    expect(mockWarmed).not.toHaveBeenCalled();
  });

  it('does NOT fall back to the shared pool when the dedicated create fails', async () => {
    mockResolve.mockResolvedValue({ serial: '10.0.0.5:5606', runnerUrl: null });
    const client = makeClient();
    client.createSession.mockRejectedValue(new Error('dedicated container down'));

    await expect(
      MobileSessionAcquisitionService.acquireSession(baseParams(client)),
    ).rejects.toThrow(/dedicated container down/);

    expect(client.claimSession).not.toHaveBeenCalled();
    expect(mockWarmed).not.toHaveBeenCalled();
  });

  it('falls through to the normal ladder when there is no dedicated device', async () => {
    mockResolve.mockResolvedValue(null);
    const client = makeClient();
    client.claimSession.mockResolvedValue({ sessionId: 'sess-pool' });

    const r = await MobileSessionAcquisitionService.acquireSession(baseParams(client));

    expect(r.sessionSource).toBe('pool');
    expect(r.sessionId).toBe('sess-pool');
    expect(client.claimSession).toHaveBeenCalledTimes(1);
  });
});

describe('acquireSession — warmup runner-binding refresh', () => {
  // Falls through the dedicated intercept (flag off) to the shared ladder, pool
  // claim fails, a matching warmed session is claimed.
  function warmupScenario(binding: unknown) {
    mockFlag.mockReturnValue(false); // no dedicated intercept
    mockGetBinding.mockResolvedValue(binding);
    const client = makeClient();
    client.claimSession.mockRejectedValue(new Error('pool empty'));
    mockWarmed.mockResolvedValue({ sessionId: 'warm-1', platform: 'android' });
    return client;
  }

  it('re-stores an existing binding (companion/dedicated-URL warmup) with a fresh TTL', async () => {
    const binding = { kind: 'companion', userId: 'user-1' };
    const client = warmupScenario(binding);

    const r = await MobileSessionAcquisitionService.acquireSession(baseParams(client));

    expect(r.sessionSource).toBe('warmup');
    expect(mockGetBinding).toHaveBeenCalledWith('warm-1');
    expect(mockStoreBinding).toHaveBeenCalledWith('warm-1', binding, 900);
  });

  it('does NOT store a binding for a shared-pool warmup (no binding present)', async () => {
    const client = warmupScenario(null);

    const r = await MobileSessionAcquisitionService.acquireSession(baseParams(client));

    expect(r.sessionSource).toBe('warmup');
    expect(mockGetBinding).toHaveBeenCalledWith('warm-1');
    expect(mockStoreBinding).not.toHaveBeenCalled();
  });

  it('does not fail the run if the binding refresh throws', async () => {
    const client = warmupScenario({ kind: 'companion', userId: 'user-1' });
    mockStoreBinding.mockRejectedValueOnce(new Error('redis down'));

    const r = await MobileSessionAcquisitionService.acquireSession(baseParams(client));

    expect(r.sessionSource).toBe('warmup');
    expect(r.sessionId).toBe('warm-1');
  });
});

describe('acquireSession — dedicated observability (Phase 7 log-only)', () => {
  it('warns when the feature is ON but no device resolves (silent routing breakage)', async () => {
    mockFlag.mockReturnValue(true);
    mockResolve.mockResolvedValue(null);
    const client = makeClient();
    client.claimSession.mockResolvedValue({ sessionId: 'sess-pool' });

    await MobileSessionAcquisitionService.acquireSession(baseParams(client));

    const warned = mockWarn.mock.calls.some(([msg]) =>
      String(msg).includes('Dedicated feature on but no device resolved'),
    );
    expect(warned).toBe(true);
  });

  it('does NOT warn when the feature is OFF (default deploy — fall-through is expected)', async () => {
    mockFlag.mockReturnValue(false);
    mockResolve.mockResolvedValue(null);
    const client = makeClient();
    client.claimSession.mockResolvedValue({ sessionId: 'sess-pool' });

    await MobileSessionAcquisitionService.acquireSession(baseParams(client));

    const warned = mockWarn.mock.calls.some(([msg]) =>
      String(msg).includes('Dedicated feature on but no device resolved'),
    );
    expect(warned).toBe(false);
  });

  it('does NOT warn for ios (expected fall-through — no dedicated iOS in v1)', async () => {
    mockFlag.mockReturnValue(true);
    mockResolve.mockResolvedValue(null);
    const client = makeClient();
    client.claimSession.mockResolvedValue({ sessionId: 'sess-pool' });

    await MobileSessionAcquisitionService.acquireSession({ ...baseParams(client), platform: 'ios' as const });

    const warned = mockWarn.mock.calls.some(([msg]) =>
      String(msg).includes('Dedicated feature on but no device resolved'),
    );
    expect(warned).toBe(false);
  });
});

// ─── DEVICE_BUSY retry ────────────────────────────────────────────────────────
// The runner's per-serial guard rejects a second session on a workspace's
// container expecting the caller to come back; the client's generic retry loop
// skips coded 409s, so this is the only place that retry can live. A dedicated
// workspace really can overlap two runs — MOBILE_WORKER_CONCURRENCY defaults
// to 2, so a plan with two mobile tests dispatches both at once.

describe('acquireSession — dedicated DEVICE_BUSY retry', () => {
  const busy = () => new MobileRunnerError('Dedicated device is busy', 409, 'DEVICE_BUSY');

  beforeEach(() => {
    jest.useFakeTimers();
    mockResolve.mockResolvedValue({ serial: '10.0.0.5:5606', runnerUrl: null });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries a busy dedicated device and uses the session it eventually gets', async () => {
    const client = makeClient();
    client.createSession
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce({ sessionId: 'sess-ded' });

    const promise = MobileSessionAcquisitionService.acquireSession(baseParams(client));
    await jest.advanceTimersByTimeAsync(10_000);
    const r = await promise;

    expect(r.sessionId).toBe('sess-ded');
    expect(r.sessionSource).toBe('dedicated');
    expect(client.createSession).toHaveBeenCalledTimes(2);
    // Never silently downgraded to the shared pool — that would break the
    // isolation the dedicated container exists to provide.
    expect(client.claimSession).not.toHaveBeenCalled();
  });

  it('gives up after the retry budget and surfaces DEVICE_BUSY', async () => {
    const client = makeClient();
    client.createSession.mockRejectedValue(busy());

    const promise = MobileSessionAcquisitionService.acquireSession(baseParams(client));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    await jest.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(client.createSession).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient device failure', async () => {
    const client = makeClient();
    client.createSession.mockRejectedValue(
      new MobileRunnerError('Device never came up', 503, 'DEVICE_INIT_FAILED'),
    );

    await expect(
      MobileSessionAcquisitionService.acquireSession(baseParams(client)),
    ).rejects.toMatchObject({ code: 'DEVICE_INIT_FAILED' });

    expect(client.createSession).toHaveBeenCalledTimes(1);
  });
});

// ─── The session must be born on the workspace's own runner ──────────────────
// The job's default client is the SHARED runner (the dispatcher never reads the
// dedicated row), but tier-0 binds later calls to `dedicated.runnerUrl`. Create
// on one host + use on another = `SESSION_RECLAIMED: session not found` on the
// first install/attach call, which is what a dedicated regression run hit live
// on 2026-08-08 once DEVICE_BUSY stopped masking it.

describe('acquireSession — dedicated create targets the workspace runner', () => {
  it('creates on the dedicated runner_url rather than the job default client', async () => {
    mockResolve.mockResolvedValue({
      serial: '127.0.0.1:5600',
      runnerUrl: 'https://cell1.qait.dev',
      runnerApiKey: 'cell-key',
    });
    const client = makeClient();
    mockDedicatedCreateSession.mockResolvedValue({ sessionId: 'sess-ded' });

    const r = await MobileSessionAcquisitionService.acquireSession(baseParams(client));

    expect(r.sessionSource).toBe('dedicated');
    // A client was built for the workspace's OWN runner, with the row's key...
    expect(mockDedicatedCtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://cell1.qait.dev', apiKey: 'cell-key' }),
    );
    // ...and that is the client the session was created on.
    expect(mockDedicatedCreateSession).toHaveBeenCalledTimes(1);
    // The caller's (shared-runner) client must NOT have been used to create.
    expect(client.createSession).not.toHaveBeenCalled();
    // ...and the binding stored must be the same runner we created on, or the
    // job's later calls would go somewhere the session does not exist.
    expect(mockStoreBinding).toHaveBeenCalledWith(
      'sess-ded',
      expect.objectContaining({ runnerUrl: 'https://cell1.qait.dev' }),
      expect.any(Number),
    );
  });

  it('falls back to the caller client when the row carries no runner_url', async () => {
    mockResolve.mockResolvedValue({ serial: '127.0.0.1:5600', runnerUrl: null });
    const client = makeClient();
    client.createSession.mockResolvedValue({ sessionId: 'sess-ded' });

    await MobileSessionAcquisitionService.acquireSession(baseParams(client));

    // A null runner_url means "the default runner serves this device".
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(mockDedicatedCtor).not.toHaveBeenCalled();
  });
});
