-- ============================================================================
-- TEST PLATFORMS ENFORCEMENT TRIGGERS
-- ============================================================================
-- Hard-fail triggers to enforce platform <-> suite_type consistency
-- Run AFTER test-platforms-migration.sql
-- ============================================================================

-- ============================================================================
-- 1. TRIGGER ON REGRESSION_SUITES: Enforce suite_type matches platform
-- ============================================================================
-- On INSERT or UPDATE of module_id/suite_type:
-- - Resolve module's platform via test_modules.platform_id -> test_platforms.platform_key
-- - Enforce: web_ui => suite_type='ui', api => suite_type='api'

CREATE OR REPLACE FUNCTION enforce_suite_type_matches_platform()
RETURNS TRIGGER AS $$
DECLARE
  platform_key TEXT;
  expected_suite_type TEXT;
BEGIN
  -- If module_id is NULL, allow (orphan suites are handled separately)
  IF NEW.module_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get the platform key for this module
  SELECT tp.platform_key
  INTO platform_key
  FROM test_modules tm
  JOIN test_platforms tp ON tp.id = tm.platform_id
  WHERE tm.id = NEW.module_id;

  -- If module has no platform, raise error
  IF platform_key IS NULL THEN
    RAISE EXCEPTION 'Module % has no platform assigned. Cannot create/update suite.', NEW.module_id;
  END IF;

  -- Determine expected suite_type based on platform
  IF platform_key = 'web_ui' THEN
    expected_suite_type := 'ui';
  ELSIF platform_key = 'api' THEN
    expected_suite_type := 'api';
  ELSE
    RAISE EXCEPTION 'Unknown platform_key: %', platform_key;
  END IF;

  -- Validate suite_type matches platform
  IF NEW.suite_type IS NULL OR NEW.suite_type <> expected_suite_type THEN
    RAISE EXCEPTION 'suite_type "%" does not match platform "%" (expected "%")',
      COALESCE(NEW.suite_type, 'NULL'), platform_key, expected_suite_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_enforce_suite_platform ON regression_suites;

-- Create trigger for INSERT and UPDATE
CREATE TRIGGER trg_enforce_suite_platform
  BEFORE INSERT OR UPDATE OF module_id, suite_type ON regression_suites
  FOR EACH ROW
  EXECUTE FUNCTION enforce_suite_type_matches_platform();

-- ============================================================================
-- 2. TRIGGER ON TEST_MODULES: Prevent invalid platform changes
-- ============================================================================
-- On UPDATE of platform_id:
-- - Check if module has suites that would violate new platform
-- - If so, raise error

CREATE OR REPLACE FUNCTION enforce_module_platform_change()
RETURNS TRIGGER AS $$
DECLARE
  new_platform_key TEXT;
  expected_suite_type TEXT;
  violating_count INTEGER;
BEGIN
  -- Skip if platform_id didn't change
  IF OLD.platform_id IS NOT DISTINCT FROM NEW.platform_id THEN
    RETURN NEW;
  END IF;

  -- Get new platform key
  SELECT tp.platform_key
  INTO new_platform_key
  FROM test_platforms tp
  WHERE tp.id = NEW.platform_id;

  IF new_platform_key IS NULL THEN
    RAISE EXCEPTION 'Invalid platform_id: %', NEW.platform_id;
  END IF;

  -- Determine expected suite_type for new platform
  IF new_platform_key = 'web_ui' THEN
    expected_suite_type := 'ui';
  ELSIF new_platform_key = 'api' THEN
    expected_suite_type := 'api';
  ELSE
    RAISE EXCEPTION 'Unknown platform_key: %', new_platform_key;
  END IF;

  -- Check for violating suites
  SELECT COUNT(*)
  INTO violating_count
  FROM regression_suites rs
  WHERE rs.module_id = NEW.id
    AND rs.suite_type <> expected_suite_type;

  IF violating_count > 0 THEN
    RAISE EXCEPTION 'Cannot change module % platform to "%" - it has % suite(s) with incompatible suite_type',
      NEW.id, new_platform_key, violating_count;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_enforce_module_platform_change ON test_modules;

-- Create trigger for UPDATE of platform_id
CREATE TRIGGER trg_enforce_module_platform_change
  BEFORE UPDATE OF platform_id ON test_modules
  FOR EACH ROW
  EXECUTE FUNCTION enforce_module_platform_change();

-- ============================================================================
-- 3. REMOVE 'mixed' FROM suite_type CHECK CONSTRAINT (optional hardening)
-- ============================================================================
-- After migration, we can optionally remove 'mixed' from allowed values
-- This is done carefully to not break if constraint doesn't exist

DO $$
BEGIN
  -- Drop the old constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'regression_suites_suite_type_check'
  ) THEN
    ALTER TABLE regression_suites
      DROP CONSTRAINT regression_suites_suite_type_check;
  END IF;

  -- Add new stricter constraint (only ui and api)
  ALTER TABLE regression_suites
    ADD CONSTRAINT regression_suites_suite_type_check
    CHECK (suite_type IN ('ui', 'api'));

EXCEPTION
  WHEN duplicate_object THEN
    -- Constraint already exists with correct definition
    NULL;
END $$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON FUNCTION enforce_suite_type_matches_platform() IS 'Trigger function: enforces suite_type matches module platform';
COMMENT ON FUNCTION enforce_module_platform_change() IS 'Trigger function: prevents changing module platform if suites would violate';
