import { MobileSessionAcquisitionService } from '../session-acquisition.service';
import { resolveDedicatedDevice } from '../dedicated-device.service';
import { claimWarmedSession } from '@/api/mobile/session.controller';

jest.mock('../dedicated-device.service', () => ({
  resolveDedicatedDevice: jest.fn(),
}));
jest.mock('@/api/mobile/session.controller', () => ({
  claimWarmedSession: jest.fn(),
}));
jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitTestProgress: jest.fn() },
}));

const mockResolve = resolveDedicatedDevice as jest.Mock;
const mockWarmed = claimWarmedSession as jest.Mock;

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
    // Pinned with the resolved serial and ownerId=workspaceId.
    expect(client.createSession).toHaveBeenCalledWith('android', {
      deviceSelector: { serial: '10.0.0.5:5606' },
      ownerId: 'ws-1',
      userId: 'user-1',
    });
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
