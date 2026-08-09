/**
 * Dedicated-emulator-per-workspace resolver (Phase 1).
 *
 * Given a workspace + the platform a run targets, returns the dedicated device
 * to pin to — or null when the workspace has no dedicated device (the common
 * case → caller uses the shared pool).
 *
 * Resolution rules:
 *   - Feature flag off            → null (zero behaviour change).
 *   - No active row / no workspace → null.
 *   - iOS (v1)                    → null. There is no remote iOS simulator
 *     farm; dedicated iOS would only work for physical iPhones (single-user),
 *     which is out of scope for v1. Falls back to shared.
 *   - Platform mismatch           → null. A run's platform must match the
 *     dedicated row's platform (flutter maps to an android device).
 *
 * The map is near-static (ops edits it rarely), so a short TTL in-memory cache
 * avoids a DB round-trip on every session acquisition.
 */

import { logger } from '@/utils/core/logger';
import { DedicatedDeviceFeature } from '@/config/features/dedicated-device';
import { getActiveDedicatedDevices } from './db/dedicated-device.db';
import { MobileRunnerError, type MobilePlatform } from './mobile-runner.types';

export interface ResolvedDedicatedDevice {
  serial: string;
  runnerUrl: string | null;
  runnerApiKey: string | null;
}

const CACHE_TTL_MS = 60_000;

// An empty array is a real "no dedicated device" answer and is cached too.

const _cacheMany = new Map<string, { value: ResolvedDedicatedDevice[]; at: number }>();

/**
 * Map a run's runner platform to the device-table platform.
 * Flutter runs on an Android container, so it shares the 'android' device.
 * Returns null for platforms a dedicated device can't serve in v1 (ios).
 */
function tablePlatformFor(platform: MobilePlatform): 'android' | null {
  if (platform === 'android' || platform === 'flutter') return 'android';
  // ios → no dedicated support in v1.
  return null;
}

/**
 * EVERY device pinned to the workspace for this platform, in a stable order.
 *
 * A workspace may pin more than one so a regression can run while the editor
 * holds the first — the runner rejects a second dedicated session on the same
 * serial with DEVICE_BUSY, which is correct but useless if there is nowhere
 * else to go. Callers walk this list and take the first device that accepts.
 *
 * Returns `[]`, never null, so a caller cannot accidentally treat "no devices"
 * as "one device that happens to be falsy".
 */
export async function resolveDedicatedDevices(
  workspaceId: string | undefined,
  platform: MobilePlatform,
): Promise<ResolvedDedicatedDevice[]> {
  if (!DedicatedDeviceFeature.isEnabled()) return [];
  if (!workspaceId) return [];

  const wantPlatform = tablePlatformFor(platform);
  if (!wantPlatform) return []; // ios (v1) → shared pool

  const cacheKey = `${workspaceId}:${wantPlatform}`;
  const cached = _cacheMany.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const rows = await getActiveDedicatedDevices(workspaceId);

  const resolved: ResolvedDedicatedDevice[] = [];
  const mismatched: string[] = [];
  for (const row of rows) {
    if (row.platform === wantPlatform) {
      resolved.push({
        serial: row.runnerSerial,
        runnerUrl: row.runnerUrl,
        runnerApiKey: row.runnerApiKey,
      });
    } else {
      mismatched.push(row.platform);
    }
  }

  if (mismatched.length > 0 && resolved.length === 0) {
    // Devices exist but none for this platform — log so ops can spot a
    // misprovisioned workspace (e.g. android rows, ios run). Falls back to shared.
    logger.warn('[DEDICATED_DEVICE] Active device platform mismatch — using shared pool', {
      workspaceId,
      devicePlatforms: mismatched,
      runPlatform: platform,
    });
  }

  _cacheMany.set(cacheKey, { value: resolved, at: Date.now() });
  return resolved;
}

/**
 * Create a session on the first pinned device that accepts it.
 *
 * Single-sourced on purpose: three call sites need this walk (the regression
 * job and the editor's two acquisition paths), and three hand-rolled loops
 * would drift on the one subtlety that matters — WHICH errors mean "try the
 * next device".
 *
 * Only `DEVICE_BUSY` advances. Anything else is rethrown at once: a runner
 * that is down, an unreachable host, a bad APK — retrying those on the next
 * device would turn one clear failure into N confusing ones and could land the
 * run on a device the workspace did not intend. When every device is busy the
 * LAST busy error is rethrown, because the runner's message names who holds
 * that device, which is what an operator actually needs.
 */
export async function createOnFirstFreeDedicatedDevice<T>(
  devices: ResolvedDedicatedDevice[],
  create: (device: ResolvedDedicatedDevice) => Promise<T>,
  opts?: {
    /**
     * Waits BETWEEN full passes over the device list. Omit for a single pass —
     * that is what the editor wants: a person is watching, and moving to the
     * next device instantly beats making them stare at a spinner.
     */
    backoffMs?: readonly number[];
    onRetry?: (round: number, waitMs: number) => void;
  },
): Promise<{ result: T; device: ResolvedDedicatedDevice }> {
  if (devices.length === 0) throw new Error('createOnFirstFreeDedicatedDevice called with no devices');

  const backoff = opts?.backoffMs ?? [];
  let lastBusy: unknown;

  // Every device is tried BEFORE any sleeping. Waiting on a busy device while
  // a free one sits next to it is the whole failure this exists to prevent.
  for (let round = 0; ; round++) {
    for (const [i, device] of devices.entries()) {
      try {
        return { result: await create(device), device };
      } catch (err) {
        if (!(err instanceof MobileRunnerError && err.code === 'DEVICE_BUSY')) throw err;
        lastBusy = err;
        logger.info('[DEDICATED_DEVICE] Pinned device busy — trying the next one', {
          serial: device.serial,
          runnerUrl: device.runnerUrl,
          tried: i + 1,
          of: devices.length,
          round,
        });
      }
    }
    if (round >= backoff.length) throw lastBusy;
    const waitMs = backoff[round] ?? 20_000;
    opts?.onRetry?.(round + 1, waitMs);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** Test-only: clear the resolver cache between cases. */
export function __resetDedicatedDeviceCacheForTests(): void {
  _cacheMany.clear();
}
