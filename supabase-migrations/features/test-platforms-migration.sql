-- ============================================================================
-- TEST PLATFORMS DATA MIGRATION
-- ============================================================================
-- Seeds platforms per project, assigns platform_id to modules,
-- splits mixed modules, normalizes suite_type, sets platform_id NOT NULL
-- Run AFTER test-platforms.sql
-- ============================================================================

-- ============================================================================
-- 1. SEED TWO PLATFORMS PER PROJECT
-- ============================================================================
-- Create web_ui and api platforms for each project that has modules or exists

-- From projects that have test_modules
INSERT INTO test_platforms (project_id, user_id, platform_key, name, description)
SELECT DISTINCT
  tm.project_id,
  tm.user_id,
  'web_ui',
  'Web UI tests',
  'Web UI/UX test modules'
FROM test_modules tm
ON CONFLICT (project_id, platform_key) DO NOTHING;

INSERT INTO test_platforms (project_id, user_id, platform_key, name, description)
SELECT DISTINCT
  tm.project_id,
  tm.user_id,
  'api',
  'API tests',
  'API test modules'
FROM test_modules tm
ON CONFLICT (project_id, platform_key) DO NOTHING;

-- Also from projects that have regression_suites but no modules yet
INSERT INTO test_platforms (project_id, user_id, platform_key, name, description)
SELECT DISTINCT
  rs.project_id,
  rs.user_id,
  'web_ui',
  'Web UI tests',
  'Web UI/UX test modules'
FROM regression_suites rs
WHERE NOT EXISTS (
  SELECT 1 FROM test_platforms tp
  WHERE tp.project_id = rs.project_id AND tp.platform_key = 'web_ui'
)
ON CONFLICT (project_id, platform_key) DO NOTHING;

INSERT INTO test_platforms (project_id, user_id, platform_key, name, description)
SELECT DISTINCT
  rs.project_id,
  rs.user_id,
  'api',
  'API tests',
  'API test modules'
FROM regression_suites rs
WHERE NOT EXISTS (
  SELECT 1 FROM test_platforms tp
  WHERE tp.project_id = rs.project_id AND tp.platform_key = 'api'
)
ON CONFLICT (project_id, platform_key) DO NOTHING;

-- ============================================================================
-- 2. NORMALIZE SUITE_TYPE: CONVERT 'mixed' TO 'ui'
-- ============================================================================
-- Before strict enforcement, convert any 'mixed' suites to 'ui'
-- API suites remain 'api', UI suites remain 'ui'

UPDATE regression_suites
SET suite_type = 'ui'
WHERE suite_type = 'mixed' OR suite_type IS NULL;

-- ============================================================================
-- 3. ASSIGN PLATFORM_ID FOR MODULES (UI-only and API-only)
-- ============================================================================

-- Modules with only UI suites -> web_ui platform
UPDATE test_modules tm
SET platform_id = tp.id
FROM test_platforms tp
WHERE tp.project_id = tm.project_id
  AND tp.platform_key = 'web_ui'
  AND tm.platform_id IS NULL
  AND EXISTS (
    SELECT 1 FROM regression_suites rs
    WHERE rs.module_id = tm.id AND rs.suite_type = 'ui'
  )
  AND NOT EXISTS (
    SELECT 1 FROM regression_suites rs
    WHERE rs.module_id = tm.id AND rs.suite_type = 'api'
  );

-- Modules with only API suites -> api platform
UPDATE test_modules tm
SET platform_id = tp.id
FROM test_platforms tp
WHERE tp.project_id = tm.project_id
  AND tp.platform_key = 'api'
  AND tm.platform_id IS NULL
  AND EXISTS (
    SELECT 1 FROM regression_suites rs
    WHERE rs.module_id = tm.id AND rs.suite_type = 'api'
  )
  AND NOT EXISTS (
    SELECT 1 FROM regression_suites rs
    WHERE rs.module_id = tm.id AND rs.suite_type = 'ui'
  );

-- Modules with no suites -> default to web_ui platform
UPDATE test_modules tm
SET platform_id = tp.id
FROM test_platforms tp
WHERE tp.project_id = tm.project_id
  AND tp.platform_key = 'web_ui'
  AND tm.platform_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM regression_suites rs
    WHERE rs.module_id = tm.id
  );

-- ============================================================================
-- 4. SPLIT MIXED MODULES (both UI and API suites)
-- ============================================================================
-- For modules that have both UI and API suites:
-- 1. Create a new module for API tests (copy metadata, append ' (API)')
-- 2. Move API suites to the new module
-- 3. Assign original module to web_ui, new module to api

DO $$
DECLARE
  mixed_module RECORD;
  new_module_id UUID;
  api_platform_id UUID;
  ui_platform_id UUID;
BEGIN
  -- Loop through modules that have both UI and API suites
  FOR mixed_module IN
    SELECT DISTINCT tm.id, tm.project_id, tm.user_id, tm.name, tm.description, tm.tags, tm.priority
    FROM test_modules tm
    WHERE tm.platform_id IS NULL
      AND EXISTS (
        SELECT 1 FROM regression_suites rs
        WHERE rs.module_id = tm.id AND rs.suite_type = 'ui'
      )
      AND EXISTS (
        SELECT 1 FROM regression_suites rs
        WHERE rs.module_id = tm.id AND rs.suite_type = 'api'
      )
  LOOP
    -- Get platform IDs for this project
    SELECT id INTO api_platform_id
    FROM test_platforms
    WHERE project_id = mixed_module.project_id AND platform_key = 'api';

    SELECT id INTO ui_platform_id
    FROM test_platforms
    WHERE project_id = mixed_module.project_id AND platform_key = 'web_ui';

    -- Create new module for API tests
    INSERT INTO test_modules (project_id, user_id, name, description, tags, priority, platform_id)
    VALUES (
      mixed_module.project_id,
      mixed_module.user_id,
      mixed_module.name || ' (API)',
      COALESCE(mixed_module.description, '') || ' (split from mixed module)',
      mixed_module.tags,
      mixed_module.priority,
      api_platform_id
    )
    RETURNING id INTO new_module_id;

    -- Move API suites to new module
    UPDATE regression_suites
    SET module_id = new_module_id
    WHERE module_id = mixed_module.id AND suite_type = 'api';

    -- Assign original module to web_ui platform
    UPDATE test_modules
    SET platform_id = ui_platform_id
    WHERE id = mixed_module.id;

    RAISE NOTICE 'Split module % (%) -> created API module %', mixed_module.id, mixed_module.name, new_module_id;
  END LOOP;
END $$;

-- ============================================================================
-- 5. SAFETY CHECK: Ensure all modules have platform_id
-- ============================================================================

-- Any remaining modules without platform_id default to web_ui
UPDATE test_modules tm
SET platform_id = tp.id
FROM test_platforms tp
WHERE tp.project_id = tm.project_id
  AND tp.platform_key = 'web_ui'
  AND tm.platform_id IS NULL;

-- ============================================================================
-- 6. SET PLATFORM_ID AS NOT NULL (after all data is migrated)
-- ============================================================================

-- This will fail if any modules still have NULL platform_id
ALTER TABLE test_modules
  ALTER COLUMN platform_id SET NOT NULL;

-- ============================================================================
-- VERIFICATION QUERIES (for manual checking)
-- ============================================================================

-- Check all modules have platform_id
-- SELECT COUNT(*) as orphan_modules FROM test_modules WHERE platform_id IS NULL;

-- Check platform distribution
-- SELECT tp.platform_key, COUNT(tm.id) as module_count
-- FROM test_platforms tp
-- LEFT JOIN test_modules tm ON tm.platform_id = tp.id
-- GROUP BY tp.platform_key;

-- Check suite_type consistency
-- SELECT tm.name as module_name, tp.platform_key, rs.suite_type, COUNT(*) as suite_count
-- FROM test_modules tm
-- JOIN test_platforms tp ON tp.id = tm.platform_id
-- LEFT JOIN regression_suites rs ON rs.module_id = tm.id
-- GROUP BY tm.name, tp.platform_key, rs.suite_type
-- ORDER BY tm.name;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE test_platforms IS 'Top-level platform categories - includes seeded web_ui and api platforms';
