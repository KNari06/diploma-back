-- Restore Pro Plan and Setup: Free, Pro, Ultra (no Team)
-- Pro Plan: 1000=$28.9, 1500=$39.9, 2000=$49.9, 2500=$59.9, 3000=$69.9
-- Ultra Plan: 1000=$43.9, 2000=$79.9, 3000=$109.9, 4000=$139.9, 5000=$169.9

-- 1. Ensure Free Plan exists
INSERT INTO pricing_plans (name, slug, description, price, credits_per_month, credits_per_day, features, limitations, is_active)
VALUES (
    'Free Plan',
    'free',
    'Perfect for trying out QAIT with daily limits',
    NULL,
    30,
    3,
    ARRAY[
        '3 AI-powered tests per day',
        'Basic document analysis',
        'Email support',
        'Standard response time',
        'Maximum 30 credits per month'
    ],
    ARRAY[
        'Limited to 3 tests per day',
        'Basic features only',
        'Maximum 30 credits per month'
    ],
    true
)
ON CONFLICT (slug) DO UPDATE
SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    price = EXCLUDED.price,
    credits_per_month = EXCLUDED.credits_per_month,
    credits_per_day = EXCLUDED.credits_per_day,
    features = EXCLUDED.features,
    limitations = EXCLUDED.limitations,
    is_active = true,
    updated_at = NOW();

-- 2. Create/Update Pro Plan (restore if deleted)
INSERT INTO pricing_plans (name, slug, description, price, credits_per_month, credits_per_day, features, limitations, is_active)
VALUES (
    'Pro Plan',
    'pro',
    'For professionals and small teams with unlimited testing',
    28.9,
    1000,
    NULL,
    ARRAY[
        'Unlimited AI tests',
        'Advanced document analysis',
        'Concurrency tests up to 3',
        'Priority email support',
        'Fast response time',
        'Export results',
        'API access',
        '1,000 credits monthly'
    ],
    ARRAY[]::TEXT[],
    true
)
ON CONFLICT (slug) DO UPDATE
SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    price = EXCLUDED.price,
    credits_per_month = EXCLUDED.credits_per_month,
    credits_per_day = EXCLUDED.credits_per_day,
    features = EXCLUDED.features,
    limitations = EXCLUDED.limitations,
    is_active = true,
    updated_at = NOW();

-- 3. Create/Update Ultra Plan (slug='ultra')
INSERT INTO pricing_plans (name, slug, description, price, credits_per_month, credits_per_day, features, limitations, is_active)
VALUES (
    'Ultra Plan',
    'ultra',
    'For growing businesses and teams with premium features',
    43.9,
    1000,
    NULL,
    ARRAY[
        'Everything in Pro',
        'Team collaboration',
        'Advanced analytics',
        'Concurrency tests up to 10',
        'Custom integrations',
        'Dedicated support',
        'SLA guarantee',
        'Invite your teammates',
        'White-label options',
        '1,000 credits monthly'
    ],
    ARRAY[]::TEXT[],
    true
)
ON CONFLICT (slug) DO UPDATE
SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    price = EXCLUDED.price,
    credits_per_month = EXCLUDED.credits_per_month,
    credits_per_day = EXCLUDED.credits_per_day,
    features = EXCLUDED.features,
    limitations = EXCLUDED.limitations,
    is_active = true,
    updated_at = NOW();

-- 4. Deactivate Team Plan (if exists)
UPDATE pricing_plans
SET
    is_active = false,
    updated_at = NOW()
WHERE slug = 'team';

-- 5. Create pro_plan_options table if not exists
CREATE TABLE IF NOT EXISTS pro_plan_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES pricing_plans(id) ON DELETE CASCADE,
    credits INTEGER NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    price_per_credit DECIMAL(10,4) NOT NULL,
    is_default BOOLEAN DEFAULT false,
    description TEXT NOT NULL,
    savings INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(plan_id, credits)
);

-- Create indexes for pro_plan_options
CREATE INDEX IF NOT EXISTS idx_pro_plan_options_plan_id ON pro_plan_options(plan_id);
CREATE INDEX IF NOT EXISTS idx_pro_plan_options_default ON pro_plan_options(is_default);

-- 6. Create ultra_plan_options table if not exists
CREATE TABLE IF NOT EXISTS ultra_plan_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES pricing_plans(id) ON DELETE CASCADE,
    credits INTEGER NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    price_per_credit DECIMAL(10,4) NOT NULL,
    is_default BOOLEAN DEFAULT false,
    description TEXT NOT NULL,
    savings INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(plan_id, credits)
);

-- Create indexes for ultra_plan_options
CREATE INDEX IF NOT EXISTS idx_ultra_plan_options_plan_id ON ultra_plan_options(plan_id);
CREATE INDEX IF NOT EXISTS idx_ultra_plan_options_default ON ultra_plan_options(is_default);

-- 7. Insert/Update Pro plan options
DO $$
DECLARE
    pro_plan_id UUID;
BEGIN
    SELECT id INTO pro_plan_id FROM pricing_plans WHERE slug = 'pro';

    IF pro_plan_id IS NULL THEN
        RAISE EXCEPTION 'Pro plan not found after creation';
    END IF;

    -- Insert/update Pro plan options: 1000, 1500, 2000, 2500, 3000
    INSERT INTO pro_plan_options (plan_id, credits, price, price_per_credit, is_default, description, savings)
    VALUES
        (pro_plan_id, 1000, 28.9, 0.0289, true, '1,000 credits - Most popular', 0),
        (pro_plan_id, 1500, 39.9, 0.0266, false, '1,500 credits - Better value', 4),
        (pro_plan_id, 2000, 49.9, 0.02495, false, '2,000 credits - Great value', 8),
        (pro_plan_id, 2500, 59.9, 0.02396, false, '2,500 credits - Excellent value', 13),
        (pro_plan_id, 3000, 69.9, 0.0233, false, '3,000 credits - Best value', 18)
    ON CONFLICT (plan_id, credits) DO UPDATE
    SET
        price = EXCLUDED.price,
        price_per_credit = EXCLUDED.price_per_credit,
        description = EXCLUDED.description,
        savings = EXCLUDED.savings,
        is_default = EXCLUDED.is_default;

    RAISE NOTICE 'Pro plan options inserted/updated successfully';
END $$;

-- 8. Insert/Update Ultra plan options
DO $$
DECLARE
    ultra_plan_id UUID;
BEGIN
    SELECT id INTO ultra_plan_id FROM pricing_plans WHERE slug = 'ultra';

    IF ultra_plan_id IS NULL THEN
        RAISE EXCEPTION 'Ultra plan not found after creation';
    END IF;

    -- Insert/update Ultra plan options: 1000, 2000, 3000, 4000, 5000
    INSERT INTO ultra_plan_options (plan_id, credits, price, price_per_credit, is_default, description, savings)
    VALUES
        (ultra_plan_id, 1000, 43.9, 0.0439, true, '1,000 credits - Premium', 0),
        (ultra_plan_id, 2000, 79.9, 0.03995, false, '2,000 credits - Great value', 8),
        (ultra_plan_id, 3000, 109.9, 0.03663, false, '3,000 credits - Excellent value', 22),
        (ultra_plan_id, 4000, 139.9, 0.03497, false, '4,000 credits - Premium value', 36),
        (ultra_plan_id, 5000, 169.9, 0.03398, false, '5,000 credits - Best value', 50)
    ON CONFLICT (plan_id, credits) DO UPDATE
    SET
        price = EXCLUDED.price,
        price_per_credit = EXCLUDED.price_per_credit,
        description = EXCLUDED.description,
        savings = EXCLUDED.savings,
        is_default = EXCLUDED.is_default;

    RAISE NOTICE 'Ultra plan options inserted/updated successfully';
END $$;

-- 9. Verify final state
DO $$
DECLARE
    free_count INTEGER;
    pro_count INTEGER;
    ultra_count INTEGER;
    team_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO free_count FROM pricing_plans WHERE slug = 'free' AND is_active = true;
    SELECT COUNT(*) INTO pro_count FROM pricing_plans WHERE slug = 'pro' AND is_active = true;
    SELECT COUNT(*) INTO ultra_count FROM pricing_plans WHERE slug = 'ultra' AND is_active = true;
    SELECT COUNT(*) INTO team_count FROM pricing_plans WHERE slug = 'team' AND is_active = true;

    RAISE NOTICE '=== Pricing Plans Status ===';
    RAISE NOTICE 'Free Plan (active): %', free_count;
    RAISE NOTICE 'Pro Plan (active): %', pro_count;
    RAISE NOTICE 'Ultra Plan (active): %', ultra_count;
    RAISE NOTICE 'Team Plan (active): % (should be 0)', team_count;

    IF free_count != 1 OR pro_count != 1 OR ultra_count != 1 THEN
        RAISE WARNING 'Some plans are missing or inactive!';
    END IF;

    IF team_count > 0 THEN
        RAISE WARNING 'Team plan is still active. Consider deactivating it.';
    END IF;
END $$;
