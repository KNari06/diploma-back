-- Fix Pro Plan options - ensure all options are inserted
-- This script can be run multiple times safely
-- Automatically creates table and indexes if they don't exist

-- Create table if it doesn't exist
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

-- Create unique index if it doesn't exist (required for ON CONFLICT)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_pro_plan_options_unique'
    ) THEN
        CREATE UNIQUE INDEX idx_pro_plan_options_unique ON pro_plan_options(plan_id, credits);
    END IF;
END $$;

-- Create other indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_pro_plan_options_plan_id ON pro_plan_options(plan_id);
CREATE INDEX IF NOT EXISTS idx_pro_plan_options_default ON pro_plan_options(is_default);

-- Insert/update Pro plan options
DO $$
DECLARE
    pro_plan_id UUID;
    options_count INTEGER;
    rec RECORD;
BEGIN
    -- Get pro plan ID
    SELECT id INTO pro_plan_id FROM pricing_plans WHERE slug = 'pro';

    IF pro_plan_id IS NULL THEN
        RAISE EXCEPTION 'Pro plan not found. Please run pricing_plans_migration.sql first.';
    END IF;

    -- Check if options already exist
    SELECT COUNT(*) INTO options_count
    FROM pro_plan_options
    WHERE plan_id = pro_plan_id;

    IF options_count = 0 THEN
        RAISE NOTICE 'No Pro plan options found. Inserting default options...';

        -- Insert pro plan credit options
        INSERT INTO pro_plan_options (plan_id, credits, price, price_per_credit, is_default, description, savings) VALUES
        (pro_plan_id, 1000, 39.00, 0.039, true, '1,000 credits - Most popular', 0),
        (pro_plan_id, 1500, 55.00, 0.037, false, '1,500 credits - Better value', 3),
        (pro_plan_id, 2000, 69.00, 0.035, false, '2,000 credits - Great value', 9),
        (pro_plan_id, 2500, 85.00, 0.034, false, '2,500 credits - Excellent value', 12),
        (pro_plan_id, 3000, 99.00, 0.033, false, '3,000 credits - Best value', 18)
        ON CONFLICT (plan_id, credits) DO UPDATE
        SET
            price = EXCLUDED.price,
            price_per_credit = EXCLUDED.price_per_credit,
            is_default = EXCLUDED.is_default,
            description = EXCLUDED.description,
            savings = EXCLUDED.savings;

        RAISE NOTICE 'Pro plan options inserted successfully. Total: %', (SELECT COUNT(*) FROM pro_plan_options WHERE plan_id = pro_plan_id);
    ELSE
        RAISE NOTICE 'Pro plan options already exist. Count: %', options_count;

        -- Verify all options are present
        FOR rec IN
            SELECT credits, price, description
            FROM pro_plan_options
            WHERE plan_id = pro_plan_id
            ORDER BY credits
        LOOP
            RAISE NOTICE '  - % credits: $% - %', rec.credits, rec.price, rec.description;
        END LOOP;
    END IF;
END $$;
