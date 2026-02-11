-- Migration: Business Plan 30K Credit Cap
-- Adds monthly credit limit tracking and warning flags to workspace_credits

-- 1. Add new columns for monthly credit cap tracking
ALTER TABLE workspace_credits
  ADD COLUMN IF NOT EXISTS monthly_credit_limit NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS credits_used_this_period NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS period_start_date DATE,
  ADD COLUMN IF NOT EXISTS warning_80_sent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS warning_95_sent BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Update subscription_plan CHECK constraint to include 'business'
ALTER TABLE workspace_credits DROP CONSTRAINT IF EXISTS workspace_credits_subscription_plan_check;
ALTER TABLE workspace_credits
  ADD CONSTRAINT workspace_credits_subscription_plan_check
  CHECK (subscription_plan IN ('free', 'basic', 'pro', 'enterprise', 'business'));

-- 3. Add comment for documentation
COMMENT ON COLUMN workspace_credits.monthly_credit_limit IS 'Monthly credit cap for the workspace. NULL means no limit.';
COMMENT ON COLUMN workspace_credits.credits_used_this_period IS 'Credits used in the current billing period. Reset on renewal.';
COMMENT ON COLUMN workspace_credits.period_start_date IS 'Start date of the current billing period.';
COMMENT ON COLUMN workspace_credits.warning_80_sent IS 'Whether 80% usage warning has been sent this period.';
COMMENT ON COLUMN workspace_credits.warning_95_sent IS 'Whether 95% usage warning has been sent this period.';
