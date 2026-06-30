import { env } from '@/config/environment/env';

/**
 * Feature flag for the per-user companion relay (ADR-0009).
 *
 * When enabled, users can connect their own physical Android device via the
 * companion CLI. The relay accepts outbound companion connections and bridges
 * backend REST + browser device-list events through them. Default OFF until
 * the relay is deployed and the companion CLI is distributed.
 */
export const CompanionFeature = {
  isEnabled(): boolean {
    return env.COMPANION_ENABLED;
  },
};
