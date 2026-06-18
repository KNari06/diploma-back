import {
  resolveDedicatedDevice,
  __resetDedicatedDeviceCacheForTests,
} from '../dedicated-device.service';
import { getActiveDedicatedDevice } from '../db/dedicated-device.db';
import { DedicatedDeviceFeature } from '@/config/features/dedicated-device';

jest.mock('../db/dedicated-device.db', () => ({
  getActiveDedicatedDevice: jest.fn(),
}));
jest.mock('@/config/features/dedicated-device', () => ({
  DedicatedDeviceFeature: { isEnabled: jest.fn() },
}));

const mockDb = getActiveDedicatedDevice as jest.Mock;
const mockFlag = DedicatedDeviceFeature.isEnabled as jest.Mock;

const ANDROID_ROW = { platform: 'android' as const, runnerSerial: '10.0.0.5:5606', runnerUrl: null };

beforeEach(() => {
  jest.clearAllMocks();
  __resetDedicatedDeviceCacheForTests();
  mockFlag.mockReturnValue(true);
});

describe('resolveDedicatedDevice', () => {
  it('returns the device for an android run when an active android row exists', async () => {
    mockDb.mockResolvedValue(ANDROID_ROW);
    const r = await resolveDedicatedDevice('ws-1', 'android');
    expect(r).toEqual({ serial: '10.0.0.5:5606', runnerUrl: null });
  });

  it('maps a flutter run to the android device row', async () => {
    mockDb.mockResolvedValue(ANDROID_ROW);
    const r = await resolveDedicatedDevice('ws-1', 'flutter');
    expect(r).toEqual({ serial: '10.0.0.5:5606', runnerUrl: null });
  });

  it('returns null for ios in v1 (no remote simulator farm) without hitting the db', async () => {
    const r = await resolveDedicatedDevice('ws-1', 'ios');
    expect(r).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  it('returns null when the feature flag is off (no db lookup, zero behaviour change)', async () => {
    mockFlag.mockReturnValue(false);
    const r = await resolveDedicatedDevice('ws-1', 'android');
    expect(r).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  it('returns null when the workspace has no active row', async () => {
    mockDb.mockResolvedValue(null);
    const r = await resolveDedicatedDevice('ws-1', 'android');
    expect(r).toBeNull();
  });

  it('returns null and does not hit the db when workspaceId is missing', async () => {
    const r = await resolveDedicatedDevice(undefined, 'android');
    expect(r).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  it('falls back to null on platform mismatch (ios row, android run)', async () => {
    mockDb.mockResolvedValue({ platform: 'ios', runnerSerial: 'X', runnerUrl: null });
    const r = await resolveDedicatedDevice('ws-1', 'android');
    expect(r).toBeNull();
  });

  it('caches the db result — a second call within TTL does not re-query', async () => {
    mockDb.mockResolvedValue(ANDROID_ROW);
    await resolveDedicatedDevice('ws-1', 'android');
    await resolveDedicatedDevice('ws-1', 'android');
    expect(mockDb).toHaveBeenCalledTimes(1);
  });

  it('caches a null answer too (negative caching)', async () => {
    mockDb.mockResolvedValue(null);
    await resolveDedicatedDevice('ws-1', 'android');
    await resolveDedicatedDevice('ws-1', 'android');
    expect(mockDb).toHaveBeenCalledTimes(1);
  });
});
