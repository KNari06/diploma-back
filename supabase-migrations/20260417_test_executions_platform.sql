-- Add `platform` column to `test_executions`.
--
-- Purpose: `regression_runs` can contain a mix of web and mobile cases (per
-- plan), and reports / frontend panels need to know what kind of execution
-- each row represents so they can render the right artifacts (screenshots,
-- device traces, mobile compiled plans, etc.).
--
-- We already have `intent_test_cases.platform`, but joining to it from every
-- report query is expensive (denormalised context is the pattern used for
-- other fields like module_id/flow_id already on this table).
--
-- Backward compatibility: nullable column — old rows have NULL, new rows
-- get the value copied from the source `intent_test_cases.platform` at
-- batch create time (ExecutionService.createBatch).
--
-- No CHECK constraint: web cases use 'web', mobile use 'mobile_android'
-- today, plus future 'mobile_ios' / 'mobile_flutter' / 'mobile_react_native'.
-- Intentionally lax — the source `intent_test_cases.platform` column owns
-- the enum, this denormalised copy just mirrors it.

ALTER TABLE test_executions
  ADD COLUMN IF NOT EXISTS platform TEXT;

-- Filtered index: NULL rows are legacy (pre-mobile); only index the few
-- mobile executions so cardinality stays low.
CREATE INDEX IF NOT EXISTS idx_test_executions_platform
  ON test_executions (run_id, platform)
  WHERE platform IS NOT NULL AND platform != 'web';

COMMENT ON COLUMN test_executions.platform IS
  'Denormalised copy of intent_test_cases.platform. Null for legacy rows; ''web'' / ''mobile_android'' / … for newer runs.';
