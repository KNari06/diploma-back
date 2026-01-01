-- Add mode column to test_plans table
-- Mode determines which test engine to use: 'lite' (simplified) or 'pro' (advanced)
ALTER TABLE test_plans
ADD COLUMN IF NOT EXISTS mode TEXT CHECK (mode IN ('lite', 'pro')) DEFAULT 'lite';

-- Add comment for documentation
COMMENT ON COLUMN test_plans.mode IS 'Test execution mode: lite (simplified) or pro (advanced)';
