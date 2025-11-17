-- Cleanup Team Plan options - remove 1000 credits option if exists
-- This ensures Team plan only has: 5000, 10000, 15000, 25000 credits

DO $$
DECLARE
    team_plan_id UUID;
    deleted_count INTEGER;
    rec RECORD;
BEGIN
    -- Get team plan ID
    SELECT id INTO team_plan_id FROM pricing_plans WHERE slug = 'team';

    IF team_plan_id IS NULL THEN
        RAISE NOTICE 'Team plan not found. Skipping cleanup.';
        RETURN;
    END IF;

    -- Delete any team plan options with 1000 credits
    DELETE FROM team_plan_options
    WHERE plan_id = team_plan_id AND credits = 1000;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    IF deleted_count > 0 THEN
        RAISE NOTICE 'Deleted % team plan option(s) with 1000 credits', deleted_count;
    ELSE
        RAISE NOTICE 'No team plan options with 1000 credits found.';
    END IF;

    -- Verify final state - should only have: 5000, 10000, 15000, 25000
    RAISE NOTICE 'Current Team plan options:';
    FOR rec IN
        SELECT credits, price, description
        FROM team_plan_options
        WHERE plan_id = team_plan_id
        ORDER BY credits
    LOOP
        RAISE NOTICE '  - % credits: $% - %', rec.credits, rec.price, rec.description;
    END LOOP;
END $$;
