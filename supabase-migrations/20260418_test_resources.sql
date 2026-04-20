-- ═══════════════════════════════════════════════════════════════════════════
-- TEST RESOURCES — universal reusable-resource layer for test cases
--
-- Problem: "session" is just one class of thing duplicated between tests.
-- Environments, data fixtures, secrets, device profiles, network mocks,
-- file assets, etc. all suffer the same N× duplication. Building a
-- dedicated table + service per type (auth_profiles, env_profiles,
-- secret_vaults, ...) explodes into 10 parallel systems that share 80%
-- of their behavior (CRUD, encryption, TTL, healing, defaults, RLS).
--
-- Solution: one polymorphic table `test_resources` discriminated by
-- `kind`. Common lifecycle (status, TTL, heal) lives on the row; type-
-- specific shape lives in JSONB (`config` + `sensitive` encrypted blob).
-- Tests bind to resources via a JSONB array instead of N foreign keys.
--
-- First supported kind: 'auth' — replaces what would have been the
-- `auth_profiles` table. Future kinds (environment, secret, device,
-- data_fixture, network, file, oauth_token, scenario_setup, variables)
-- plug in via the same schema.
--
-- Tables:
--   * test_resources                — the resource itself
--   * workspace_resource_defaults   — "for new tests matching scope X,
--                                      auto-bind resource Y"
-- Column added:
--   * intent_test_cases.resource_bindings JSONB
--     (array of { kind, resource_id } — replaces would-be auth_profile_id)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- test_resources — the universal resource table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS test_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership (same user_id + project_id pattern used elsewhere)
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- ── Discriminator ─────────────────────────────────────────────────────────
  -- `kind` selects which adapter handles this row. New kinds are added to
  -- the CHECK list as adapters ship. Unknown kinds are a fail-fast error
  -- rather than silent garbage.
  kind TEXT NOT NULL CHECK (kind IN (
    'auth',            -- login state (cookies + localStorage + recipe)
    'environment',     -- base URL / feature flags / env variables
    'secret',          -- API keys / tokens for {{secrets.X}} interpolation
    'data_fixture',    -- DB seed / API pre-create + teardown
    'device',          -- viewport / userAgent / locale / geolocation
    'network',         -- throttling + mock rules
    'file',            -- fixture file for upload tests
    'oauth_token',     -- third-party access/refresh tokens
    'scenario_setup',  -- composable bundle of other resources
    'variables'        -- initial run-variable seed
  )),

  -- ── Identity ──────────────────────────────────────────────────────────────
  name TEXT NOT NULL,
  description TEXT,

  -- ── Scope ─────────────────────────────────────────────────────────────────
  -- Where this resource applies. Shape varies by kind but common keys:
  --   { platform: 'web'|'android'|'ios', domain: 'app.example.com',
  --     app_package: 'com.example.app', url_pattern: 'https://*.staging/*',
  --     tags: ['staging','critical'] }
  -- Defaults resolution matches on this.
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- ── Type-specific payload ─────────────────────────────────────────────────
  -- Non-sensitive config (baseUrl, viewport, etc). Free-form per kind;
  -- adapter.validate() enforces shape server-side.
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Encrypted blob (envelope: { fieldName: "iv:authTag:ciphertext" })
  -- Stored as jsonb so schema stays queryable (hasSensitive = mfa_config IS NOT NULL)
  -- but cleartext is never in the DB.
  sensitive JSONB,

  -- ── Lifecycle (shared across all kinds that have one) ─────────────────────
  -- 🟢 active  — fresh and ready
  -- 🟡 stale   — past TTL / self-healable
  -- 🔴 broken  — cannot auto-recover, needs user re-record
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'broken')),
  broken_reason TEXT,

  -- Freshness: when state was captured, when it goes stale.
  -- NULL for kinds that never expire (environment, device, secret).
  captured_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  ttl_seconds INTEGER CHECK (ttl_seconds IS NULL OR ttl_seconds > 0),

  -- ── Refresh / healing ─────────────────────────────────────────────────────
  -- How the adapter restores freshness.
  --   none        — static resource, no refresh (env, device)
  --   ui_recipe   — replay `recipe` in a browser context (auth heal)
  --   api         — POST to refresh endpoint (OAuth refresh token)
  --   manual      — user must re-record (no automation possible)
  refresh_method TEXT NOT NULL DEFAULT 'none' CHECK (
    refresh_method IN ('none', 'ui_recipe', 'api', 'manual')
  ),
  -- Shape depends on method: {endpoint, bodyTemplate, tokenPath} for api;
  -- {timeoutMs, retry} for ui_recipe; unused for none/manual.
  refresh_config JSONB,

  -- Steps replayed when refresh_method = 'ui_recipe'. Same IntentStep[]
  -- shape as intent_test_cases.steps_json so the existing CommandExecutor
  -- can run it without special handling.
  recipe JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ── Observability ─────────────────────────────────────────────────────────
  last_used_at TIMESTAMPTZ,
  last_healed_at TIMESTAMPTZ,
  heal_count INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- workspace_resource_defaults — "for new tests matching scope, auto-bind X"
-- ─────────────────────────────────────────────────────────────────────────────
-- This is what makes the feature invisible in the happy path: user sets
-- a default once per (kind, scope), and every new test gets the binding
-- injected automatically on creation.
--
-- Scope key is polymorphic (domain for web, app_package for mobile,
-- url_pattern for env). COALESCE on the unique index keeps "null key"
-- rows distinct without requiring a partial index per kind.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspace_resource_defaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  kind TEXT NOT NULL CHECK (kind IN (
    'auth', 'environment', 'secret', 'data_fixture', 'device',
    'network', 'file', 'oauth_token', 'scenario_setup', 'variables'
  )),

  -- Target keys (zero-or-more may apply — one default per unique combo)
  platform TEXT CHECK (platform IS NULL OR platform IN ('web', 'android', 'ios')),
  domain TEXT,
  app_package TEXT,
  url_pattern TEXT,

  resource_id UUID NOT NULL REFERENCES test_resources(id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One default per (owner, kind, target). COALESCE turns nulls into empty
-- strings so (domain=null, app_package=null) and (domain='x', app_package=null)
-- remain distinct unique keys.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_resource_default_target
  ON workspace_resource_defaults (
    project_id,
    user_id,
    kind,
    COALESCE(platform, ''),
    COALESCE(domain, ''),
    COALESCE(app_package, ''),
    COALESCE(url_pattern, '')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- intent_test_cases.resource_bindings
-- ─────────────────────────────────────────────────────────────────────────────
-- Array of { kind, resource_id } bindings. Replaces would-be columns like
-- auth_profile_id / environment_id / device_profile_id — tests can depend
-- on arbitrary N resources without schema churn.
--
-- Shape (TypeScript):
--   Array<{ kind: ResourceKind; resource_id: UUID; required?: boolean }>
--
-- `required: false` makes a binding "soft" (runner continues if resource
-- is missing/broken) — useful for optional environment overrides.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS resource_bindings JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Resource lookup by owner (hot path for list screens)
CREATE INDEX IF NOT EXISTS idx_test_resources_project_user
  ON test_resources(project_id, user_id);

-- Kind-filtered listings (e.g. "all auth resources in this project")
CREATE INDEX IF NOT EXISTS idx_test_resources_project_kind
  ON test_resources(project_id, kind);

-- Scope-based default resolution. GIN handles arbitrary-key lookups on
-- the `scope` jsonb ("all resources where scope.domain = X").
CREATE INDEX IF NOT EXISTS idx_test_resources_scope
  ON test_resources USING GIN (scope);

-- Precautionary refresh scan (find resources expiring within the batch window)
CREATE INDEX IF NOT EXISTS idx_test_resources_expires_at
  ON test_resources(expires_at) WHERE expires_at IS NOT NULL;

-- Status filter (UI alerts surface broken rows first)
CREATE INDEX IF NOT EXISTS idx_test_resources_status
  ON test_resources(status) WHERE status <> 'active';

-- Default resolution hot path
CREATE INDEX IF NOT EXISTS idx_resource_defaults_project_user_kind
  ON workspace_resource_defaults(project_id, user_id, kind);

-- Tests-that-bind-this-resource queries (sidebar grouping, delete-with-dependents).
-- GIN on a JSONB array indexes each element for fast containment matches:
--   WHERE resource_bindings @> '[{"resource_id":"..."}]'
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_resource_bindings
  ON intent_test_cases USING GIN (resource_bindings);

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-update updated_at
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_test_resources_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_test_resources_updated_at ON test_resources;
CREATE TRIGGER trigger_test_resources_updated_at
  BEFORE UPDATE ON test_resources
  FOR EACH ROW EXECUTE FUNCTION update_test_resources_updated_at();

CREATE OR REPLACE FUNCTION update_resource_defaults_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_resource_defaults_updated_at ON workspace_resource_defaults;
CREATE TRIGGER trigger_resource_defaults_updated_at
  BEFORE UPDATE ON workspace_resource_defaults
  FOR EACH ROW EXECUTE FUNCTION update_resource_defaults_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — owner-only access on both tables
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE test_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_resource_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own test resources"
  ON test_resources FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can insert own test resources"
  ON test_resources FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can update own test resources"
  ON test_resources FOR UPDATE
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can delete own test resources"
  ON test_resources FOR DELETE
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can view own resource defaults"
  ON workspace_resource_defaults FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can insert own resource defaults"
  ON workspace_resource_defaults FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can update own resource defaults"
  ON workspace_resource_defaults FOR UPDATE
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can delete own resource defaults"
  ON workspace_resource_defaults FOR DELETE
  USING (user_id = auth.uid()::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- Comments
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE test_resources IS 'Polymorphic reusable resources shared across test cases. Kind selects adapter (auth/environment/secret/data_fixture/device/network/file/oauth_token/scenario_setup/variables).';
COMMENT ON COLUMN test_resources.kind IS 'Discriminator — selects the adapter that validates config and applies the resource at runtime.';
COMMENT ON COLUMN test_resources.scope IS 'Where the resource applies (platform/domain/app_package/url_pattern/tags). Used for default resolution on test creation.';
COMMENT ON COLUMN test_resources.config IS 'Non-sensitive type-specific payload (baseUrl, viewport, etc). Shape enforced by the kind adapter.';
COMMENT ON COLUMN test_resources.sensitive IS 'Envelope of AES-256-GCM ciphertexts keyed by field name. Never contains cleartext.';
COMMENT ON COLUMN test_resources.recipe IS 'IntentStep[] replayed when refresh_method=ui_recipe (e.g. auth heal).';
COMMENT ON COLUMN test_resources.refresh_method IS 'none | ui_recipe | api | manual — how the adapter restores freshness.';

COMMENT ON TABLE workspace_resource_defaults IS 'Smart defaults — "for new tests matching this scope, auto-bind resource X". Driven by a UI checkbox at creation time.';

COMMENT ON COLUMN intent_test_cases.resource_bindings IS 'Array of {kind, resource_id, required?} — test binds to N resources without per-kind FK columns.';
