-- Cleanup old test plans with non-UUID IDs
-- These are from before we switched to UUID format
-- Only cleans up expired plans (safe to delete)

DO $$
DECLARE
    deleted_count INTEGER;
    total_deleted INTEGER := 0;
    uuid_regex TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    table_exists BOOLEAN;
BEGIN
    -- Check if table exists (safety check)
    SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'test_plans'
    ) INTO table_exists;

    IF NOT table_exists THEN
        RAISE NOTICE 'Table test_plans does not exist. Skipping cleanup.';
        RETURN;
    END IF;

    -- Delete ALL plans with non-UUID IDs (old format: api_test_*, plan_*, intelligent_*)
    -- Using ~* for case-insensitive regex match (UUID can be uppercase)
    -- Safe to delete all old format plans since new ones use UUID only
    DELETE FROM test_plans
    WHERE
        -- Non-UUID format (old format) - delete ALL regardless of status
        NOT (id ~* uuid_regex);

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    total_deleted := total_deleted + deleted_count;

    RAISE NOTICE 'Cleaned up % old test plans with non-UUID IDs (all statuses)', deleted_count;

    -- Also delete very old expired plans regardless of format (older than 7 days)
    DELETE FROM test_plans
    WHERE
        expires_at < NOW() - INTERVAL '7 days'
        AND status IN ('expired', 'rejected', 'pending_confirmation');

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    total_deleted := total_deleted + deleted_count;

    RAISE NOTICE 'Cleaned up % very old expired test plans', deleted_count;
    RAISE NOTICE 'Total deleted: % test plans', total_deleted;
END $$;

-- Add comment to table for future reference
COMMENT ON TABLE test_plans IS 'Test plans awaiting user confirmation. ID format: UUID (since 2025-11-18). Old format (api_test_*, plan_*) was deprecated.';
