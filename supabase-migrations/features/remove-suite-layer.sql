-- ============================================================================
-- Migration: Remove Suite Layer from Test Hierarchy
-- ============================================================================
-- Changes hierarchy from: Platform → Module → Suite → Flow → TestCase
-- To: Platform → Module → Flow → TestCase
--
-- CRITICAL: Run this migration AFTER all code changes are deployed and verified.
-- This migration is irreversible and will delete all suite data.
-- ============================================================================

BEGIN;

-- ============================================================================
-- STEP 1: Add module_id to test_flows
-- ============================================================================

ALTER TABLE test_flows
ADD COLUMN IF NOT EXISTS module_id UUID;

-- ============================================================================
-- STEP 2: Migrate data from suite_id → module_id
-- ============================================================================

-- Copy module_id from regression_suites to test_flows
UPDATE test_flows
SET module_id = rs.module_id
FROM regression_suites rs
WHERE test_flows.suite_id = rs.id;

-- ============================================================================
-- STEP 3: Handle orphaned flows (defensive cleanup)
-- ============================================================================

-- Delete flows that have no module_id (orphaned flows with invalid suite_id)
DELETE FROM test_flows
WHERE module_id IS NULL;

-- ============================================================================
-- STEP 4: Make module_id NOT NULL and add foreign key
-- ============================================================================

ALTER TABLE test_flows
ALTER COLUMN module_id SET NOT NULL;

ALTER TABLE test_flows
ADD CONSTRAINT test_flows_module_id_fkey
FOREIGN KEY (module_id) REFERENCES test_modules(id) ON DELETE CASCADE;

-- ============================================================================
-- STEP 5: Drop suite_id from test_flows
-- ============================================================================

ALTER TABLE test_flows
DROP COLUMN IF EXISTS suite_id;

-- ============================================================================
-- STEP 6: Clean regression_plan_items with item_type='suite'
-- ============================================================================

-- Delete all plan items that reference suites
DELETE FROM regression_plan_items
WHERE item_type = 'suite';

-- Drop suite_id column from regression_plan_items
ALTER TABLE regression_plan_items
DROP COLUMN IF EXISTS suite_id;

-- ============================================================================
-- STEP 7: Recreate check constraints without 'suite'
-- ============================================================================

-- Drop old check constraints
ALTER TABLE regression_plan_items
DROP CONSTRAINT IF EXISTS check_item_target;

ALTER TABLE regression_plan_items
DROP CONSTRAINT IF EXISTS regression_plan_items_item_type_check;

-- Add new item_type check (module | flow | test_case)
ALTER TABLE regression_plan_items
ADD CONSTRAINT regression_plan_items_item_type_check
CHECK (item_type IN ('module', 'flow', 'test_case'));

-- Add new target check (exactly one of moduleId/flowId/testCaseId must be set)
ALTER TABLE regression_plan_items
ADD CONSTRAINT check_item_target CHECK (
  (item_type = 'module' AND module_id IS NOT NULL AND flow_id IS NULL AND test_case_id IS NULL) OR
  (item_type = 'flow' AND flow_id IS NOT NULL AND module_id IS NULL AND test_case_id IS NULL) OR
  (item_type = 'test_case' AND test_case_id IS NOT NULL AND test_case_type IS NOT NULL AND module_id IS NULL AND flow_id IS NULL)
);

-- ============================================================================
-- STEP 8: Drop suite_id from regression_runs
-- ============================================================================

-- Note: This drops historical data. Acceptable since suite_id is just metadata for filtering.
ALTER TABLE regression_runs
DROP COLUMN IF EXISTS suite_id;

-- ============================================================================
-- STEP 9: Drop suite_id from test_executions
-- ============================================================================

-- Note: This drops historical data. Acceptable since suite_id is just metadata for filtering.
ALTER TABLE test_executions
DROP COLUMN IF EXISTS suite_id;

-- ============================================================================
-- STEP 10: Drop suite_id from test_schedules
-- ============================================================================

-- Note: Schedules targeting suites will need to be recreated targeting modules or plans.
ALTER TABLE test_schedules
DROP COLUMN IF EXISTS suite_id;

-- ============================================================================
-- STEP 10b: Drop suite_id from git_integrations
-- ============================================================================

ALTER TABLE git_integrations
DROP COLUMN IF EXISTS suite_id;

-- ============================================================================
-- STEP 11: Drop regression_suite_items table
-- ============================================================================

DROP TABLE IF EXISTS regression_suite_items CASCADE;

-- ============================================================================
-- STEP 12: Drop regression_suites table
-- ============================================================================

DROP TABLE IF EXISTS regression_suites CASCADE;

-- ============================================================================
-- VERIFICATION QUERIES (commented out - run manually after migration)
-- ============================================================================

-- Verify all flows have module_id:
-- SELECT COUNT(*) FROM test_flows WHERE module_id IS NULL;
-- Expected: 0

-- Verify no suite references in plan items:
-- SELECT COUNT(*) FROM regression_plan_items WHERE item_type = 'suite';
-- Expected: 0

-- Verify suite tables are dropped:
-- SELECT tablename FROM pg_tables WHERE tablename IN ('regression_suites', 'regression_suite_items');
-- Expected: 0 rows

COMMIT;
