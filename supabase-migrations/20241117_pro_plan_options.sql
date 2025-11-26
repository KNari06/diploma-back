-- Add Pro Plan credit options to database
-- This extends the Pro Plan with multiple pricing tiers

-- Create pro_plan_options table for multiple credit packages (if not exists)
CREATE TABLE IF NOT EXISTS pro_plan_options (
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
        WHERE indexname = 'idx_pro_plan_options_unique'
    ) THEN
        CREATE UNIQUE INDEX idx_pro_plan_options_unique ON pro_plan_options(plan_id, credits);
    END IF;
END $$;

-- Create indexes for performance (if not exists)
CREATE INDEX IF NOT EXISTS idx_pro_plan_options_plan_id ON pro_plan_options(plan_id);
CREATE INDEX IF NOT EXISTS idx_pro_plan_options_default ON pro_plan_options(is_default);

-- Get pro plan ID and insert options (with conflict handling)
DO $$
DECLARE
    pro_plan_id UUID;
BEGIN
    SELECT id INTO pro_plan_id FROM pricing_plans WHERE slug = 'pro';

    IF pro_plan_id IS NULL THEN
        RAISE EXCEPTION 'Pro plan not found. Please run pricing_plans_migration.sql first.';
    END IF;

    -- Insert pro plan credit options (update if exists)
    INSERT INTO pro_plan_options (plan_id, credits, price, price_per_credit, is_default, description, savings) VALUES
    (pro_plan_id, 1000, 28.9, 0.0289, true, '1,000 credits - Most popular', 0),
    (pro_plan_id, 1500, 39.9, 0.0266, false, '1,500 credits - Better value', 4),
    (pro_plan_id, 2000, 49.9, 0.02495, false, '2,000 credits - Great value', 8),
    (pro_plan_id, 2500, 59.9, 0.02396, false, '2,500 credits - Excellent value', 13),
    (pro_plan_id, 3000, 69.9, 0.0233, false, '3,000 credits - Best value', 18)
    ON CONFLICT (plan_id, credits) DO UPDATE
    SET
        price = EXCLUDED.price,
        price_per_credit = EXCLUDED.price_per_credit,
        is_default = EXCLUDED.is_default,
        description = EXCLUDED.description,
        savings = EXCLUDED.savings;

    RAISE NOTICE 'Pro plan options inserted/updated successfully for plan_id: %', pro_plan_id;
END $$;
