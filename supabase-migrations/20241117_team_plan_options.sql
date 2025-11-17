-- Add additional Team Plan credit options
-- This extends the basic Team Plan with multiple pricing tiers

-- Create team_plan_options table for multiple credit packages
CREATE TABLE team_plan_options (
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

-- Get team plan ID and insert options
DO $$
DECLARE
    team_plan_id UUID;
BEGIN
    SELECT id INTO team_plan_id FROM pricing_plans WHERE slug = 'team';

    IF team_plan_id IS NULL THEN
        RAISE EXCEPTION 'Team plan not found. Please run pricing_plans_migration.sql first.';
    END IF;

    -- Insert team plan credit options
    INSERT INTO team_plan_options (plan_id, credits, price, price_per_credit, is_default, description, savings) VALUES
    (team_plan_id, 5000, 159.00, 0.032, true, '5,000 credits - Team starter', 20),
    (team_plan_id, 10000, 299.00, 0.030, false, '10,000 credits - Team standard', 25),
    (team_plan_id, 15000, 399.00, 0.027, false, '15,000 credits - Team premium', 35),
    (team_plan_id, 25000, 599.00, 0.024, false, '25,000 credits - Enterprise ready', 45);

    RAISE NOTICE 'Team plan options inserted successfully for plan_id: %', team_plan_id;
END $$;

-- Create index for performance
CREATE INDEX idx_team_plan_options_plan_id ON team_plan_options(plan_id);
CREATE INDEX idx_team_plan_options_default ON team_plan_options(is_default);
