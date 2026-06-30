/**
 * Tests for `getCompanionStatus`'s response contract.
 *
 * Contract:
 *   - Returns { connected, snapshot } for the authenticated user.
 *   - `connected` mirrors companionRegistry.isConnected(userId).
 *   - `snapshot` is the cached device snapshot (or null when none/disconnected).
 *   - Reads the userId from req.user, never the request body (tenancy).
 *
 * The registry singleton is mocked so only the controller logic runs.
 */

jest.mock('@/services/mobile/companion/companion-registry', () => ({
  companionRegistry: {
    isConnected: jest.fn(),
    getDeviceSnapshot: jest.fn(),
  },
}));
jest.mock('@/services/mobile/companion/companion-auth.service', () => ({
  CompanionAuthService: {},
  RevokedDeviceError: class extends Error {},
  InvalidPairingCodeError: class extends Error {},
  InvalidRefreshTokenError: class extends Error {},
}));

import { companionRegistry } from '@/services/mobile/companion/companion-registry';
import { getCompanionStatus } from '../companion.controller';

const isConnectedMock = companionRegistry.isConnected as jest.Mock;
const getSnapshotMock = companionRegistry.getDeviceSnapshot as jest.Mock;

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq(userId = 'user-1') {
  return { user: { id: userId } } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getCompanionStatus', () => {
  it('returns connected:true with the cached snapshot when a companion is connected', async () => {
    const snapshot = { timestamp: 't1', devices: [{ id: 'd1', source: 'local-physical' }] };
    isConnectedMock.mockReturnValue(true);
    getSnapshotMock.mockReturnValue(snapshot);
    const res = makeRes();

    await getCompanionStatus(makeReq('user-1'), res);

    expect(isConnectedMock).toHaveBeenCalledWith('user-1');
    expect(getSnapshotMock).toHaveBeenCalledWith('user-1');
    expect(res.json).toHaveBeenCalledWith({ connected: true, snapshot });
  });

  it('returns connected:false and null snapshot when no companion is connected', async () => {
    isConnectedMock.mockReturnValue(false);
    getSnapshotMock.mockReturnValue(null);
    const res = makeRes();

    await getCompanionStatus(makeReq('user-2'), res);

    expect(res.json).toHaveBeenCalledWith({ connected: false, snapshot: null });
  });

  it('derives the userId from req.user, not the request body', async () => {
    isConnectedMock.mockReturnValue(true);
    getSnapshotMock.mockReturnValue(null);
    const res = makeRes();
    const req = makeReq('owner-real');
    req.body = { userId: 'attacker' };

    await getCompanionStatus(req, res);

    expect(isConnectedMock).toHaveBeenCalledWith('owner-real');
    expect(getSnapshotMock).toHaveBeenCalledWith('owner-real');
  });
});
