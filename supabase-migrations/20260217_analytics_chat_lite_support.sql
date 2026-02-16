-- ============================================================================
-- ANALYTICS: Support Chat Lite tests in regression_runs / test_executions
-- ============================================================================
-- Chat Lite tests run ad-hoc without a saved test case.
-- Allow test_case_id to be NULL so ad-hoc runs can be tracked.
-- Also widen the trigger CHECK to include 'webhook'.
-- ============================================================================

-- 1) Make test_executions.test_case_id nullable (ad-hoc / chat-lite runs have no saved test case)
ALTER TABLE test_executions
  ALTER COLUMN test_case_id DROP NOT NULL;

-- 2) Widen trigger CHECK to include 'webhook' (already used in code)
ALTER TABLE regression_runs
  DROP CONSTRAINT IF EXISTS regression_runs_trigger_check;

ALTER TABLE regression_runs
  ADD CONSTRAINT regression_runs_trigger_check
  CHECK (trigger IN ('manual', 'chat', 'scheduled', 'webhook'));
