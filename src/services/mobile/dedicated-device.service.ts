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
import { getActiveDedicatedDevice } from './db/dedicated-device.db';
import type { MobilePlatform } from './mobile-runner.types';

export interface ResolvedDedicatedDevice {
  serial: string;
  runnerUrl: string | null;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: ResolvedDedicatedDevice | null; // null is a real "no dedicated device" answer, also cached
  at: number;
}

const _cache = new Map<string, CacheEntry>();

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

export async function resolveDedicatedDevice(
  workspaceId: string | undefined,
  platform: MobilePlatform,
): Promise<ResolvedDedicatedDevice | null> {
  if (!DedicatedDeviceFeature.isEnabled()) return null;
  if (!workspaceId) return null;

  const wantPlatform = tablePlatformFor(platform);
  if (!wantPlatform) return null; // ios (v1) → shared pool

  const cacheKey = `${workspaceId}:${wantPlatform}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const row = await getActiveDedicatedDevice(workspaceId);

  let resolved: ResolvedDedicatedDevice | null = null;
  if (row && row.platform === wantPlatform) {
    resolved = { serial: row.runnerSerial, runnerUrl: row.runnerUrl };
  } else if (row && row.platform !== wantPlatform) {
    // A device exists but for a different platform — log so ops can spot a
    // misprovisioned workspace (e.g. android row, ios run). Falls back to shared.
    logger.warn('[DEDICATED_DEVICE] Active device platform mismatch — using shared pool', {
      workspaceId,
      devicePlatform: row.platform,
      runPlatform: platform,
    });
  }

  _cache.set(cacheKey, { value: resolved, at: Date.now() });
  return resolved;
}

/** Test-only: clear the resolver cache between cases. */
export function __resetDedicatedDeviceCacheForTests(): void {
  _cache.clear();
}
