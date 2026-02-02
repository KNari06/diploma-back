-- ============================================================================
-- REGRESSION TABLES: SWITCH FROM saved_test_cases TO intent_test_cases
-- ============================================================================
-- Purpose: Retarget regression_suite_items and regression_runs to reference
-- intent_test_cases instead of saved_test_cases.
-- ============================================================================

-- ============================================================================
-- 1) REGRESSION SUITE ITEMS: Add intent_test_case_id, drop saved_test_case_id
-- ============================================================================

-- Add new column referencing intent_test_cases
ALTER TABLE regression_suite_items
  ADD COLUMN IF NOT EXISTS intent_test_case_id UUID;

-- Add FK constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'regression_suite_items_intent_test_case_id_fkey'
  ) THEN
    ALTER TABLE regression_suite_items
      ADD CONSTRAINT regression_suite_items_intent_test_case_id_fkey
      FOREIGN KEY (intent_test_case_id)
      REFERENCES intent_test_cases(id)
      ON DELETE CASCADE;
  END IF;
END;
$$;

-- Drop old FK and column (since no real data)
ALTER TABLE regression_suite_items
  DROP CONSTRAINT IF EXISTS fk_saved_test_case;

ALTER TABLE regression_suite_items
  DROP CONSTRAINT IF EXISTS unique_suite_case;

ALTER TABLE regression_suite_items
  DROP COLUMN IF EXISTS saved_test_case_id;

-- Make intent_test_case_id required
ALTER TABLE regression_suite_items
  ALTER COLUMN intent_test_case_id SET NOT NULL;

-- Add unique constraint for suite + intent_test_case
ALTER TABLE regression_suite_items
  ADD CONSTRAINT unique_suite_intent_case UNIQUE (suite_id, intent_test_case_id);

-- Update index
DROP INDEX IF EXISTS idx_regression_suite_items_case;
CREATE INDEX IF NOT EXISTS idx_regression_suite_items_intent_case
  ON regression_suite_items(intent_test_case_id);

-- ============================================================================
-- 2) REGRESSION RUNS: Add intent_test_case_id, drop saved_test_case_id
-- ============================================================================

-- Add new column
ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS intent_test_case_id UUID;

-- Add FK constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'regression_runs_intent_test_case_id_fkey'
  ) THEN
    ALTER TABLE regression_runs
      ADD CONSTRAINT regression_runs_intent_test_case_id_fkey
      FOREIGN KEY (intent_test_case_id)
      REFERENCES intent_test_cases(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

-- Drop old FK and column
ALTER TABLE regression_runs
  DROP CONSTRAINT IF EXISTS fk_saved_test_case;

-- Drop the check constraint that references saved_test_case_id
ALTER TABLE regression_runs
  DROP CONSTRAINT IF EXISTS check_run_target;

ALTER TABLE regression_runs
  DROP COLUMN IF EXISTS saved_test_case_id;

-- Recreate check constraint with intent_test_case_id
ALTER TABLE regression_runs
  ADD CONSTRAINT check_run_target CHECK (
    (suite_id IS NOT NULL AND intent_test_case_id IS NULL) OR
    (suite_id IS NULL AND intent_test_case_id IS NOT NULL) OR
    (suite_id IS NULL AND intent_test_case_id IS NULL)
  );

-- Update index
DROP INDEX IF EXISTS idx_regression_runs_case;
CREATE INDEX IF NOT EXISTS idx_regression_runs_intent_case
  ON regression_runs(intent_test_case_id, started_at DESC)
  WHERE intent_test_case_id IS NOT NULL;

-- ============================================================================
-- 3) UPDATE SQL HELPER FUNCTION: get_suite_with_cases
-- ============================================================================

-- Drop and recreate function to use intent_test_cases
DROP FUNCTION IF EXISTS get_suite_with_cases(UUID);

CREATE OR REPLACE FUNCTION get_suite_with_cases(suite_uuid UUID)
RETURNS TABLE (
  suite_id UUID,
  suite_name TEXT,
  suite_description TEXT,
  case_id UUID,
  case_name TEXT,
  case_order INTEGER,
  case_status TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.description,
    c.id,
    c.name,
    i.order_index,
    c.status
  FROM regression_suites s
  LEFT JOIN regression_suite_items i ON s.id = i.suite_id
  LEFT JOIN intent_test_cases c ON i.intent_test_case_id = c.id
  WHERE s.id = suite_uuid
  ORDER BY
    CASE WHEN i.order_index IS NULL THEN 999999 ELSE i.order_index END,
    i.order_index NULLS LAST;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_suite_with_cases(UUID) IS
  'Returns suite with all test cases (from intent_test_cases) ordered by order_index. Includes case status.';

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN regression_suite_items.intent_test_case_id IS 'Reference to intent_test_cases.id (UI test case in the suite)';
COMMENT ON COLUMN regression_runs.intent_test_case_id IS 'Reference to intent_test_cases.id when running a single test case';

-- ============================================================================
-- SUCCESS
-- ============================================================================
