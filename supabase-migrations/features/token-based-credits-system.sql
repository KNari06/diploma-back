-- Migration: Token-based Credits System
-- Purpose: Update credits system to support decimal values and token tracking
-- Date: 2024-11-10
-- Plan: $39/month = 1000 credits, 1 credit = 562.5 tokens

-- Wrap everything in a transaction for safety
BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. UPDATE user_credits TABLE
-- ═══════════════════════════════════════════════════════════════════════════

-- IMPORTANT: Change type BEFORE multiplying to avoid INTEGER overflow
-- Change credits_balance from INTEGER to NUMERIC(10, 2) for decimal support
ALTER TABLE user_credits
ALTER COLUMN credits_balance TYPE NUMERIC(10, 2);

-- Change total_purchased from INTEGER to NUMERIC(10, 2)
ALTER TABLE user_credits
ALTER COLUMN total_purchased TYPE NUMERIC(10, 2);

-- Change total_used from INTEGER to NUMERIC(10, 2)
ALTER TABLE user_credits
ALTER COLUMN total_used TYPE NUMERIC(10, 2);

-- Add new columns for better tracking
ALTER TABLE user_credits
ADD COLUMN IF NOT EXISTS credits_purchased_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS credits_expire_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS last_credit_usage TIMESTAMP WITH TIME ZONE;

-- Add index for expiration tracking
CREATE INDEX IF NOT EXISTS idx_user_credits_expire_at
ON user_credits(credits_expire_at)
WHERE credits_expire_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. UPDATE credit_transactions TABLE
-- ═══════════════════════════════════════════════════════════════════════════

-- Change amount from INTEGER to NUMERIC(10, 2)
ALTER TABLE credit_transactions
ALTER COLUMN amount TYPE NUMERIC(10, 2);

-- Change balance_after from INTEGER to NUMERIC(10, 2)
ALTER TABLE credit_transactions
ALTER COLUMN balance_after TYPE NUMERIC(10, 2);

-- Add token tracking columns
ALTER TABLE credit_transactions
ADD COLUMN IF NOT EXISTS tokens_used JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 4) DEFAULT 0,
ADD COLUMN IF NOT EXISTS credits_calculated NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS test_type TEXT CHECK (test_type IN ('intelligent', 'standard', 'api', 'chat'));

-- Add index for test_type
CREATE INDEX IF NOT EXISTS idx_credit_transactions_test_type
ON credit_transactions(test_type)
WHERE test_type IS NOT NULL;

-- Add index for cost tracking
CREATE INDEX IF NOT EXISTS idx_credit_transactions_cost
ON credit_transactions(cost_usd)
WHERE cost_usd > 0;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ADD COMMENTS FOR DOCUMENTATION
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN user_credits.credits_balance IS 'Current credit balance (DECIMAL for precision, 1 credit = 562.5 tokens)';
COMMENT ON COLUMN user_credits.credits_purchased_at IS 'When credits were last purchased';
COMMENT ON COLUMN user_credits.credits_expire_at IS 'When credits expire (optional)';
COMMENT ON COLUMN user_credits.last_credit_usage IS 'Last time credits were used';

COMMENT ON COLUMN credit_transactions.tokens_used IS 'Token details: {input: number, output: number, model: string}';
COMMENT ON COLUMN credit_transactions.cost_usd IS 'Actual AI cost in USD';
COMMENT ON COLUMN credit_transactions.credits_calculated IS 'Credits calculated from tokens';
COMMENT ON COLUMN credit_transactions.test_type IS 'Type of test: intelligent, standard, api, or chat';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. UPDATE EXISTING DATA (MIGRATION SAFETY)
-- ═══════════════════════════════════════════════════════════════════════════

-- Update existing INTEGER credits to new DECIMAL system (multiply by 10)
-- Example: 100 credits → 1000 credits
-- This ensures existing users get equivalent value
UPDATE user_credits
SET
    credits_balance = credits_balance * 10,
    total_purchased = total_purchased * 10,
    total_used = total_used * 10
WHERE credits_balance > 0 OR total_purchased > 0 OR total_used > 0;

-- Update existing credit_transactions
UPDATE credit_transactions
SET
    amount = amount * 10,
    balance_after = balance_after * 10
WHERE amount != 0;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. CREATE HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════

-- Function to calculate credits from tokens
CREATE OR REPLACE FUNCTION calculate_credits_from_tokens(tokens NUMERIC)
RETURNS NUMERIC AS $$
BEGIN
    -- 1 credit = 562.5 tokens
    -- Round up to nearest integer
    RETURN CEIL(tokens / 562.5);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to calculate tokens from credits
CREATE OR REPLACE FUNCTION calculate_tokens_from_credits(credits NUMERIC)
RETURNS NUMERIC AS $$
BEGIN
    -- 1 credit = 562.5 tokens
    RETURN credits * 562.5;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get test credit cost
CREATE OR REPLACE FUNCTION get_test_credit_cost(test_type_param TEXT)
RETURNS NUMERIC AS $$
BEGIN
    RETURN CASE test_type_param
        WHEN 'intelligent' THEN 20
        WHEN 'standard' THEN 1
        WHEN 'api' THEN 2
        WHEN 'chat' THEN 0
        ELSE 0
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. UPDATE TRIGGER FOR last_credit_usage
-- ═══════════════════════════════════════════════════════════════════════════

-- Function to update last_credit_usage timestamp
CREATE OR REPLACE FUNCTION update_last_credit_usage()
RETURNS TRIGGER AS $$
BEGIN
    -- Only update if credits were deducted (amount is negative)
    IF NEW.amount < 0 THEN
        UPDATE user_credits
        SET last_credit_usage = NOW()
        WHERE user_id = NEW.user_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS trigger_update_last_credit_usage ON credit_transactions;

-- Create trigger
CREATE TRIGGER trigger_update_last_credit_usage
    AFTER INSERT ON credit_transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_last_credit_usage();

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. VERIFY MIGRATION
-- ═══════════════════════════════════════════════════════════════════════════

-- Check data types
DO $$
BEGIN
    -- Verify user_credits columns
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_credits'
        AND column_name = 'credits_balance'
        AND data_type = 'numeric'
    ) THEN
        RAISE EXCEPTION 'Migration failed: credits_balance is not NUMERIC';
    END IF;

    -- Verify credit_transactions columns
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'credit_transactions'
        AND column_name = 'tokens_used'
        AND data_type = 'jsonb'
    ) THEN
        RAISE EXCEPTION 'Migration failed: tokens_used column not created';
    END IF;

    RAISE NOTICE 'Migration completed successfully!';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. COMMIT TRANSACTION
-- ═══════════════════════════════════════════════════════════════════════════

COMMIT;
