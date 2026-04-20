-- ═══════════════════════════════════════════════════════════════════════════
-- TEST RESOURCES — integrate with related test definition / execution tables
--
-- 20260418_test_resources.sql added `resource_bindings` only to
-- `intent_test_cases`. This follow-up threads the concept through every
-- other table that stores either (a) a test definition that should
-- declare what it needs, or (b) an execution record that should snapshot
-- what was actually used for reproducibility.
--
-- Why two migrations instead of one: the first one creates brand-new
-- tables and is self-contained; this one ALTERs existing, populated
-- tables and therefore must be careful about RLS, indexes, and types.
-- Splitting keeps both reviewable.
--
-- Tables touched:
--   1. regression_runs        — snapshot of resources actually used
--   2. test_executions        — per-test-case snapshot
--   3. api_test_executions    — API test snapshot (separate hierarchy)
--   4. api_test_configs       — bindings on API test definitions
--   5. regression_plan_items  — per-item override of bindings
--
-- NOT touched:
--   * regression_suite_items  — references intent_test_cases via FK,
--                               bindings flow through automatically
--   * saved_test_cases        — deprecated (superseded by intent_test_cases)
--   * mobile_app_builds       — artifact storage, not a test
--
-- Type note: api_test_* tables use `user_id UUID`; test_resources and
-- everything else use `user_id TEXT`. We DO NOT add FKs from executions
-- to resources because:
--   (a) the type mismatch would require a cast or a user_id rewrite,
--   (b) resources can be deleted after a run completes — snapshots
--       should survive as historical records, unlike FKs that cascade.
-- Snapshots are therefore stored as JSONB payloads, not FKs.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. regression_runs — snapshot of resources used for the whole run
-- ─────────────────────────────────────────────────────────────────────────────
-- Shape:
--   [{
--     "binding": { "kind": "auth", "resource_id": "...", "required": true },
--     "name": "Admin login",
--     "kind": "auth",
--     "status_at_start": "active" | "stale" | "broken",
--     "captured_at": "2026-04-18T12:00:00Z",
--     "healed_during_run": true | false
--   }, ...]
--
-- Never contains decrypted secrets — snapshot is for audit / replay
-- planning, not for re-use.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS executed_resources JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN regression_runs.executed_resources IS
  'Snapshot of test_resources used by this run (metadata only, no secrets). For reproducibility + audit.';

-- GIN so we can answer "which runs used this resource?" cheaply.
CREATE INDEX IF NOT EXISTS idx_regression_runs_executed_resources
  ON regression_runs USING GIN (executed_resources);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. test_executions — per-test-case snapshot
-- ─────────────────────────────────────────────────────────────────────────────
-- Same shape as regression_runs.executed_resources. Denormalized per
-- execution so we can answer "why did THIS test case fail when the run
-- itself had fresh resources" without rewinding aggregate state.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE test_executions
  ADD COLUMN IF NOT EXISTS executed_resources JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN test_executions.executed_resources IS
  'Per-execution snapshot of test_resources bound to this test case at run time (no secrets).';

CREATE INDEX IF NOT EXISTS idx_test_executions_executed_resources
  ON test_executions USING GIN (executed_resources);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. api_test_executions — parallel hierarchy (user_id is UUID here)
-- ─────────────────────────────────────────────────────────────────────────────
-- Even though api_test_configs lives in a separate tree (endpoint →
-- environment) we still want resource bindings so a user can inject
-- the same `Secret` or `OAuthToken` resource into both UI and API tests.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE api_test_executions
  ADD COLUMN IF NOT EXISTS executed_resources JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN api_test_executions.executed_resources IS
  'Snapshot of test_resources used by this API test run (no secrets).';

CREATE INDEX IF NOT EXISTS idx_api_test_executions_executed_resources
  ON api_test_executions USING GIN (executed_resources);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. api_test_configs — bindings on API test definitions
-- ─────────────────────────────────────────────────────────────────────────────
-- API tests have historically embedded auth in api_environments.auth_config.
-- Adding resource_bindings lets a config opt into the universal model
-- (e.g. bind to a shared OAuth token resource) without ripping out the
-- legacy path. Empty default = API tests keep working unchanged until
-- someone explicitly attaches a resource.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE api_test_configs
  ADD COLUMN IF NOT EXISTS resource_bindings JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN api_test_configs.resource_bindings IS
  'Array of {kind, resource_id, required?} — lets API tests share Secret/OAuth/Environment resources with UI tests.';

CREATE INDEX IF NOT EXISTS idx_api_test_configs_resource_bindings
  ON api_test_configs USING GIN (resource_bindings);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. regression_plan_items — per-item override of bindings
-- ─────────────────────────────────────────────────────────────────────────────
-- regression_plan_items already has `parameters_override` — we mirror
-- that pattern with `resource_bindings_override`. Semantics:
--   NULL / []  — use the test case's own bindings
--   non-empty  — replace entirely for this plan item only
-- (not merge — predictability matters more than ergonomics for
-- test config, and the override is always a small array).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE regression_plan_items
  ADD COLUMN IF NOT EXISTS resource_bindings_override JSONB;

COMMENT ON COLUMN regression_plan_items.resource_bindings_override IS
  'Override the test case resource_bindings for this plan item only. NULL = inherit. Non-null replaces (not merges).';

-- No GIN here — plan items are a join table queried by plan_id, so
-- scanning resource_bindings_override is never the hot path.

-- ═══════════════════════════════════════════════════════════════════════════
-- Notes for Phase 2 runner integration (informational, not DDL):
--   * manual-test-run.job.ts — read intent_test_cases.resource_bindings,
--     apply via adapter.apply(), record snapshot into test_executions.executed_resources.
--   * Supervisor (auto-heal) — on heal, set executed_resources[i].healed_during_run = true.
--   * Regression worker — aggregate per-test snapshots into regression_runs.executed_resources.
--   * API runner — resolve api_test_configs.resource_bindings, merge with
--     api_environments.auth_config (bindings win), snapshot into api_test_executions.
-- ═══════════════════════════════════════════════════════════════════════════
