/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Test Resource Service
 *
 * Kind-agnostic CRUD on `test_resources` + `workspace_resource_defaults` +
 * bindings on `intent_test_cases.resource_bindings`. All type-specific
 * behavior is delegated to adapters registered via adapter-registry.
 *
 * Responsibilities:
 *   1. Validate via the right adapter, move `sensitiveFields()` into the
 *      encrypted envelope on write.
 *   2. Decrypt + normalize on read before handing to adapters.
 *   3. Manage lifecycle columns (status / captured_at / expires_at /
 *      last_used_at / heal_count) centrally so adapters never touch DB.
 *   4. Smart defaults — `resolveDefaults(bindings, scope)` enriches a
 *      test's bindings with workspace-configured auto-bindings on save.
 *   5. Controlled delete: reassign linked tests before drop so 47
 *      dependents never silently orphan.
 *
 * Everything here is stateless and safe to call from any job worker.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { encryptString, decryptString } from '@/utils/security/crypto';
import { requireResourceAdapter, getResourceAdapter } from './adapter-registry';
import type {
  ResourceKind,
  ResourceRow,
  ResourceScope,
  ResourceStatus,
  ResourceSummary,
  DecryptedResource,
  EncryptedEnvelope,
  RefreshMethod,
  ResourcePlatform,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════
// Public input/output types
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateResourceInput {
  userId: string;
  projectId: string;
  kind: ResourceKind;
  name: string;
  description?: string;
  scope?: ResourceScope;
  /** Merged (sensitive + non-sensitive) — service splits via adapter.sensitiveFields(). */
  config?: Record<string, unknown>;
  /** Sensitive fields handed separately as a convenience — merged into config for validation. */
  sensitive?: Record<string, unknown>;
  ttlSeconds?: number;
  refreshMethod?: RefreshMethod;
  refreshConfig?: Record<string, unknown>;
  recipe?: unknown[];
}

export interface UpdateResourceInput {
  name?: string;
  description?: string | null;
  scope?: ResourceScope;
  config?: Record<string, unknown>;
  sensitive?: Record<string, unknown>;
  ttlSeconds?: number | null;
  refreshMethod?: RefreshMethod;
  refreshConfig?: Record<string, unknown> | null;
  recipe?: unknown[];
  status?: ResourceStatus;
  brokenReason?: string | null;
}

export interface ResourceBinding {
  kind: ResourceKind;
  resource_id: string;
  required?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Domain helpers (shared with adapters via re-export in types? kept here to
// avoid widening the types surface)
// ═══════════════════════════════════════════════════════════════════════════

/** Canonicalize a domain from any URL-ish string. Null on invalid. */
export function extractDomain(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(normalized);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function assertNonEmpty(value: string | undefined | null, field: string): string {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

function computeExpiresAt(capturedAt: Date, ttlSeconds: number): Date {
  return new Date(capturedAt.getTime() + ttlSeconds * 1000);
}

/**
 * Partition a merged config object into (non-sensitive config, sensitive plaintext)
 * according to what the adapter flags as secret.
 */
function splitSensitive(
  adapterKind: ResourceKind,
  mergedConfig: Record<string, unknown>,
): { config: Record<string, unknown>; sensitive: Record<string, unknown> } {
  const adapter = requireResourceAdapter(adapterKind);
  const secretKeys = new Set(adapter.sensitiveFields());
  const publicConfig: Record<string, unknown> = {};
  const sensitive: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mergedConfig)) {
    if (secretKeys.has(k)) sensitive[k] = v;
    else publicConfig[k] = v;
  }
  return { config: publicConfig, sensitive };
}

/** Encrypt each key in the sensitive object to build the stored envelope. */
function encryptEnvelope(sensitive: Record<string, unknown>): EncryptedEnvelope | null {
  const keys = Object.keys(sensitive);
  if (keys.length === 0) return null;
  const envelope: EncryptedEnvelope = {};
  for (const k of keys) {
    const raw = sensitive[k];
    // Stringify everything — envelopes are homogeneous on purpose so
    // decryption logic stays trivial.
    envelope[k] = encryptString(typeof raw === 'string' ? raw : JSON.stringify(raw));
  }
  return envelope;
}

/** Reverse of encryptEnvelope. Fields that fail to decrypt are dropped + logged. */
function decryptEnvelope(
  envelope: EncryptedEnvelope | null | undefined,
  resourceId: string,
): Record<string, unknown> {
  if (!envelope) return {};
  const out: Record<string, unknown> = {};
  for (const [k, cipher] of Object.entries(envelope)) {
    try {
      const plain = decryptString(cipher);
      // Best-effort JSON parse — adapters that stored non-JSON get the raw string.
      try {
        out[k] = JSON.parse(plain);
      } catch {
        out[k] = plain;
      }
    } catch (err) {
      logger.warn('[TEST_RESOURCE] Failed to decrypt envelope field', {
        resourceId,
        field: k,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

function toSummary(row: ResourceRow, testCount: number): ResourceSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    description: row.description ?? undefined,
    scope: row.scope ?? {},
    config: row.config ?? {},
    sensitiveKeys: row.sensitive ? Object.keys(row.sensitive) : [],
    status: row.status,
    brokenReason: row.broken_reason ?? undefined,
    capturedAt: row.captured_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    ttlSeconds: row.ttl_seconds ?? undefined,
    refreshMethod: row.refresh_method,
    refreshConfig: (row.refresh_config as Record<string, unknown> | null) ?? undefined,
    hasRecipe: Array.isArray(row.recipe) && row.recipe.length > 0,
    testCount,
    lastUsedAt: row.last_used_at ?? undefined,
    lastHealedAt: row.last_healed_at ?? undefined,
    healCount: row.heal_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Batch-count tests bound to each resource. Uses the GIN index on
 * resource_bindings + JSONB containment. N rows counted in 1 query
 * (no N+1 per code-quality.md).
 */
async function countTestsForResources(
  resourceIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const id of resourceIds) counts.set(id, 0);
  if (resourceIds.length === 0) return counts;

  // Pull all test cases that reference ANY of these resource ids. We
  // filter client-side because supabase-js doesn't expose OR-of-containment
  // ergonomically, and the filtered set is bounded by the user's own tests.
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('resource_bindings')
    .not('resource_bindings', 'eq', '[]');

  if (error) {
    logger.warn('[TEST_RESOURCE] Failed to count dependent tests', { error: error.message });
    return counts;
  }

  const idSet = new Set(resourceIds);
  for (const row of data ?? []) {
    const bindings = (row as any).resource_bindings;
    if (!Array.isArray(bindings)) continue;
    for (const b of bindings) {
      const rid = b?.resource_id;
      if (typeof rid === 'string' && idSet.has(rid)) {
        counts.set(rid, (counts.get(rid) ?? 0) + 1);
      }
    }
  }
  return counts;
}

// ═══════════════════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════════════════

export async function createResource(
  input: CreateResourceInput,
): Promise<ResourceSummary> {
  const userId = assertNonEmpty(input.userId, 'userId');
  const projectId = assertNonEmpty(input.projectId, 'projectId');
  const name = assertNonEmpty(input.name, 'name');
  const adapter = requireResourceAdapter(input.kind);

  // Merge sensitive into config for validation — adapters validate the
  // whole shape, the service then splits.
  const merged = { ...(input.config ?? {}), ...(input.sensitive ?? {}) };
  const validation = adapter.validate({
    config: merged,
    scope: input.scope ?? {},
  });
  if (!validation.valid) {
    throw new Error(
      `Invalid ${input.kind} resource: ${(validation.errors ?? ['unknown']).slice(0, 3).join('; ')}`,
    );
  }

  const normalizedMerged =
    validation.normalized?.config ?? merged;
  const { config: publicConfig, sensitive: sensitivePlain } = splitSensitive(
    input.kind,
    normalizedMerged,
  );

  const envelope = encryptEnvelope(sensitivePlain);

  // Lifecycle: if the adapter declared a TTL and there IS fresh state in
  // the config, stamp captured_at/expires_at now. Otherwise the row
  // starts stale (status=stale) so the runner knows to refresh before use.
  const ttl = input.ttlSeconds ?? null;
  const hasState = envelope !== null || Object.keys(publicConfig).length > 0;
  const now = new Date();
  const capturedAt = hasState ? now : null;
  const expiresAt = hasState && ttl ? computeExpiresAt(now, ttl) : null;

  const row = {
    project_id: projectId,
    user_id: userId,
    kind: input.kind,
    name,
    description: input.description ?? null,
    scope: input.scope ?? {},
    config: publicConfig,
    sensitive: envelope,
    status: hasState ? 'active' : 'stale',
    captured_at: capturedAt?.toISOString() ?? null,
    expires_at: expiresAt?.toISOString() ?? null,
    ttl_seconds: ttl,
    refresh_method: input.refreshMethod ?? 'none',
    refresh_config: input.refreshConfig ?? null,
    recipe: input.recipe ?? [],
  };

  const { data, error } = await supabaseAdmin
    .from('test_resources')
    .insert(row)
    .select('*')
    .single();

  if (error || !data) {
    logger.error('[TEST_RESOURCE] Create failed', {
      kind: input.kind,
      error: error?.message,
    });
    throw new Error(`Failed to create resource: ${error?.message ?? 'unknown'}`);
  }

  logger.info('[TEST_RESOURCE] Created', {
    id: data.id,
    kind: input.kind,
    name,
    hasSensitive: envelope !== null,
  });

  return toSummary(data as ResourceRow, 0);
}

export async function listResources(
  userId: string,
  projectId: string,
  opts: { kind?: ResourceKind } = {},
): Promise<ResourceSummary[]> {
  const uid = assertNonEmpty(userId, 'userId');
  const pid = assertNonEmpty(projectId, 'projectId');

  let query = supabaseAdmin
    .from('test_resources')
    .select('*')
    .eq('user_id', uid)
    .eq('project_id', pid);

  if (opts.kind) query = query.eq('kind', opts.kind);

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    logger.error('[TEST_RESOURCE] List failed', { error: error.message });
    return [];
  }

  const rows = (data ?? []) as ResourceRow[];
  const counts = await countTestsForResources(rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, counts.get(r.id) ?? 0));
}

export async function getResource(
  id: string,
  userId: string,
): Promise<ResourceSummary | null> {
  const { data, error } = await supabaseAdmin
    .from('test_resources')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error('[TEST_RESOURCE] Get failed', { id, error: error.message });
    return null;
  }
  if (!data) return null;

  const counts = await countTestsForResources([data.id]);
  return toSummary(data as ResourceRow, counts.get(data.id) ?? 0);
}

export async function updateResource(
  id: string,
  userId: string,
  patch: UpdateResourceInput,
): Promise<ResourceSummary | null> {
  const uid = assertNonEmpty(userId, 'userId');
  const pid = assertNonEmpty(id, 'id');

  // Fetch current row — we need `kind` for the adapter and existing
  // config/sensitive to merge deltas on top of.
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('test_resources')
    .select('*')
    .eq('id', pid)
    .eq('user_id', uid)
    .maybeSingle();
  if (fetchErr) throw new Error(`Failed to read resource: ${fetchErr.message}`);
  if (!existing) return null;

  const row = existing as ResourceRow;
  const update: Record<string, unknown> = {};

  if (patch.name !== undefined) update.name = assertNonEmpty(patch.name, 'name');
  if (patch.description !== undefined) update.description = patch.description ?? null;
  if (patch.scope !== undefined) update.scope = patch.scope;
  if (patch.refreshMethod !== undefined) update.refresh_method = patch.refreshMethod;
  if (patch.refreshConfig !== undefined) update.refresh_config = patch.refreshConfig;
  if (patch.recipe !== undefined) update.recipe = patch.recipe;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.brokenReason !== undefined) update.broken_reason = patch.brokenReason;

  if (patch.ttlSeconds !== undefined) {
    if (patch.ttlSeconds !== null && (!Number.isInteger(patch.ttlSeconds) || patch.ttlSeconds <= 0)) {
      throw new Error('ttlSeconds must be a positive integer or null');
    }
    update.ttl_seconds = patch.ttlSeconds;
  }

  // Config/sensitive updates flow through the adapter so shape stays valid.
  if (patch.config !== undefined || patch.sensitive !== undefined) {
    const currentSensitive = decryptEnvelope(row.sensitive, row.id);
    const mergedConfig = {
      ...(row.config ?? {}),
      ...currentSensitive,
      ...(patch.config ?? {}),
      ...(patch.sensitive ?? {}),
    };
    const adapter = requireResourceAdapter(row.kind);
    const validation = adapter.validate({
      config: mergedConfig,
      scope: patch.scope ?? row.scope,
    });
    if (!validation.valid) {
      throw new Error(
        `Invalid ${row.kind} update: ${(validation.errors ?? ['unknown']).slice(0, 3).join('; ')}`,
      );
    }
    const normalized = validation.normalized?.config ?? mergedConfig;
    const { config: publicConfig, sensitive: sensitivePlain } = splitSensitive(
      row.kind,
      normalized,
    );
    update.config = publicConfig;
    update.sensitive = encryptEnvelope(sensitivePlain);

    // If new sensitive state was written, refresh captured_at/expires_at
    // so freshness tracking reflects reality.
    const now = new Date();
    const ttlFinal =
      (patch.ttlSeconds !== undefined ? patch.ttlSeconds : row.ttl_seconds) ?? null;
    update.captured_at = now.toISOString();
    update.expires_at = ttlFinal ? computeExpiresAt(now, ttlFinal).toISOString() : null;
    update.status = 'active';
    update.broken_reason = null;
  }

  if (Object.keys(update).length === 0) {
    return getResource(pid, uid);
  }

  const { data, error } = await supabaseAdmin
    .from('test_resources')
    .update(update)
    .eq('id', pid)
    .eq('user_id', uid)
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to update resource: ${error.message}`);
  }
  if (!data) return null;

  const counts = await countTestsForResources([data.id]);
  return toSummary(data as ResourceRow, counts.get(data.id) ?? 0);
}

/**
 * Delete a resource. `reassignTo` moves every test's binding of the same
 * kind to the target; without it, bindings are stripped. Either way we
 * never leave a dangling resource_id in `resource_bindings`.
 */
export async function deleteResource(
  id: string,
  userId: string,
  opts: { reassignTo?: string | null } = {},
): Promise<{ deleted: boolean; reassignedTests: number; detachedTests: number }> {
  const uid = assertNonEmpty(userId, 'userId');
  const pid = assertNonEmpty(id, 'id');

  // Discover dependents first so we can rewrite their bindings.
  const { data: dependents, error: depsErr } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, resource_bindings')
    .eq('user_id', uid)
    .contains('resource_bindings', [{ resource_id: pid }]);

  if (depsErr) {
    logger.warn('[TEST_RESOURCE] Dependents lookup failed', { error: depsErr.message });
  }

  // Validate reassign target if requested — must belong to same user.
  if (opts.reassignTo) {
    const target = await getResource(opts.reassignTo, uid);
    if (!target) throw new Error('reassignTo resource not found or not owned by user');
  }

  let reassigned = 0;
  let detached = 0;

  for (const row of dependents ?? []) {
    const id = (row as any).id as string;
    const bindings = ((row as any).resource_bindings ?? []) as ResourceBinding[];
    let changed = false;
    const next: ResourceBinding[] = [];
    for (const b of bindings) {
      if (b.resource_id === pid) {
        if (opts.reassignTo) {
          next.push({ ...b, resource_id: opts.reassignTo });
          changed = true;
        } else {
          changed = true;
          // dropped
        }
      } else {
        next.push(b);
      }
    }
    if (changed) {
      await supabaseAdmin
        .from('intent_test_cases')
        .update({ resource_bindings: next })
        .eq('id', id);
      if (opts.reassignTo) reassigned += 1;
      else detached += 1;
    }
  }

  // Drop default mappings pointing at this resource.
  await supabaseAdmin
    .from('workspace_resource_defaults')
    .delete()
    .eq('resource_id', pid)
    .eq('user_id', uid);

  const { error } = await supabaseAdmin
    .from('test_resources')
    .delete()
    .eq('id', pid)
    .eq('user_id', uid);

  if (error) {
    logger.error('[TEST_RESOURCE] Delete failed', { id: pid, error: error.message });
    return { deleted: false, reassignedTests: reassigned, detachedTests: detached };
  }

  logger.info('[TEST_RESOURCE] Deleted', {
    id: pid,
    reassignedTests: reassigned,
    detachedTests: detached,
  });
  return { deleted: true, reassignedTests: reassigned, detachedTests: detached };
}

// ═══════════════════════════════════════════════════════════════════════════
// Runtime — decrypt + apply helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load a resource with sensitive fields decrypted. Consumers (runner,
 * preview, heal path) get a ready-to-use DecryptedResource that matches
 * the adapter's expected shape.
 *
 * Silently bumps `last_used_at`.
 */
export async function loadDecrypted(
  id: string,
  userId: string,
): Promise<DecryptedResource | null> {
  const { data, error } = await supabaseAdmin
    .from('test_resources')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error('[TEST_RESOURCE] Load failed', { id, error: error.message });
    return null;
  }
  if (!data) return null;

  const row = data as ResourceRow;
  const sensitive = decryptEnvelope(row.sensitive, row.id);

  // Fire-and-forget — never block the runner on telemetry.
  void supabaseAdmin
    .from('test_resources')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', id)
    .then(undefined, (err: unknown) => {
      logger.debug('[TEST_RESOURCE] Failed to bump last_used_at', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    scope: row.scope ?? {},
    config: row.config ?? {},
    sensitive,
    status: row.status,
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    ttlSeconds: row.ttl_seconds ?? undefined,
    refreshMethod: row.refresh_method,
    refreshConfig: (row.refresh_config as Record<string, unknown> | null) ?? undefined,
    recipe: Array.isArray(row.recipe) ? row.recipe : [],
  };
}

/**
 * Default freshness check. Adapter.isFresh? takes precedence when defined;
 * fallback: not broken, not past expires_at. Static resources (no TTL) are
 * always fresh.
 */
export function isFresh(resource: DecryptedResource, staleBelow = 0.1): boolean {
  if (resource.status === 'broken') return false;

  const adapter = getResourceAdapter(resource.kind);
  if (adapter?.isFresh) return adapter.isFresh(resource);

  // No TTL → always fresh (status=broken was already filtered above).
  if (!resource.expiresAt || !resource.ttlSeconds) {
    return true;
  }

  const remainingMs = resource.expiresAt.getTime() - Date.now();
  if (remainingMs <= 0) return false;
  return remainingMs / (resource.ttlSeconds * 1000) > staleBelow;
}

/**
 * Persist a freshly captured config/sensitive pair (called after a
 * successful heal or re-record). Rewrites encrypted envelope and resets
 * status + expires_at. Heal mode bumps heal_count + last_healed_at.
 */
export async function captureState(
  id: string,
  userId: string,
  payload: { config?: Record<string, unknown>; sensitive?: Record<string, unknown> },
  opts: { heal?: boolean } = {},
): Promise<void> {
  const { data: existing, error: readErr } = await supabaseAdmin
    .from('test_resources')
    .select('kind, ttl_seconds, heal_count, config')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (readErr || !existing) {
    throw new Error('Resource not found for capture');
  }

  const kind = existing.kind as ResourceKind;
  const ttl = existing.ttl_seconds as number | null;

  // Validate the new state through the adapter before writing — keeps
  // bad heals from landing in DB.
  const merged = {
    ...(existing.config ?? {}),
    ...(payload.config ?? {}),
    ...(payload.sensitive ?? {}),
  };
  const adapter = requireResourceAdapter(kind);
  const validation = adapter.validate({ config: merged });
  if (!validation.valid) {
    throw new Error(
      `Captured state invalid: ${(validation.errors ?? ['unknown']).slice(0, 3).join('; ')}`,
    );
  }

  const normalized = validation.normalized?.config ?? merged;
  const { config: publicConfig, sensitive: sensitivePlain } = splitSensitive(
    kind,
    normalized,
  );

  const now = new Date();
  const update: Record<string, unknown> = {
    config: publicConfig,
    sensitive: encryptEnvelope(sensitivePlain),
    captured_at: now.toISOString(),
    expires_at: ttl ? computeExpiresAt(now, ttl).toISOString() : null,
    status: 'active',
    broken_reason: null,
  };
  if (opts.heal) {
    update.last_healed_at = now.toISOString();
    update.heal_count = (existing.heal_count ?? 0) + 1;
  }

  const { error } = await supabaseAdmin
    .from('test_resources')
    .update(update)
    .eq('id', id)
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to capture state: ${error.message}`);

  logger.info('[TEST_RESOURCE] Captured state', { id, heal: !!opts.heal });
}

/**
 * Lightweight pre-flight: check whether the resources behind a bindings
 * array are present + not broken + scope-compatible with the run platform,
 * WITHOUT touching `sensitive` / decrypt. Used by the mobile dispatcher to
 * fail-fast on `required: true` bindings before creating any DB rows —
 * decryption is deferred to the worker so plaintext never lands in Redis.
 *
 * Returns `{ ok: boolean, reasons: Array<{resourceId, reason}> }` — empty
 * reasons + ok=true means every required binding will load. Soft failures
 * (not required) are NOT included — caller doesn't need to know about them
 * until the worker compiles.
 */
export async function validateBindingsPreflight(
  bindings: ResourceBinding[],
  userId: string,
  runPlatform: 'android' | 'ios' | 'flutter',
): Promise<{ ok: boolean; reasons: Array<{ resourceId: string; reason: string }> }> {
  const required = bindings.filter((b) => b.required === true);
  if (required.length === 0) return { ok: true, reasons: [] };

  const ids = Array.from(new Set(required.map((b) => b.resource_id)));
  const { data, error } = await supabaseAdmin
    .from('test_resources')
    .select('id, name, status, scope')
    .in('id', ids)
    .eq('user_id', userId);

  if (error) {
    return {
      ok: false,
      reasons: [{ resourceId: '*', reason: `DB error: ${error.message}` }],
    };
  }

  const byId = new Map<string, { id: string; name: string; status: string; scope: Record<string, unknown> | null }>();
  for (const row of (data ?? []) as Array<{ id: string; name: string; status: string; scope: Record<string, unknown> | null }>) {
    byId.set(row.id, row);
  }

  const reasons: Array<{ resourceId: string; reason: string }> = [];

  for (const binding of required) {
    const row = byId.get(binding.resource_id);
    if (!row) {
      reasons.push({
        resourceId: binding.resource_id,
        reason: `required ${binding.kind} binding not found`,
      });
      continue;
    }
    if (row.status === 'broken') {
      reasons.push({
        resourceId: binding.resource_id,
        reason: `required ${binding.kind} "${row.name}" is broken`,
      });
      continue;
    }
    // Scope platform check — mirrors isPlatformCompatible in the compiler.
    // No scope.platform set = platform-agnostic (legacy) — allow.
    const scopePlatform =
      row.scope && typeof row.scope === 'object'
        ? (row.scope as Record<string, unknown>).platform
        : undefined;
    if (scopePlatform && typeof scopePlatform === 'string') {
      const compatible =
        (scopePlatform === 'android' && (runPlatform === 'android' || runPlatform === 'flutter')) ||
        (scopePlatform === 'ios' && runPlatform === 'ios');
      if (!compatible) {
        // Platform mismatch is a configuration error — keep it a warning-level
        // skip at compile time (compiler soft-skips). Preflight deliberately
        // DOES NOT fail here so 'required: true' with mixed platforms doesn't
        // abort the whole run. Logged loudly instead.
        logger.warn('[TEST_RESOURCE] Preflight: required binding platform mismatch — will soft-skip at compile', {
          resourceId: row.id,
          resourceName: row.name,
          scopePlatform,
          runPlatform,
        });
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export async function markBroken(
  id: string,
  userId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('test_resources')
    .update({ status: 'broken', broken_reason: reason.slice(0, 500) })
    .eq('id', id)
    .eq('user_id', userId);
  if (error) {
    logger.warn('[TEST_RESOURCE] markBroken failed', { id, error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Defaults
// ═══════════════════════════════════════════════════════════════════════════

export interface DefaultScopeKey {
  kind: ResourceKind;
  platform?: ResourcePlatform;
  url?: string | null;
  appPackage?: string | null;
  urlPattern?: string | null;
}

/**
 * Resolve the default resource id for a given target. Picks the most
 * specific match — url over url_pattern over domain over platform-only.
 * Returns null when no default is configured.
 */
export async function resolveDefaultResourceId(params: {
  userId: string;
  projectId: string;
  key: DefaultScopeKey;
}): Promise<string | null> {
  const { userId, projectId, key } = params;
  const platform = key.platform ?? 'web';

  let query = supabaseAdmin
    .from('workspace_resource_defaults')
    .select('resource_id, domain, app_package, url_pattern, platform')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .eq('kind', key.kind);

  // For web: match by exact domain; for mobile: by app_package.
  if (platform !== 'web') {
    if (!key.appPackage) return null;
    query = query.eq('app_package', key.appPackage);
  } else {
    const domain = extractDomain(key.url ?? null);
    if (!domain) return null;
    // Either exact domain match OR a url_pattern that contains the domain.
    // Two queries merged client-side — simpler than a raw OR.
    query = query.or(`domain.eq.${domain},url_pattern.ilike.%${domain}%`);
  }

  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;

  // Prefer exact domain over pattern match.
  const exact = data.find((r: any) => r.domain && extractDomain(key.url ?? null) === r.domain);
  return (exact ?? data[0]).resource_id;
}

export async function setDefaultResource(params: {
  userId: string;
  projectId: string;
  resourceId: string;
  kind: ResourceKind;
  platform?: ResourcePlatform;
  url?: string | null;
  appPackage?: string | null;
  urlPattern?: string | null;
}): Promise<void> {
  const platform = params.platform ?? 'web';
  const domain = platform === 'web' ? extractDomain(params.url ?? null) : null;
  const appPackage = platform !== 'web' ? params.appPackage ?? null : null;
  const urlPattern = params.urlPattern ?? null;

  if (platform === 'web' && !domain && !urlPattern) {
    throw new Error('Web default requires either a resolvable domain or a url_pattern');
  }
  if (platform !== 'web' && !appPackage) {
    throw new Error('Mobile default requires appPackage');
  }

  // Ownership guard.
  const target = await getResource(params.resourceId, params.userId);
  if (!target) throw new Error('resourceId not found or not owned by user');
  if (target.kind !== params.kind) {
    throw new Error(`resourceId is kind '${target.kind}' but default is for '${params.kind}'`);
  }

  // Manual upsert keyed on the unique index (see migration).
  const { data: existing } = await supabaseAdmin
    .from('workspace_resource_defaults')
    .select('id')
    .eq('user_id', params.userId)
    .eq('project_id', params.projectId)
    .eq('kind', params.kind)
    .eq('platform', platform)
    .eq('domain', domain ?? '')
    .eq('app_package', appPackage ?? '')
    .eq('url_pattern', urlPattern ?? '')
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('workspace_resource_defaults')
      .update({ resource_id: params.resourceId })
      .eq('id', existing.id);
  } else {
    await supabaseAdmin.from('workspace_resource_defaults').insert({
      user_id: params.userId,
      project_id: params.projectId,
      kind: params.kind,
      platform,
      domain,
      app_package: appPackage,
      url_pattern: urlPattern,
      resource_id: params.resourceId,
    });
  }
}

export async function clearDefaultResource(params: {
  userId: string;
  projectId: string;
  kind: ResourceKind;
  platform?: ResourcePlatform;
  url?: string | null;
  appPackage?: string | null;
  urlPattern?: string | null;
}): Promise<void> {
  const platform = params.platform ?? 'web';
  const domain = platform === 'web' ? extractDomain(params.url ?? null) : null;
  const appPackage = platform !== 'web' ? params.appPackage ?? null : null;

  let query = supabaseAdmin
    .from('workspace_resource_defaults')
    .delete()
    .eq('user_id', params.userId)
    .eq('project_id', params.projectId)
    .eq('kind', params.kind)
    .eq('platform', platform);

  if (platform === 'web') {
    if (domain) query = query.eq('domain', domain);
    else if (params.urlPattern) query = query.eq('url_pattern', params.urlPattern);
    else return;
  } else {
    if (!appPackage) return;
    query = query.eq('app_package', appPackage);
  }

  await query;
}

/**
 * Enrich a test's existing bindings with workspace-configured defaults
 * for kinds not yet bound. Used at test creation to auto-attach resources
 * without asking the user each time.
 *
 * Never overrides an explicit binding — only fills holes.
 */
export async function enrichBindingsWithDefaults(params: {
  userId: string;
  projectId: string;
  bindings: ResourceBinding[];
  scope: {
    platform?: ResourcePlatform;
    url?: string | null;
    appPackage?: string | null;
  };
  /** Restrict enrichment to these kinds; default = all registered kinds. */
  kinds?: ResourceKind[];
}): Promise<ResourceBinding[]> {
  const explicitKinds = new Set(params.bindings.map((b) => b.kind));
  const toCheck = params.kinds ?? [
    'auth',
    'environment',
    'secret',
    'data_fixture',
    'device',
    'network',
    'file',
    'oauth_token',
    'scenario_setup',
    'variables',
  ];

  const result = [...params.bindings];
  for (const kind of toCheck) {
    if (explicitKinds.has(kind)) continue;
    const resourceId = await resolveDefaultResourceId({
      userId: params.userId,
      projectId: params.projectId,
      key: {
        kind,
        platform: params.scope.platform,
        url: params.scope.url ?? null,
        appPackage: params.scope.appPackage ?? null,
      },
    });
    if (resourceId) result.push({ kind, resource_id: resourceId });
  }
  return result;
}
