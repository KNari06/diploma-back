-- Chain-view feature: let a `tests` row know which `regression_runs` row
-- dispatched it, so a segmented (link_test_case) run's segments can be
-- queried back together and rendered as one chain.
--
-- WHY: a chained run creates exactly ONE `regression_runs` row (never one
-- per segment) and one `tests` row per segment, but nothing on disk records
-- which `tests` rows belong to the same run — `regression_runs.test_id` only
-- ever points at whichever segment dispatched most recently. This column is
-- the missing link, populated going forward only (no backfill — historical
-- chain runs keep showing as today's disconnected single rows).
--
-- Scope: only the single-test-case dispatch path (`RegressionRunService.
-- runSavedTestCase` and everything that calls it) populates this column.
-- Bulk plan/module/flow/priority runs already have their own multi-test
-- grouping via `regression_runs.test_ids` and are intentionally left NULL
-- here — they don't need chain view.
--
-- Idempotent: IF NOT EXISTS throughout.

ALTER TABLE tests ADD COLUMN IF NOT EXISTS regression_run_id UUID REFERENCES regression_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tests_regression_run_id ON tests(regression_run_id) WHERE regression_run_id IS NOT NULL;
