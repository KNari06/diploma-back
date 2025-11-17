-- Add additional Team Plan credit options
-- This extends the basic Team Plan with multiple pricing tiers

-- Create team_plan_options table for multiple credit packages (if not exists)
CREATE TABLE IF NOT EXISTS team_plan_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES pricing_plans(id) ON DELETE CASCADE,
    credits INTEGER NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    price_per_credit DECIMAL(10,4) NOT NULL,
    is_default BOOLEAN DEFAULT false,
    description TEXT NOT NULL,
    savings INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create unique constraint for (plan_id, credits) to allow ON CONFLICT (if not exists)
-- This must be created BEFORE the INSERT statement
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_team_plan_options_unique'
    ) THEN
        CREATE UNIQUE INDEX idx_team_plan_options_unique ON team_plan_options(plan_id, credits);
    END IF;
END $$;

-- Create indexes for performance (if not exists)
CREATE INDEX IF NOT EXISTS idx_team_plan_options_plan_id ON team_plan_options(plan_id);
CREATE INDEX IF NOT EXISTS idx_team_plan_options_default ON team_plan_options(is_default);

-- Get team plan ID and insert options (with conflict handling)
DO $$
DECLARE
    team_plan_id UUID;
BEGIN
    SELECT id INTO team_plan_id FROM pricing_plans WHERE slug = 'team';

    IF team_plan_id IS NULL THEN
        RAISE EXCEPTION 'Team plan not found. Please run pricing_plans_migration.sql first.';
    END IF;

    -- Insert team plan credit options (update if exists)
    INSERT INTO team_plan_options (plan_id, credits, price, price_per_credit, is_default, description, savings) VALUES
    (team_plan_id, 1000, 50.00, 0.050, false, '1,000 credits - Starter', 0),
    (team_plan_id, 5000, 159.00, 0.032, true, '5,000 credits - Team starter', 20),
    (team_plan_id, 10000, 299.00, 0.030, false, '10,000 credits - Team standard', 25),
    (team_plan_id, 15000, 399.00, 0.027, false, '15,000 credits - Team premium', 35),
    (team_plan_id, 25000, 599.00, 0.024, false, '25,000 credits - Enterprise ready', 45)
    ON CONFLICT (plan_id, credits) DO UPDATE
    SET
        price = EXCLUDED.price,
        price_per_credit = EXCLUDED.price_per_credit,
        is_default = EXCLUDED.is_default,
        description = EXCLUDED.description,
        savings = EXCLUDED.savings;

    RAISE NOTICE 'Team plan options inserted/updated successfully for plan_id: %', team_plan_id;
END $$;
