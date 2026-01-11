-- Daily Free Credits Replenishment
-- Purpose: Add 50 credits daily to free plan users, but only if they used at least 1 credit
-- Logic:
--   - If user used 0 credits → don't add anything
--   - If user used 1 credit → add 1 credit (to reach 50)
--   - If user used 2 credits → add 2 credits (to reach 50)
--   - ...
--   - If user used 50 credits → add 50 credits (to reach 50)
--   - If user used 50+ credits → add only up to 50 credits (cap at 50 daily)

-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTION: Replenish daily free credits
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION replenish_daily_free_credits()
RETURNS TABLE(
    user_id UUID,
    credits_used_yesterday INTEGER,
    credits_added INTEGER,
    new_balance NUMERIC,
    status TEXT
) AS $$
DECLARE
    user_record RECORD;
    plan_record RECORD;
    credits_to_add INTEGER;
    current_balance NUMERIC;
    new_balance_val NUMERIC;
    free_plan_id UUID;
BEGIN
    -- Get free plan ID
    SELECT id INTO free_plan_id
    FROM pricing_plans
    WHERE slug = 'free' AND is_active = true
    LIMIT 1;

    IF free_plan_id IS NULL THEN
        RAISE EXCEPTION 'Free plan not found';
    END IF;

    -- Process all users with free plan who need daily reset
    FOR user_record IN
        SELECT u.id, u.credits_used_today, u.last_credit_reset_date, u.plan_id
        FROM users u
        WHERE u.plan_id = free_plan_id
          AND u.last_credit_reset_date < CURRENT_DATE
    LOOP
        -- Get current balance from user_credits
        SELECT COALESCE(uc.credits_balance, 0) INTO current_balance
        FROM user_credits uc
        WHERE uc.user_id = user_record.id;

        -- If balance is NULL, create user_credits record
        IF current_balance IS NULL THEN
            INSERT INTO user_credits (user_id, credits_balance, subscription_plan, subscription_status)
            VALUES (user_record.id, 0, 'free', 'inactive')
            ON CONFLICT (user_id) DO NOTHING;
            current_balance := 0;
        END IF;

        -- Calculate credits to add based on usage
        IF user_record.credits_used_today >= 1 THEN
            -- User used at least 1 credit → add back what they used (to reach 50)
            -- Cap at 50 credits per day (safety limit to prevent exploitation)
            credits_to_add := LEAST(user_record.credits_used_today, 50);

            -- Add credits to balance
            new_balance_val := current_balance + credits_to_add;

            UPDATE user_credits
            SET
                credits_balance = new_balance_val,
                updated_at = NOW()
            WHERE user_id = user_record.id;

            -- Record transaction
            INSERT INTO credit_transactions (
                user_id,
                amount,
                balance_after,
                type,
                description,
                metadata
            ) VALUES (
                user_record.id,
                credits_to_add,
                new_balance_val,
                'bonus',
                'Daily free credits replenishment',
                jsonb_build_object(
                    'credits_used_yesterday', user_record.credits_used_today,
                    'replenishment_date', CURRENT_DATE
                )
            );

            -- Reset daily usage counter
            UPDATE users
            SET
                credits_used_today = 0,
                last_credit_reset_date = CURRENT_DATE
            WHERE id = user_record.id;

            -- Return result
            RETURN QUERY SELECT
                user_record.id,
                user_record.credits_used_today,
                credits_to_add,
                new_balance_val,
                'replenished'::TEXT;
        ELSE
            -- User used 0 credits → don't add anything, just reset counter
            UPDATE users
            SET
                credits_used_today = 0,
                last_credit_reset_date = CURRENT_DATE
            WHERE id = user_record.id;

            -- Return result
            RETURN QUERY SELECT
                user_record.id,
                0,
                0,
                current_balance,
                'skipped_no_usage'::TEXT;
        END IF;
    END LOOP;

    RETURN;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- UPDATE: Replace reset_daily_credits to use new replenishment logic
-- ═══════════════════════════════════════════════════════════════════════════

-- Update reset_daily_credits to call replenishment for free plan users
CREATE OR REPLACE FUNCTION reset_daily_credits()
RETURNS void AS $$
DECLARE
    replenishment_result RECORD;
    replenished_count INTEGER := 0;
    skipped_count INTEGER := 0;
BEGIN
    -- First, replenish free plan users (with new logic)
    FOR replenishment_result IN
        SELECT * FROM replenish_daily_free_credits()
    LOOP
        IF replenishment_result.status = 'replenished' THEN
            replenished_count := replenished_count + 1;
        ELSIF replenishment_result.status = 'skipped_no_usage' THEN
            skipped_count := skipped_count + 1;
        END IF;
    END LOOP;

    -- Then, reset daily counters for other plans (pro, ultra, etc.)
    -- These plans don't get daily free credits, just reset the counter
    UPDATE users
    SET
        credits_used_today = 0,
        last_credit_reset_date = CURRENT_DATE
    WHERE last_credit_reset_date < CURRENT_DATE
      AND plan_id != (SELECT id FROM pricing_plans WHERE slug = 'free' AND is_active = true LIMIT 1);

    RAISE NOTICE 'Daily credits reset completed: % users replenished, % users skipped (no usage), other plans reset',
        replenished_count, skipped_count;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON FUNCTION replenish_daily_free_credits() IS
'Replenishes daily free credits (up to 50) for free plan users. Only adds credits if user used at least 1 credit yesterday.';

COMMENT ON FUNCTION reset_daily_credits() IS
'Resets daily credit usage counters. For free plan users, also replenishes credits based on usage.';
