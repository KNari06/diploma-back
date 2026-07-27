/**
 * TrackerRegistry — the single source of truth for which task trackers exist.
 *
 * Replaces the 4 unsynced Jira/provider allowlists (DB CHECK, TS union, two
 * controller arrays) with one registry. Adding a tracker = register one provider
 * here; validation, "supported?" checks, and dispatch all read from this.
 */

import { logger } from '@/utils/core/logger';
import type { TrackerProvider } from '@/types/tracker.types';
import type { TaskTrackerProvider } from './tracker-provider.interface';

const providers = new Map<string, TaskTrackerProvider>();

export const TrackerRegistry = {
  /** Register a provider implementation (called once at module load per provider). */
  register(impl: TaskTrackerProvider): void {
    if (providers.has(impl.provider)) {
      logger.warn('[TRACKER_REGISTRY] provider re-registered, overwriting', { provider: impl.provider });
    }
    providers.set(impl.provider, impl);
  },

  /** Get a provider or throw a clear error (unknown/unsupported tracker). */
  get(provider: TrackerProvider): TaskTrackerProvider {
    const impl = providers.get(provider);
    if (!impl) {
      throw new Error(`Unsupported task tracker: "${provider}". Supported: ${this.list().join(', ') || 'none'}`);
    }
    return impl;
  },

  /** Get a provider or null (for soft checks without throwing). */
  tryGet(provider: TrackerProvider): TaskTrackerProvider | null {
    return providers.get(provider) ?? null;
  },

  /** True if a tracker is supported (replaces the hardcoded allowlists). */
  isSupported(provider: string): boolean {
    return providers.has(provider);
  },

  /** All registered provider ids. */
  list(): string[] {
    return [...providers.keys()];
  },
};
