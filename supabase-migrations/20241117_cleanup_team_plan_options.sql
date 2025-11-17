-- Cleanup Team Plan options - ensure 1000 credits option exists with correct price
-- This ensures Team plan has: 1000, 5000, 10000, 15000, 25000 credits

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

    -- Update or insert 1000 credits option with correct price ($50)
    INSERT INTO team_plan_options (plan_id, credits, price, price_per_credit, is_default, description, savings)
    VALUES (team_plan_id, 1000, 50.00, 0.050, false, '1,000 credits - Starter', 0)
    ON CONFLICT (plan_id, credits) DO UPDATE
    SET
        price = 50.00,
        price_per_credit = 0.050,
        description = '1,000 credits - Starter',
        savings = 0;

    RAISE NOTICE '1000 credits option updated/inserted with price $50';

    -- Verify final state - should have: 1000, 5000, 10000, 15000, 25000
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
