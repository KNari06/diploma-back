import {
  resolveDedicatedDevices,
  createOnFirstFreeDedicatedDevice,
  __resetDedicatedDeviceCacheForTests,
} from '../dedicated-device.service';
import { getActiveDedicatedDevices } from '../db/dedicated-device.db';
import { DedicatedDeviceFeature } from '@/config/features/dedicated-device';
import { MobileRunnerError } from '../mobile-runner.types';

jest.mock('../db/dedicated-device.db', () => ({
  getActiveDedicatedDevices: jest.fn(),
}));
jest.mock('@/config/features/dedicated-device', () => ({
  DedicatedDeviceFeature: { isEnabled: jest.fn() },
}));

const mockDb = getActiveDedicatedDevices as jest.Mock;
const mockFlag = DedicatedDeviceFeature.isEnabled as jest.Mock;

const ANDROID_ROW = { platform: 'android' as const, runnerSerial: '10.0.0.5:5606', runnerUrl: null, runnerApiKey: null };
const ANDROID_ROW_2 = { platform: 'android' as const, runnerSerial: '10.0.0.5:5608', runnerUrl: null, runnerApiKey: null };
const DEV_1 = { serial: '10.0.0.5:5606', runnerUrl: null, runnerApiKey: null };
const DEV_2 = { serial: '10.0.0.5:5608', runnerUrl: null, runnerApiKey: null };

const busy = () => new MobileRunnerError('Dedicated device is already held', 409, 'DEVICE_BUSY');

beforeEach(() => {
  jest.clearAllMocks();
  __resetDedicatedDeviceCacheForTests();
  mockFlag.mockReturnValue(true);
});

describe('resolveDedicatedDevices', () => {
  it('returns the device for an android run when an active android row exists', async () => {
    mockDb.mockResolvedValue([ANDROID_ROW]);
    await expect(resolveDedicatedDevices('ws-1', 'android')).resolves.toEqual([DEV_1]);
  });

  it('maps a flutter run to the android device row', async () => {
    mockDb.mockResolvedValue([ANDROID_ROW]);
    await expect(resolveDedicatedDevices('ws-1', 'flutter')).resolves.toEqual([DEV_1]);
  });

  // The point of the whole change: a workspace may pin more than one device so a
  // regression can run while the editor holds the first.
  it('returns EVERY pinned device, in db order', async () => {
    mockDb.mockResolvedValue([ANDROID_ROW, ANDROID_ROW_2]);
    await expect(resolveDedicatedDevices('ws-1', 'android')).resolves.toEqual([DEV_1, DEV_2]);
  });

  it('returns an empty list for ios in v1 (no remote simulator farm) without hitting the db', async () => {
    await expect(resolveDedicatedDevices('ws-1', 'ios')).resolves.toEqual([]);
    expect(mockDb).not.toHaveBeenCalled();
  });

  it('returns an empty list when the feature flag is off (no db lookup, zero behaviour change)', async () => {
    mockFlag.mockReturnValue(false);
    await expect(resolveDedicatedDevices('ws-1', 'android')).resolves.toEqual([]);
    expect(mockDb).not.toHaveBeenCalled();
  });

  it('returns an empty list when the workspace has no active row', async () => {
    mockDb.mockResolvedValue([]);
    await expect(resolveDedicatedDevices('ws-1', 'android')).resolves.toEqual([]);
  });

  it('returns an empty list and does not hit the db when workspaceId is missing', async () => {
    await expect(resolveDedicatedDevices(undefined, 'android')).resolves.toEqual([]);
    expect(mockDb).not.toHaveBeenCalled();
  });

  it('drops rows of the wrong platform (ios row, android run)', async () => {
    mockDb.mockResolvedValue([{ platform: 'ios', runnerSerial: 'X', runnerUrl: null }]);
    await expect(resolveDedicatedDevices('ws-1', 'android')).resolves.toEqual([]);
  });

  it('keeps the matching rows when only SOME are the wrong platform', async () => {
    mockDb.mockResolvedValue([{ platform: 'ios', runnerSerial: 'X', runnerUrl: null }, ANDROID_ROW]);
    await expect(resolveDedicatedDevices('ws-1', 'android')).resolves.toEqual([DEV_1]);
  });

  it('caches the db result — a second call within TTL does not re-query', async () => {
    mockDb.mockResolvedValue([ANDROID_ROW]);
    await resolveDedicatedDevices('ws-1', 'android');
    await resolveDedicatedDevices('ws-1', 'android');
    expect(mockDb).toHaveBeenCalledTimes(1);
  });

  it('caches an empty answer too (negative caching)', async () => {
    mockDb.mockResolvedValue([]);
    await resolveDedicatedDevices('ws-1', 'android');
    await resolveDedicatedDevices('ws-1', 'android');
    expect(mockDb).toHaveBeenCalledTimes(1);
  });
});

describe('createOnFirstFreeDedicatedDevice', () => {
  it('uses the first device when it accepts', async () => {
    const create = jest.fn().mockResolvedValue('sess');
    const r = await createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create);
    expect(r).toEqual({ result: 'sess', device: DEV_1 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('moves to the next device when the first is busy', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce('sess');
    const r = await createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create);
    expect(r.device).toEqual(DEV_2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  // The reason every device is tried before any sleeping: waiting on a busy
  // device while a free one sits beside it is the stall this removes.
  it('tries EVERY device before it waits', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce('sess');
    const onRetry = jest.fn();
    await createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create, { backoffMs: [5_000], onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('waits and retries the whole list when all devices are busy', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce('sess');
    const onRetry = jest.fn();
    const r = await createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create, { backoffMs: [1], onRetry });
    expect(r.device).toEqual(DEV_1);
    expect(onRetry).toHaveBeenCalledWith(1, 1);
    expect(create).toHaveBeenCalledTimes(3);
  });

  // A runner that is down must not be retried on someone else's device: that
  // turns one clear failure into N confusing ones.
  it('rethrows a non-busy error immediately without touching the next device', async () => {
    const create = jest.fn().mockRejectedValue(new MobileRunnerError('runner down', 503, 'UNAVAILABLE'));
    await expect(createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create)).rejects.toThrow('runner down');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rethrows the last busy error when every device stays busy', async () => {
    const create = jest.fn().mockRejectedValue(busy());
    await expect(createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create))
      .rejects.toThrow('already held');
    expect(create).toHaveBeenCalledTimes(2);
  });

  // 2026-08-11: a JanaPost regression died on NETWORK_ERROR while its SECOND
  // pinned emulator sat idle and healthy — only DEVICE_BUSY advanced back then.
  // A second device has to protect against a cell being unreachable, not just
  // against contention; unreachable is the more common way a host fails.
  it('moves to the next device when the first cell is unreachable', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(
        new MobileRunnerError('Failed to reach mobile runner: fetch failed', 0, 'NETWORK_ERROR'),
      )
      .mockResolvedValueOnce('sess');
    const r = await createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create);
    expect(r).toEqual({ result: 'sess', device: DEV_2 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('moves on for a gateway status with no runner code (nginx up, runner not)', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(new MobileRunnerError('Bad Gateway', 502))
      .mockResolvedValueOnce('sess');
    const r = await createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create);
    expect(r.device).toEqual(DEV_2);
  });

  // The counterpart, and the reason the `!code` half of the check exists: the
  // RUNNER answers 503 for a real boot failure. Retrying that on every device
  // turns one honest error into N, and delays it by the whole backoff.
  it('does NOT move on for a runner-coded 503 (a real device failure)', async () => {
    const create = jest.fn().mockRejectedValue(
      new MobileRunnerError('Device never came up', 503, 'DEVICE_INIT_FAILED'),
    );
    await expect(createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create))
      .rejects.toThrow('Device never came up');
    expect(create).toHaveBeenCalledTimes(1);
  });

  // A11Y_AGENT_UNAVAILABLE is deliberately NOT skipped: cell2 served it 100% of
  // the time for four hours on 2026-08-10 because its agent APK had never been
  // installed. Failing over would have hidden a broken cell behind a working one.
  it('does NOT move on for A11Y_AGENT_UNAVAILABLE (a broken cell must stay loud)', async () => {
    const create = jest.fn().mockRejectedValue(
      new MobileRunnerError('agent failed to start', 503, 'A11Y_AGENT_UNAVAILABLE'),
    );
    await expect(createOnFirstFreeDedicatedDevice([DEV_1, DEV_2], create))
      .rejects.toThrow('agent failed to start');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
