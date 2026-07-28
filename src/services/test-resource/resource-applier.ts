/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Resource Applier — runtime glue between the DB and the browser context
 *
 * The runner asks: "I'm about to run a test with these bindings — get the
 * context ready and tell me what to snapshot into test_executions". This
 * file is the ONE place that answers both halves.
 *
 * Responsibilities:
 *   1. Load each bound resource (decrypted) from TestResourceService.
 *   2. Ensure freshness — if stale and auto-healable, refresh under the
 *      per-resource mutex so parallel runs don't dogpile.
 *   3. Call adapter.apply() to inject state into the live context.
 *   4. Return a non-sensitive snapshot + teardown hooks.
 *   5. Fail fast on `required` bindings whose resource is broken or
 *      unavailable — better a loud error than a silent half-applied run.
 *
 * What this file does NOT do:
 *   - Execute recipes (that lives in the runner / lite-engine — it needs
 *     CommandExecutor which would cycle through this module).
 *   - Record snapshots to the DB (the job does that on completion so a
 *     single transaction captures status + snapshot together).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { BrowserContext, Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import { requireResourceAdapter } from './adapter-registry';
import {
  loadDecrypted,
  isFresh,
  markBroken,
} from './test-resource.service';
import { withResourceMutex } from './resource-mutex';
import type {
  ApplyContext,
  DecryptedResource,
  ResourceKind,
  ResourceStatus,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface BindingInput {
  kind: string;
  resource_id: string;
  required?: boolean;
}

export interface AppliedBinding {
  /** The original binding payload (echoed back for traceability). */
  binding: { kind: ResourceKind; resource_id: string; required: boolean };
  /** Display name surfaced in UI (never sensitive). */
  name: string;
  kind: ResourceKind;
  /** Status at the moment apply() ran — may differ from current status. */
  status_at_start: ResourceStatus;
  captured_at: string | null;
  /** Populated by the supervisor on successful in-run heal. */
  healed_during_run: boolean;
  /** Error message if apply failed and binding was not `required`. */
  apply_error?: string;
}

export interface ApplyResult {
  /** Bindings that made it to adapter.apply() (success). */
  applied: AppliedBinding[];
  /** Bindings that skipped (not required, resource missing/broken/invalid). */
  skipped: Array<{ binding: BindingInput; reason: string }>;
  /** Decrypted resources keyed by resource_id — handed to supervisor for heal. */
  resources: Map<string, DecryptedResource>;
  /** Shared run-variable bag so later-applied resources see earlier writes. */
  runVariables: Map<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply every binding to the given browser context. Called once between
 * `browser.newContext()` and the first `page.goto(url)` of a run.
 *
 * Ordering:
 *   Resources without a browser dependency (secrets, env, variables)
 *   are applied first so kinds like `auth` can reference them. Within a
 *   tier, the caller's order is preserved.
 *
 * Error policy:
 *   - `required: true` + resource missing / broken / apply throws → throws.
 *   - `required: false` → logged, added to `skipped`, run continues.
 *   - A resource that needs a refresh but has no auto-heal path is
 *     treated as broken for this run (marked in DB too).
 */
export async function applyBindingsToContext(params: {
  userId: string;
  projectId: string;
  context: BrowserContext;
  page: Page;
  bindings: BindingInput[];
  runVariables?: Map<string, unknown>;
  /** If set, the supervisor's healAuth hook — used when adapter.heal throws. */
  healHook?: (resource: DecryptedResource) => Promise<void>;
}): Promise<ApplyResult> {
  const runVariables = params.runVariables ?? new Map<string, unknown>();
  const applied: AppliedBinding[] = [];
  const skipped: Array<{ binding: BindingInput; reason: string }> = [];
  const resources = new Map<string, DecryptedResource>();

  if (!params.bindings || params.bindings.length === 0) {
    return { applied, skipped, resources, runVariables };
  }

  // Topological-ish sort: non-browser kinds first so auth can read env/secrets.
  const ordered = [...params.bindings].sort((a, b) => {
    const rank = (k: string): number => {
      if (k === 'secret' || k === 'environment' || k === 'variables') return 0;
      if (k === 'device' || k === 'network') return 1;
      if (k === 'auth' || k === 'oauth_token') return 2;
      if (k === 'data_fixture' || k === 'file') return 3;
      return 5;
    };
    return rank(a.kind) - rank(b.kind);
  });

  for (const binding of ordered) {
    const required = binding.required === true;

    // Load + freshness check + heal (if needed) under the per-resource lock.
    let resource: DecryptedResource | null = null;
    try {
      resource = await ensureFresh({
        userId: params.userId,
        projectId: params.projectId,
        resourceId: binding.resource_id,
        page: params.page,
        context: params.context,
        runVariables,
        healHook: params.healHook,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (required) throw new Error(`Required ${binding.kind} binding failed: ${reason}`);
      skipped.push({ binding, reason });
      continue;
    }

    if (!resource) {
      if (required) {
        throw new Error(
          `Required ${binding.kind} binding ${binding.resource_id} not found`,
        );
      }
      skipped.push({ binding, reason: 'not found' });
      continue;
    }

    if (resource.status === 'broken') {
      const reason = `resource marked broken: ${resource.name}`;
      if (required) throw new Error(reason);
      skipped.push({ binding, reason });
      continue;
    }

    resources.set(resource.id, resource);

    // Apply via the right adapter. We look up by the resource's own kind —
    // never the binding's, because the DB is authoritative.
    const adapter = requireResourceAdapter(resource.kind);
    const applyCtx: ApplyContext = {
      userId: params.userId,
      projectId: params.projectId,
      page: params.page,
      context: params.context,
      runVariables,
    };

    try {
      await adapter.apply(applyCtx, resource);
      applied.push({
        binding: {
          kind: resource.kind,
          resource_id: resource.id,
          required,
        },
        name: resource.name,
        kind: resource.kind,
        status_at_start: resource.status,
        captured_at: resource.expiresAt
          ? new Date(resource.expiresAt.getTime() - (resource.ttlSeconds ?? 0) * 1000).toISOString()
          : null,
        healed_during_run: false,
      });
      logger.info('[RESOURCE_APPLIER] Applied', {
        kind: resource.kind,
        name: resource.name,
        id: resource.id,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('[RESOURCE_APPLIER] Apply failed', {
        kind: resource.kind,
        id: resource.id,
        error: reason,
      });
      if (required) {
        throw new Error(
          `Required ${resource.kind} "${resource.name}" failed to apply: ${reason}`,
        );
      }
      applied.push({
        binding: {
          kind: resource.kind,
          resource_id: resource.id,
          required,
        },
        name: resource.name,
        kind: resource.kind,
        status_at_start: resource.status,
        captured_at: null,
        healed_during_run: false,
        apply_error: reason,
      });
    }
  }

  return { applied, skipped, resources, runVariables };
}

/**
 * Run post-test cleanup for every kind that declared a teardown. Any
 * thrown error is logged and swallowed — a failing teardown must never
 * mask the test result.
 */
export async function teardownAppliedResources(params: {
  userId: string;
  projectId: string;
  page?: Page;
  context?: BrowserContext;
  resources: Map<string, DecryptedResource>;
  runVariables: Map<string, unknown>;
}): Promise<void> {
  const ctx: ApplyContext = {
    userId: params.userId,
    projectId: params.projectId,
    page: params.page,
    context: params.context,
    runVariables: params.runVariables,
  };

  // Reverse of apply order — fixture/file first, auth last. Same rank
  // function, just inverted.
  const entries = Array.from(params.resources.values()).sort((a, b) => {
    const rank = (k: ResourceKind): number => {
      if (k === 'data_fixture' || k === 'file') return 1;
      if (k === 'auth' || k === 'oauth_token') return 2;
      if (k === 'device' || k === 'network') return 3;
      return 4;
    };
    return rank(a.kind) - rank(b.kind);
  });

  for (const resource of entries) {
    const adapter = requireResourceAdapter(resource.kind);
    if (!adapter.teardown) continue;
    try {
      await adapter.teardown(ctx, resource);
    } catch (err) {
      logger.warn('[RESOURCE_APPLIER] Teardown failed (non-fatal)', {
        kind: resource.kind,
        id: resource.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Internals
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return a decrypted resource guaranteed to be either fresh or
 * intentionally-static (no TTL). Heal happens under a per-resource mutex
 * so 10 parallel tests share one refresh.
 *
 * Returns null if the resource doesn't exist. Throws if heal failed for
 * a resource that needed one.
 */
async function ensureFresh(params: {
  userId: string;
  projectId: string;
  resourceId: string;
  page: Page;
  context: BrowserContext;
  runVariables: Map<string, unknown>;
  healHook?: (resource: DecryptedResource) => Promise<void>;
}): Promise<DecryptedResource | null> {
  // First read without the lock — optimistic path for the common case
  // where state is already fresh.
  const first = await loadDecrypted(params.resourceId, params.userId);
  if (!first) return null;
  if (isFresh(first)) return first;

  // Stale. Claim the mutex; re-check inside because a concurrent caller
  // may have refreshed it between our read and our turn.
  return withResourceMutex(params.resourceId, async () => {
    const fresh = await loadDecrypted(params.resourceId, params.userId);
    if (!fresh) return null;
    if (isFresh(fresh)) return fresh;

    // Genuinely stale. Can we heal?
    if (fresh.refreshMethod === 'none' || fresh.refreshMethod === 'manual') {
      // Nothing we can do without user intervention.
      await markBroken(
        fresh.id,
        params.userId,
        `Stale resource with refresh_method=${fresh.refreshMethod}`,
      );
      throw new Error(
        `Resource "${fresh.name}" is stale and cannot auto-heal (refresh=${fresh.refreshMethod})`,
      );
    }

    if (!params.healHook) {
      // Pre-run path: a healHook is required for ui_recipe / api heal.
      // Without it we can't trigger a recipe replay, so fail hard —
      // the caller forgot to wire the supervisor.
      throw new Error(
        `Resource "${fresh.name}" needs heal but runner provided no healHook`,
      );
    }

    try {
      await params.healHook(fresh);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markBroken(fresh.id, params.userId, `Heal failed: ${msg}`);
      throw new Error(`Resource "${fresh.name}" heal failed: ${msg}`);
    }

    // Heal must have updated captured_at / expires_at; reload to pick up
    // the new state.
    const healed = await loadDecrypted(params.resourceId, params.userId);
    if (!healed) throw new Error('Resource vanished after heal');
    if (!isFresh(healed)) {
      throw new Error(`Resource "${healed.name}" still stale after heal`);
    }
    return healed;
  });
}
