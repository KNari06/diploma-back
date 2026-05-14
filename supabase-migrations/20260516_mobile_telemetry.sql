-- ============================================================================
-- Phase 2: Mobile Regression Telemetry
-- ============================================================================
-- Purpose: Capture per-test and per-run wallclock breakdowns so future
-- decisions about parallelism (Phase 4), scenario caching (Phase 5), and
-- infrastructure scaling (Phase 7+) are data-driven rather than hypothetical.
--
-- All columns are NULLABLE on purpose:
--   - Web/API jobs leave them NULL (Phase 2 instruments mobile only).
--   - Legacy rows pre-migration are NULL.
--   - Reading code MUST coalesce(col, 0) or filter `WHERE col IS NOT NULL`.
--
-- No DEFAULT 0 because "0 ms" is semantically distinct from "we don't
-- know" — aggregation queries must distinguish.
--
-- Safe to run on a busy production DB: ADD COLUMN ... NULL is a Postgres
-- metadata-only change (no table rewrite, no row locks).
-- ============================================================================

-- ── test_executions: per-test breakdown ──────────────────────────────────
ALTER TABLE test_executions
  ADD COLUMN IF NOT EXISTS app_setup_ms        INTEGER NULL,
  ADD COLUMN IF NOT EXISTS scenario_steps_ms   INTEGER NULL,
  ADD COLUMN IF NOT EXISTS test_steps_ms       INTEGER NULL,
  ADD COLUMN IF NOT EXISTS session_claim_ms    INTEGER NULL,
  ADD COLUMN IF NOT EXISTS cold_start_used     BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS scenario_step_count INTEGER NULL,
  ADD COLUMN IF NOT EXISTS test_step_count     INTEGER NULL;

COMMENT ON COLUMN test_executions.app_setup_ms IS
  'Phase 2 telemetry: pm clear + relaunch + APK install wallclock for the mobile job. NULL for non-mobile or pre-Phase-2 rows.';
COMMENT ON COLUMN test_executions.scenario_steps_ms IS
  'Phase 2 telemetry: sum of MobileStepResult.durationMs for prepended scenario_setup steps. NULL if no scenario binding or non-mobile.';
COMMENT ON COLUMN test_executions.test_steps_ms IS
  'Phase 2 telemetry: sum of MobileStepResult.durationMs for user-authored test steps (everything after the scenario prefix). NULL for non-mobile.';
COMMENT ON COLUMN test_executions.session_claim_ms IS
  'Phase 2 telemetry: wallclock of the pool -> warmup -> cold claim ladder. Includes cold-start emulator boot when it falls through. NULL for non-mobile.';
COMMENT ON COLUMN test_executions.cold_start_used IS
  'Phase 2 telemetry: TRUE when sessionSource === "cold" (no pool slot, no warmup hit). NULL for non-mobile.';
COMMENT ON COLUMN test_executions.scenario_step_count IS
  'Phase 2 telemetry: number of scenario steps prepended (= compileResult.steps.length). NULL when there is no scenario binding or non-mobile.';
COMMENT ON COLUMN test_executions.test_step_count IS
  'Phase 2 telemetry: number of user-authored test steps. NULL for non-mobile.';

-- Index for time-range queries (the most common admin-metrics access pattern).
-- Partial index keeps it small — only mobile rows contribute meaningful values.
CREATE INDEX IF NOT EXISTS idx_test_executions_telemetry_completed_at
  ON test_executions (completed_at DESC)
  WHERE app_setup_ms IS NOT NULL;

-- ── regression_runs: per-run aggregates ──────────────────────────────────
ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS test_count          INTEGER NULL,
  ADD COLUMN IF NOT EXISTS total_duration_ms   INTEGER NULL,
  ADD COLUMN IF NOT EXISTS total_app_setup_ms  INTEGER NULL,
  ADD COLUMN IF NOT EXISTS total_scenario_ms   INTEGER NULL,
  ADD COLUMN IF NOT EXISTS total_test_steps_ms INTEGER NULL,
  ADD COLUMN IF NOT EXISTS cold_start_count    INTEGER NULL;

COMMENT ON COLUMN regression_runs.test_count IS
  'Phase 2 telemetry: COUNT of test_executions rows in this run. NULL for pre-Phase-2 rows.';
COMMENT ON COLUMN regression_runs.total_duration_ms IS
  'Phase 2 telemetry: completed_at - started_at in ms. Includes queueing, pool waits, and any inter-test gaps. NULL when started_at is missing.';
COMMENT ON COLUMN regression_runs.total_app_setup_ms IS
  'Phase 2 telemetry: SUM of test_executions.app_setup_ms for this run. NULL for pure-web runs (no contributing rows).';
COMMENT ON COLUMN regression_runs.total_scenario_ms IS
  'Phase 2 telemetry: SUM of test_executions.scenario_steps_ms for this run. NULL for pure-web runs.';
COMMENT ON COLUMN regression_runs.total_test_steps_ms IS
  'Phase 2 telemetry: SUM of test_executions.test_steps_ms for this run. NULL for pure-web runs.';
COMMENT ON COLUMN regression_runs.cold_start_count IS
  'Phase 2 telemetry: COUNT of test_executions with cold_start_used = TRUE. NULL for pure-web runs.';

-- Index for time-range admin queries. Partial: skips legacy NULL rows.
CREATE INDEX IF NOT EXISTS idx_regression_runs_completed_at_telemetry
  ON regression_runs (completed_at DESC)
  WHERE total_duration_ms IS NOT NULL;
