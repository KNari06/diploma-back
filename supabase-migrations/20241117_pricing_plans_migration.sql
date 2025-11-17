-- Pricing Plans Migration
-- Create pricing_plans table and update users table structure

-- Create pricing_plans table
CREATE TABLE pricing_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL, -- 'free', 'pro', 'team'
    description TEXT,
    price DECIMAL(10,2), -- NULL for free plan
    credits_per_month INTEGER NOT NULL,
    credits_per_day INTEGER, -- NULL if no daily limit
    features TEXT[] DEFAULT '{}',
    limitations TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX idx_pricing_plans_slug ON pricing_plans(slug);
CREATE INDEX idx_pricing_plans_active ON pricing_plans(is_active);

-- Update users table to support new pricing structure
ALTER TABLE users
ADD COLUMN plan_id UUID REFERENCES pricing_plans(id) ON DELETE SET NULL,
ADD COLUMN plan_started_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN credits_used_today INTEGER DEFAULT 0,
ADD COLUMN credits_used_this_month INTEGER DEFAULT 0,
ADD COLUMN last_credit_reset_date DATE DEFAULT CURRENT_DATE,
ADD COLUMN monthly_reset_date DATE DEFAULT CURRENT_DATE;

-- Add indexes for users table
CREATE INDEX idx_users_plan_id ON users(plan_id);
CREATE INDEX idx_users_last_credit_reset ON users(last_credit_reset_date);

-- Insert initial pricing plans
INSERT INTO pricing_plans (name, slug, description, price, credits_per_month, credits_per_day, features, limitations) VALUES
(
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
    ]
),
(
    'Pro Plan',
    'pro',
    'For professionals and small teams with unlimited testing',
    39.00,
    1000,
    NULL,
    ARRAY[
        'Unlimited AI tests',
        'Advanced document analysis',
        'Priority email support',
        'Fast response time',
        'Export results',
        'API access',
        '1,000 credits monthly'
    ],
    ARRAY[]::TEXT[]
),
(
    'Team Plan',
    'team',
    'For growing businesses and teams',
    159.00,
    5000,
    NULL,
    ARRAY[
        'Everything in Pro',
        'Team collaboration',
        'Advanced analytics',
        'Custom integrations',
        'Dedicated support',
        'SLA guarantee',
        'White-label options',
        '5,000 credits monthly'
    ],
    ARRAY[]::TEXT[]
);

-- Create function to reset daily credits
CREATE OR REPLACE FUNCTION reset_daily_credits()
RETURNS void AS $$
BEGIN
    UPDATE users
    SET
        credits_used_today = 0,
        last_credit_reset_date = CURRENT_DATE
    WHERE last_credit_reset_date < CURRENT_DATE;

    RAISE NOTICE 'Daily credits reset for % users', (SELECT COUNT(*) FROM users WHERE last_credit_reset_date = CURRENT_DATE);
END;
$$ LANGUAGE plpgsql;

-- Create function to reset monthly credits
CREATE OR REPLACE FUNCTION reset_monthly_credits()
RETURNS void AS $$
BEGIN
    UPDATE users
    SET
        credits_used_this_month = 0,
        monthly_reset_date = CURRENT_DATE
    WHERE monthly_reset_date <= CURRENT_DATE - INTERVAL '1 month';

    RAISE NOTICE 'Monthly credits reset for % users', (SELECT COUNT(*) FROM users WHERE monthly_reset_date >= CURRENT_DATE - INTERVAL '1 month');
END;
$$ LANGUAGE plpgsql;

-- Create function to check user credit limits
CREATE OR REPLACE FUNCTION check_user_credit_limits(user_id UUID, credits_to_use INTEGER DEFAULT 1)
RETURNS TABLE(
    can_use_credits BOOLEAN,
    reason TEXT,
    daily_remaining INTEGER,
    monthly_remaining INTEGER
) AS $$
DECLARE
    user_record RECORD;
    plan_record RECORD;
    daily_limit INTEGER;
    monthly_limit INTEGER;
    daily_used INTEGER;
    monthly_used INTEGER;
BEGIN
    -- Get user and plan info
    SELECT u.*, p.credits_per_day, p.credits_per_month, p.slug
    INTO user_record
    FROM users u
    LEFT JOIN pricing_plans p ON u.plan_id = p.id
    WHERE u.id = user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'User not found'::TEXT, 0, 0;
        RETURN;
    END IF;

    -- Reset daily credits if needed
    IF user_record.last_credit_reset_date < CURRENT_DATE THEN
        UPDATE users
        SET
            credits_used_today = 0,
            last_credit_reset_date = CURRENT_DATE
        WHERE id = user_id;
        daily_used := 0;
    ELSE
        daily_used := COALESCE(user_record.credits_used_today, 0);
    END IF;

    -- Reset monthly credits if needed
    IF user_record.monthly_reset_date <= CURRENT_DATE - INTERVAL '1 month' THEN
        UPDATE users
        SET
            credits_used_this_month = 0,
            monthly_reset_date = CURRENT_DATE
        WHERE id = user_id;
        monthly_used := 0;
    ELSE
        monthly_used := COALESCE(user_record.credits_used_this_month, 0);
    END IF;

    daily_limit := user_record.credits_per_day;
    monthly_limit := user_record.credits_per_month;

    -- Check limits
    IF daily_limit IS NOT NULL AND (daily_used + credits_to_use) > daily_limit THEN
        RETURN QUERY SELECT
            false,
            'Daily credit limit exceeded'::TEXT,
            GREATEST(0, daily_limit - daily_used),
            CASE WHEN monthly_limit = -1 THEN -1 ELSE GREATEST(0, monthly_limit - monthly_used) END;
        RETURN;
    END IF;

    IF monthly_limit IS NOT NULL AND monthly_limit != -1 AND (monthly_used + credits_to_use) > monthly_limit THEN
        RETURN QUERY SELECT
            false,
            'Monthly credit limit exceeded'::TEXT,
            CASE WHEN daily_limit IS NULL THEN -1 ELSE GREATEST(0, daily_limit - daily_used) END,
            GREATEST(0, monthly_limit - monthly_used);
        RETURN;
    END IF;

    -- All checks passed
    RETURN QUERY SELECT
        true,
        'OK'::TEXT,
        CASE WHEN daily_limit IS NULL THEN -1 ELSE GREATEST(0, daily_limit - daily_used) END,
        CASE WHEN monthly_limit = -1 THEN -1 ELSE GREATEST(0, monthly_limit - monthly_used) END;
END;
$$ LANGUAGE plpgsql;

-- Create function to use credits (with limit checking)
CREATE OR REPLACE FUNCTION use_user_credits(user_id UUID, credits_amount INTEGER DEFAULT 1)
RETURNS TABLE(
    success BOOLEAN,
    message TEXT,
    daily_remaining INTEGER,
    monthly_remaining INTEGER
) AS $$
DECLARE
    check_result RECORD;
BEGIN
    -- Check if user can use credits
    SELECT * INTO check_result
    FROM check_user_credit_limits(user_id, credits_amount);

    IF NOT check_result.can_use_credits THEN
        RETURN QUERY SELECT
            false,
            check_result.reason,
            check_result.daily_remaining,
            check_result.monthly_remaining;
        RETURN;
    END IF;

    -- Update usage counters
    UPDATE users
    SET
        credits_used_today = COALESCE(credits_used_today, 0) + credits_amount,
        credits_used_this_month = COALESCE(credits_used_this_month, 0) + credits_amount
    WHERE id = user_id;

    -- Return success with updated remaining credits
    SELECT * INTO check_result
    FROM check_user_credit_limits(user_id, 0);

    RETURN QUERY SELECT
        true,
        'Credits used successfully'::TEXT,
        check_result.daily_remaining,
        check_result.monthly_remaining;
END;
$$ LANGUAGE plpgsql;

-- Update existing users to have free plan by default
UPDATE users
SET
    plan_id = (SELECT id FROM pricing_plans WHERE slug = 'free'),
    plan_started_at = NOW(),
    credits_used_today = 0,
    credits_used_this_month = 0,
    last_credit_reset_date = CURRENT_DATE,
    monthly_reset_date = CURRENT_DATE
WHERE plan_id IS NULL;

-- Create updated_at trigger for pricing_plans
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_pricing_plans_updated_at
    BEFORE UPDATE ON pricing_plans
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
