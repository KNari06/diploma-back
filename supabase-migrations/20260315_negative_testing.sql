-- =============================================================================
-- Negative Testing Feature — DB Migration
-- =============================================================================
-- Adds support for:
-- 1. Toggle on regression plan items (with inheritance)
-- 2. Negative test case metadata on intent_test_cases
-- 3. Negative flag on test_executions for report splitting

-- 1. Toggle on plan items (null = inherit from parent, true = on, false = off)
ALTER TABLE regression_plan_items
  ADD COLUMN IF NOT EXISTS negative_testing_enabled BOOLEAN DEFAULT NULL;

-- 2. Negative test case fields on intent_test_cases
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS is_negative BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source_intent_test_case_id UUID REFERENCES intent_test_cases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS negative_meta JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS negative_stale_reason TEXT DEFAULT NULL;

-- 3. Track negatives in executions
ALTER TABLE test_executions
  ADD COLUMN IF NOT EXISTS is_negative BOOLEAN DEFAULT FALSE;

-- 4. Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_source
  ON intent_test_cases(source_intent_test_case_id)
  WHERE source_intent_test_case_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intent_test_cases_negative
  ON intent_test_cases(is_negative)
  WHERE is_negative = TRUE;

CREATE INDEX IF NOT EXISTS idx_test_executions_negative
  ON test_executions(run_id, is_negative);

-- 5. Comment documentation
COMMENT ON COLUMN regression_plan_items.negative_testing_enabled IS 'Negative testing toggle: null=inherit from parent, true=enabled, false=disabled';
COMMENT ON COLUMN intent_test_cases.is_negative IS 'Whether this test case is a generated negative/boundary test';
COMMENT ON COLUMN intent_test_cases.source_intent_test_case_id IS 'FK to the parent happy-path test case that this negative was generated from';
COMMENT ON COLUMN intent_test_cases.negative_meta IS 'JSON: {mutationType, mutatedStepIndex, originalValue, mutatedValue, expectedBehavior}';
COMMENT ON COLUMN intent_test_cases.negative_stale_reason IS 'If set, indicates the negative is stale (e.g. parent_steps_changed)';
COMMENT ON COLUMN test_executions.is_negative IS 'Whether this execution is for a negative test case';
