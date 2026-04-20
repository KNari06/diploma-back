/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Adapter Registry
 *
 * Single source of truth for "which adapter handles which kind". Kept
 * separate from the service so runtime wiring stays explicit and tests
 * can substitute adapters cleanly.
 *
 * Adding a new kind = drop an adapter file, call `registerResourceAdapter`
 * once at module load, and the whole pipeline (service, routes, runner)
 * picks it up without further changes.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import type { ResourceAdapter, ResourceKind } from './types';

const registry = new Map<ResourceKind, ResourceAdapter<any, any>>();

export function registerResourceAdapter(adapter: ResourceAdapter<any, any>): void {
  if (registry.has(adapter.kind)) {
    // Overwrite is allowed (tests may swap), but log so production
    // double-registration doesn't go unnoticed.
    logger.warn('[RESOURCE_REGISTRY] Overwriting existing adapter', { kind: adapter.kind });
  }
  registry.set(adapter.kind, adapter);
}

export function getResourceAdapter(
  kind: ResourceKind,
): ResourceAdapter<any, any> | undefined {
  return registry.get(kind);
}

export function requireResourceAdapter(kind: ResourceKind): ResourceAdapter<any, any> {
  const adapter = registry.get(kind);
  if (!adapter) {
    // Fail fast — running a test with a resource of unknown kind means
    // something shipped a DB row without its adapter. Easier to catch
    // here than debug silent no-ops later.
    throw new Error(`No adapter registered for resource kind '${kind}'`);
  }
  return adapter;
}

export function listRegisteredKinds(): ResourceKind[] {
  return Array.from(registry.keys());
}
