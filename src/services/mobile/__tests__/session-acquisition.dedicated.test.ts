import { MobileSessionAcquisitionService } from '../session-acquisition.service';
import { resolveDedicatedDevice } from '../dedicated-device.service';
import { DedicatedDeviceFeature } from '@/config/features/dedicated-device';
import { claimWarmedSession } from '@/api/mobile/session.controller';
import { logger } from '@/utils/core/logger';
import { storeSessionRunnerBinding, getSessionRunnerBinding } from '../session-runner-routing';

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
