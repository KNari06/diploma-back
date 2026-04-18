/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Resource Mutex — per-resource serialization for heal / refresh
 *
 * Why:
 *   Two parallel tests bind to Admin login. Session dies at 12:00 for both
 *   simultaneously. Without coordination each triggers its own recipe
 *   replay → two concurrent logins → app rate-limits OR newer state
 *   overwrites older state mid-flight.
 *
 * What:
 *   Per-process, per-resource_id promise chain. First caller runs the
 *   critical section; later callers await the same promise, then no-op
 *   (they re-read fresh state and move on).
 *
 * Scope:
 *   In-memory only. A single backend process owns all jobs for a given
 *   resource right now (BullMQ worker affinity is not resource-aware),
 *   so an in-memory map is sufficient. If we ever shard by user across
 *   processes, move to Redis SETNX.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding the per-resource lock. Subsequent callers for the
 * same resourceId wait for this one to finish before starting (FIFO).
 *
 * The mutex itself never leaks memory: once the chain resolves we drop
 * the entry so idle resources don't retain closures.
 */
export async function withResourceMutex<T>(
  resourceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(resourceId) ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Queue this invocation behind any in-flight one. We store `gate`
  // (not the `fn` promise) so later callers wait only for our critical
  // section, not for their own fn to finish before the *next* caller
  // starts. Keep a reference to the EXACT promise we put in the map
  // so the cleanup compare in finally works (prev.then(...) returns a
  // new promise each call).
  const tail = prev.then(() => gate);
  chains.set(resourceId, tail);

  try {
    await prev;
    return await fn();
  } catch (err) {
    logger.debug('[RESOURCE_MUTEX] protected section threw', {
      resourceId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    release();
    // If we're still the tail of the chain, clear the entry to avoid
    // retaining the resolved promise forever.
    if (chains.get(resourceId) === tail) {
      chains.delete(resourceId);
    }
  }
}
