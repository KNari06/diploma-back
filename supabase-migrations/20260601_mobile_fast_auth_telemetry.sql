-- ============================================================================
-- Mobile Fast-Auth Telemetry (May 2026)
-- ============================================================================
-- Purpose: Measure adoption + reliability of fast-auth (mobile equivalent
-- of web's storageState injection). Three questions we need to answer
-- after two weeks of production use:
--
--   1. Of mobile tests that have an auth binding, what fraction
--      successfully used a snapshot (skipped login recipe entirely)?
--      → COUNT(fast_auth_used = TRUE) / COUNT(fast_auth_used IS NOT NULL)
--
--   2. When fast-auth WAS used, how much time per test did it save vs
--      recipe replay? → median(fast_auth_restore_ms) vs median(scenario_steps_ms)
--      for tests with auth binding but no snapshot.
--
--   3. When fast-auth failed at runtime, why? → GROUP BY fast_auth_fallback_reason
--      surfaces privilege errors, launch failures, and 5xx blips so we
--      know whether the 5 MB cap, the privilege chain, or something else
--      is the actual bottleneck.
--
-- All columns are NULLABLE on purpose — matches the Phase 2 contract:
--   - fast_auth_used = TRUE  → snapshot restored + app launched
--   - fast_auth_used = FALSE → restore was attempted but failed; the
--                              fallback_reason carries the why
--   - fast_auth_used = NULL  → no fast-auth path was attempted (no
--                              snapshot present, web test, or pre-fast-
--                              auth row). Distinct from FALSE on purpose.
--
-- Safe to run on a busy production DB: ADD COLUMN ... NULL is metadata-
-- only on Postgres (no table rewrite, no row locks). Mirrors
-- 20260516_mobile_telemetry.sql's deployment characteristics.
-- ============================================================================

-- ── test_executions: per-test fast-auth state ────────────────────────────
ALTER TABLE test_executions
  ADD COLUMN IF NOT EXISTS fast_auth_used             BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS fast_auth_restore_ms       INTEGER NULL,
  ADD COLUMN IF NOT EXISTS fast_auth_fallback_reason  TEXT    NULL;

COMMENT ON COLUMN test_executions.fast_auth_used IS
  'Fast-auth (May 2026): TRUE when a mobileSnapshot was successfully restored AND the app launched, skipping the login recipe entirely. FALSE when attempted but failed (see fast_auth_fallback_reason). NULL when not attempted (no snapshot, web run, or pre-fast-auth row) — distinct from FALSE.';
COMMENT ON COLUMN test_executions.fast_auth_restore_ms IS
  'Fast-auth: wallclock of the runner restoreAppData call (pm clear + untar + chown + monkey launch) in ms. NULL when fast_auth_used is NULL.';
COMMENT ON COLUMN test_executions.fast_auth_fallback_reason IS
  'Fast-auth: one-line reason restore failed (privilege chain rejected, launch did not confirm, runner 5xx). NULL when fast_auth_used is TRUE or NULL. Truncated to 200 chars at write-time.';

-- Index for "what's the success rate this week" admin queries. Partial
-- index — skips the NULL-majority of rows so it stays cheap to maintain.
CREATE INDEX IF NOT EXISTS idx_test_executions_fast_auth_completed_at
  ON test_executions (completed_at DESC)
  WHERE fast_auth_used IS NOT NULL;

-- ── regression_runs: per-run aggregates ──────────────────────────────────
-- These columns let the admin/regression-metrics endpoint compute the
-- savings story without re-aggregating test_executions on every request.
-- Aggregation happens in TestCompletionHandlerService.recomputeRunStatus
-- — the same single funnel that already writes total_app_setup_ms /
-- cold_start_count etc. No other code path writes to these columns.
ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS fast_auth_used_count       INTEGER NULL,
  ADD COLUMN IF NOT EXISTS fast_auth_fallback_count   INTEGER NULL,
  ADD COLUMN IF NOT EXISTS total_fast_auth_restore_ms INTEGER NULL;

COMMENT ON COLUMN regression_runs.fast_auth_used_count IS
  'Fast-auth: COUNT(test_executions) where fast_auth_used = TRUE in this run. NULL for pre-fast-auth runs or web-only runs (no contributing rows).';
COMMENT ON COLUMN regression_runs.fast_auth_fallback_count IS
  'Fast-auth: COUNT(test_executions) where fast_auth_used = FALSE in this run. A value > 0 with snapshots still present in DB means runtime restore is unreliable for this project — investigate via fast_auth_fallback_reason on the underlying rows.';
COMMENT ON COLUMN regression_runs.total_fast_auth_restore_ms IS
  'Fast-auth: SUM(test_executions.fast_auth_restore_ms) for this run. Compare with total_scenario_ms to see the savings story per run.';
