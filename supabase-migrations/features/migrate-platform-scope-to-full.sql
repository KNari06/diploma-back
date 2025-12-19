-- Migration: Migrate 'platform' scope to 'full' in test_plans
-- Reason: 'platform' and 'full' scopes were identical, so we merged them into 'full'
-- Date: 2025-01-XX

-- Update all test plans with scope='platform' to scope='full'
UPDATE test_plans
SET scope = 'full'
WHERE scope = 'platform'
  AND status IN ('pending_confirmation', 'confirmed'); -- Only update active plans

-- Log the migration
DO $$
DECLARE
    updated_count INTEGER;
BEGIN
    GET DIAGNOSTICS updated_count = ROW_COUNT;

    IF updated_count > 0 THEN
        RAISE NOTICE 'Migrated % test plans from scope=platform to scope=full', updated_count;
    ELSE
        RAISE NOTICE 'No test plans with scope=platform found to migrate';
    END IF;
END $$;

-- Add comment for future reference
COMMENT ON COLUMN test_plans.scope IS 'Test scope: full (comprehensive), flow (user journey), page, component, quick. Note: platform scope was merged into full.';
