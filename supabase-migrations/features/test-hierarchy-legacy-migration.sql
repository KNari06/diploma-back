-- ============================================================================
-- TEST HIERARCHY LEGACY MIGRATION
-- ============================================================================
-- Migrates existing test data to new hierarchy structure
-- Creates default modules, suites, flows for orphan tests
-- Run AFTER all new tables and alterations are applied
-- ============================================================================

-- ============================================================================
-- 1. CREATE DEFAULT "Unassigned" MODULE FOR EACH PROJECT
-- ============================================================================

-- For projects with saved_test_cases
INSERT INTO test_modules (project_id, user_id, name, description, tags)
SELECT DISTINCT
  stc.project_id,
  stc.user_id,
  'Unassigned',
  'Auto-created for legacy tests',
  ARRAY['legacy', 'unassigned']
FROM saved_test_cases stc
WHERE NOT EXISTS (
  SELECT 1 FROM test_modules tm
  WHERE tm.project_id = stc.project_id
    AND tm.name = 'Unassigned'
)
ON CONFLICT DO NOTHING;

-- For projects with intent_test_cases
INSERT INTO test_modules (project_id, user_id, name, description, tags)
SELECT DISTINCT
  itc.project_id,
  itc.user_id,
  'Unassigned',
  'Auto-created for legacy tests',
  ARRAY['legacy', 'unassigned']
FROM intent_test_cases itc
WHERE NOT EXISTS (
  SELECT 1 FROM test_modules tm
  WHERE tm.project_id = itc.project_id
    AND tm.name = 'Unassigned'
)
ON CONFLICT DO NOTHING;

-- For projects with regression_suites that have no module
INSERT INTO test_modules (project_id, user_id, name, description, tags)
SELECT DISTINCT
  rs.project_id,
  rs.user_id,
  'Unassigned',
  'Auto-created for legacy tests',
  ARRAY['legacy', 'unassigned']
FROM regression_suites rs
WHERE rs.module_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM test_modules tm
    WHERE tm.project_id = rs.project_id
      AND tm.name = 'Unassigned'
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 2. ASSIGN ORPHAN REGRESSION_SUITES TO UNASSIGNED MODULE
-- ============================================================================

UPDATE regression_suites rs
SET module_id = tm.id
FROM test_modules tm
WHERE rs.module_id IS NULL
  AND tm.project_id = rs.project_id
  AND tm.name = 'Unassigned';

-- ============================================================================
-- 3. CREATE DEFAULT UI SUITE IN EACH UNASSIGNED MODULE
-- ============================================================================

INSERT INTO regression_suites (project_id, user_id, module_id, name, suite_type, description)
SELECT
  tm.project_id,
  tm.user_id,
  tm.id,
  'Legacy UI Tests',
  'ui',
  'Auto-created for legacy UI tests'
FROM test_modules tm
WHERE tm.name = 'Unassigned'
AND NOT EXISTS (
  SELECT 1 FROM regression_suites rs
  WHERE rs.module_id = tm.id
    AND rs.name = 'Legacy UI Tests'
);

-- ============================================================================
-- 4. CREATE DEFAULT API SUITE IN EACH UNASSIGNED MODULE
-- ============================================================================

INSERT INTO regression_suites (project_id, user_id, module_id, name, suite_type, description)
SELECT
  tm.project_id,
  tm.user_id,
  tm.id,
  'Legacy API Tests',
  'api',
  'Auto-created for legacy API tests'
FROM test_modules tm
WHERE tm.name = 'Unassigned'
AND NOT EXISTS (
  SELECT 1 FROM regression_suites rs
  WHERE rs.module_id = tm.id
    AND rs.name = 'Legacy API Tests'
);

-- ============================================================================
-- 5. CREATE DEFAULT FLOW IN EACH LEGACY SUITE
-- ============================================================================

-- Default flow for UI suite
INSERT INTO test_flows (suite_id, user_id, name, flow_type, order_index, description)
SELECT
  rs.id,
  rs.user_id,
  'Default Flow',
  'ui',
  0,
  'Auto-created for legacy UI tests'
FROM regression_suites rs
WHERE rs.name = 'Legacy UI Tests'
AND NOT EXISTS (
  SELECT 1 FROM test_flows tf
  WHERE tf.suite_id = rs.id
    AND tf.name = 'Default Flow'
);

-- Default flow for API suite
INSERT INTO test_flows (suite_id, user_id, name, flow_type, order_index, description)
SELECT
  rs.id,
  rs.user_id,
  'Default Flow',
  'api',
  0,
  'Auto-created for legacy API tests'
FROM regression_suites rs
WHERE rs.name = 'Legacy API Tests'
AND NOT EXISTS (
  SELECT 1 FROM test_flows tf
  WHERE tf.suite_id = rs.id
    AND tf.name = 'Default Flow'
);

-- ============================================================================
-- 6. ASSIGN ORPHAN SAVED_TEST_CASES TO DEFAULT UI FLOW
-- ============================================================================

UPDATE saved_test_cases stc
SET flow_id = tf.id
FROM test_flows tf
JOIN regression_suites rs ON tf.suite_id = rs.id
JOIN test_modules tm ON rs.module_id = tm.id
WHERE stc.flow_id IS NULL
  AND tm.project_id = stc.project_id
  AND tm.name = 'Unassigned'
  AND rs.name = 'Legacy UI Tests'
  AND tf.name = 'Default Flow';

-- ============================================================================
-- 7. ASSIGN ORPHAN INTENT_TEST_CASES TO DEFAULT UI FLOW
-- ============================================================================

UPDATE intent_test_cases itc
SET flow_id = tf.id
FROM test_flows tf
JOIN regression_suites rs ON tf.suite_id = rs.id
JOIN test_modules tm ON rs.module_id = tm.id
WHERE itc.flow_id IS NULL
  AND tm.project_id = itc.project_id
  AND tm.name = 'Unassigned'
  AND rs.name = 'Legacy UI Tests'
  AND tf.name = 'Default Flow';

-- ============================================================================
-- 8. ASSIGN ORPHAN API_TEST_CONFIGS TO DEFAULT API FLOW
-- ============================================================================

-- This is more complex because api_test_configs links through api_endpoints -> api_environments -> project
UPDATE api_test_configs atc
SET flow_id = tf.id
FROM api_endpoints ae
JOIN api_environments env ON ae.environment_id = env.id
JOIN test_modules tm ON tm.project_id::text = env.project_id AND tm.name = 'Unassigned'
JOIN regression_suites rs ON rs.module_id = tm.id AND rs.name = 'Legacy API Tests'
JOIN test_flows tf ON tf.suite_id = rs.id AND tf.name = 'Default Flow'
WHERE atc.flow_id IS NULL
  AND atc.endpoint_id = ae.id;

-- ============================================================================
-- 9. SET DEFAULT SUITE_TYPE FOR EXISTING SUITES
-- ============================================================================

-- Default to 'ui' for suites without type (if column was just added)
UPDATE regression_suites
SET suite_type = 'ui'
WHERE suite_type IS NULL;

-- ============================================================================
-- VERIFICATION QUERIES (for manual checking)
-- ============================================================================

-- Count orphan tests after migration
-- SELECT
--   'saved_test_cases' as table_name,
--   COUNT(*) FILTER (WHERE flow_id IS NULL) as orphan_count,
--   COUNT(*) as total_count
-- FROM saved_test_cases
-- UNION ALL
-- SELECT
--   'intent_test_cases',
--   COUNT(*) FILTER (WHERE flow_id IS NULL),
--   COUNT(*)
-- FROM intent_test_cases
-- UNION ALL
-- SELECT
--   'api_test_configs',
--   COUNT(*) FILTER (WHERE flow_id IS NULL),
--   COUNT(*)
-- FROM api_test_configs
-- UNION ALL
-- SELECT
--   'regression_suites',
--   COUNT(*) FILTER (WHERE module_id IS NULL),
--   COUNT(*)
-- FROM regression_suites;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE test_modules IS 'Functional modules within a project - includes legacy Unassigned modules';
