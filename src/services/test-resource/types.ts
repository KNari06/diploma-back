/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Test Resource — shared type surface
 *
 * The row shape (see 20260418_test_resources.sql) plus the TypeScript
 * contracts every adapter must honor. Kept in a dedicated types file so
 * adapters can import without pulling in service / DB dependencies.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { BrowserContext, Page } from 'playwright';

/**
 * Every kind we may ever support. New kinds MUST be added here AND to the
 * CHECK constraint in the migration — drift between the two is a bug.
 */
export type ResourceKind =
  | 'auth'
  | 'environment'
  | 'secret'
  | 'data_fixture'
  | 'device'
  | 'network'
  | 'file'
  | 'oauth_token'
  | 'scenario_setup'
  | 'variables';

export type ResourceStatus = 'active' | 'stale' | 'broken';

export type RefreshMethod = 'none' | 'ui_recipe' | 'api' | 'manual';

export type ResourcePlatform = 'web' | 'android' | 'ios';

/**
 * Universal scope. Only the keys relevant to a given `kind` are populated;
 * the rest stay undefined. Scope drives default resolution — a web test
 * starting at `app.example.com/dashboard` auto-binds resources whose
 * `scope.domain === 'app.example.com'`.
 */
export interface ResourceScope {
  platform?: ResourcePlatform;
  /** Web: hostname (canonicalized lowercase, no port). */
  domain?: string;
  /** Mobile: package id. */
  app_package?: string;
  /** Glob-ish URL pattern for environments (e.g. "https://*.staging/*"). */
  url_pattern?: string;
  /** Free-form user tags for multi-criteria filtering. */
  tags?: string[];
}

/**
 * The envelope used for the `sensitive` jsonb column. Each field is
 * encrypted independently so adapters can decrypt lazily and we can
 * cheaply answer "does this resource have secret X?" without a decrypt.
 */
export type EncryptedEnvelope = Record<string, string>;

/**
 * The row shape as returned from Supabase. Adapters never see this —
 * TestResourceService feeds them `DecryptedResource` instead.
 */
export interface ResourceRow {
  id: string;
  project_id: string;
  user_id: string;
  kind: ResourceKind;
  name: string;
  description: string | null;
  scope: ResourceScope;
  config: Record<string, unknown>;
  sensitive: EncryptedEnvelope | null;
  status: ResourceStatus;
  broken_reason: string | null;
  captured_at: string | null;
  expires_at: string | null;
  ttl_seconds: number | null;
  refresh_method: RefreshMethod;
  refresh_config: Record<string, unknown> | null;
  recipe: unknown[];
  last_used_at: string | null;
  last_healed_at: string | null;
  heal_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * What the UI sees. Excludes raw ciphertexts, surfaces booleans so the
 * client can render "has credentials" badges without leaking length
 * information about the encrypted payload.
 */
export interface ResourceSummary {
  id: string;
  projectId: string;
  kind: ResourceKind;
  name: string;
  description?: string;
  scope: ResourceScope;
  config: Record<string, unknown>;
  sensitiveKeys: string[]; // names only, never values
  status: ResourceStatus;
  brokenReason?: string;
  capturedAt?: string;
  expiresAt?: string;
  ttlSeconds?: number;
  refreshMethod: RefreshMethod;
  refreshConfig?: Record<string, unknown>;
  hasRecipe: boolean;
  /** Denormalized: how many intent_test_cases bind to this resource. */
  testCount: number;
  lastUsedAt?: string;
  lastHealedAt?: string;
  healCount: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Phase 3 — names of the keys inside the encrypted `values` blob, for
   * resource kinds (`secret`, future `data_fixture` w/ sensitive) where
   * the envelope wraps a key→value map under a single field. Lets the
   * settings UI show "STRIPE_KEY, TWILIO_TOKEN" in edit mode WITHOUT
   * exposing the values themselves. Populated only by single-resource
   * fetchers (getResource); list endpoints leave it undefined to avoid
   * decrypting every row on every list call.
   */
  decryptedKeyNames?: string[];
  /**
   * Fast-auth (May 2026) — `auth` resources only. TRUE when the encrypted
   * envelope contains a `mobileSnapshot` field. Computed from envelope
   * KEYS, not values — no decrypt needed. Lets the Logins UI show a
   * "Mobile ready" chip without paying the per-row decrypt cost.
   * Size and captured_at are NOT surfaced here on purpose: they live
   * inside the encrypted blob and would force a decrypt; if the UI ever
   * needs them, expose via `getResource` (single-resource path that
   * already decrypts) rather than bloating the list path.
   */
  hasMobileSnapshot?: boolean;
}

/**
 * Decrypted + typed view for adapters. The service resolves encrypted
 * fields once and passes the merged object to the adapter, so adapter
 * code never touches crypto directly.
 */
export interface DecryptedResource<
  TConfig = Record<string, unknown>,
  TSensitive = Record<string, unknown>,
> {
  id: string;
  kind: ResourceKind;
  name: string;
  scope: ResourceScope;
  config: TConfig;
  sensitive: TSensitive;
  status: ResourceStatus;
  expiresAt?: Date;
  ttlSeconds?: number;
  refreshMethod: RefreshMethod;
  refreshConfig?: Record<string, unknown>;
  recipe: unknown[];
}

/**
 * Runtime bag handed to adapters. We pass Playwright handles explicitly
 * so adapters don't reach into global state, and we keep userId on it
 * so DB-side adapters can scope their writes.
 */
export interface ApplyContext {
  userId: string;
  projectId: string;
  /** May be absent for kinds that don't need a browser (e.g. data_fixture API seed). */
  page?: Page;
  context?: BrowserContext;
  /**
   * Run-scoped key/value store. Adapters write into it so downstream
   * adapters can read (e.g. `scenario_setup` composes values from
   * children, `variables` seeds initial state, `secret` exposes values
   * for `{{secrets.X}}` interpolation in steps).
   */
  runVariables: Map<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  /** When valid, normalized config/sensitive as the adapter wants them stored. */
  normalized?: {
    config: Record<string, unknown>;
    sensitive?: Record<string, unknown>;
  };
}

/**
 * ResourceAdapter — one per kind. The registry picks the right adapter
 * by `kind` at runtime.
 *
 * Design principles:
 *   - Validate on the way IN (create/update) so bad data never lands in DB.
 *   - Apply must be idempotent: runners may re-apply on retry.
 *   - Teardown is strictly optional; kinds that don't mutate external
 *     state (auth, device) skip it.
 *   - Heal/capture only matter for kinds with lifecycle; static resources
 *     (secret, environment) leave them undefined.
 */
export interface ResourceAdapter<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSensitive extends Record<string, unknown> = Record<string, unknown>,
> {
  kind: ResourceKind;

  /** Validate + normalize user input before we encrypt/store. */
  validate(input: {
    config: unknown;
    sensitive?: unknown;
    scope?: unknown;
  }): ValidationResult;

  /**
   * Which config fields contain secrets and must be moved into the
   * encrypted envelope. Returned as the sensitive-side keys; everything
   * else stays in `config`. Empty list = nothing to encrypt.
   */
  sensitiveFields(): string[];

  /** Apply the resource to a running test. Called before the first step. */
  apply(ctx: ApplyContext, resource: DecryptedResource<TConfig, TSensitive>): Promise<void>;

  /** Optional reverse — run on test completion (success or failure). */
  teardown?(ctx: ApplyContext, resource: DecryptedResource<TConfig, TSensitive>): Promise<void>;

  /**
   * Is this resource still usable without a refresh?
   * Default: true for kinds with no TTL.
   */
  isFresh?(resource: DecryptedResource<TConfig, TSensitive>): boolean;

  /**
   * Restore a stale resource in-place. Called by the runner between
   * steps when auth loss is detected, or before a batch when
   * precautionary refresh is scheduled.
   * Must call back into TestResourceService.captureState to persist the
   * refreshed state — the service is the sole writer of the `sensitive`
   * column.
   */
  heal?(ctx: ApplyContext, resource: DecryptedResource<TConfig, TSensitive>): Promise<void>;

  /**
   * Capture current state into a fresh resource payload. Used by the
   * preview "save login" flow — the user finishes logging in, we ask
   * the auth adapter to snapshot the live context, and the result is
   * handed back to the create/update call.
   */
  capture?(ctx: ApplyContext): Promise<{
    config: TConfig;
    sensitive?: TSensitive;
  }>;
}
