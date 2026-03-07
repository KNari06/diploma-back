-- ============================================================================
-- Add regression_run_id to git_webhook_deliveries
-- ============================================================================
-- Links webhook deliveries to their triggered regression runs,
-- enabling analytics to show real deployment test status
-- (passed / regression_flagged / pending / no_tests)
-- ============================================================================

ALTER TABLE git_webhook_deliveries
  ADD COLUMN IF NOT EXISTS regression_run_id UUID NULL REFERENCES regression_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_git_webhook_deliveries_regression_run_id
  ON git_webhook_deliveries(regression_run_id)
  WHERE regression_run_id IS NOT NULL;
