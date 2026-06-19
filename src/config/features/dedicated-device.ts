import { env } from '@/config/environment/env';

/**
 * Feature flag for dedicated-emulator-per-workspace routing.
 *
 * When enabled, mobile-session acquisition checks `workspace_dedicated_device`
 * and pins the run to the workspace's dedicated runner device, bypassing the
 * shared pool. Default OFF — until a deploy flips it AND ops provisions a
 * container + DB row, the resolver returns null and the shared pool path is
 * unchanged.
 */
export const DedicatedDeviceFeature = {
  isEnabled(): boolean {
    return env.DEDICATED_MOBILE_EMULATOR_ENABLED;
  },
};
