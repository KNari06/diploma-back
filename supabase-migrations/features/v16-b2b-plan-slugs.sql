-- Migration: V16 B2B Grace Period + Plan Slugs
-- Date: 2026-04-16
-- Adds grace_limit/overage columns to workspace_credits (missed in first migration)
-- and sets grace limits for new B2B plan slugs.

BEGIN;

-- 1. Add columns (idempotent — IF NOT EXISTS)
ALTER TABLE workspace_credits
ADD COLUMN IF NOT EXISTS grace_limit NUMERIC(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE workspace_credits
ADD COLUMN IF NOT EXISTS overage_balance NUMERIC(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE workspace_credits
ADD COLUMN IF NOT EXISTS grace_started_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE workspace_credit_transactions
ADD COLUMN IF NOT EXISTS is_grace_deduction BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_workspace_credits_grace_started
ON workspace_credits(grace_started_at)
WHERE grace_started_at IS NOT NULL;

-- 2. Set grace limits for B2B plan slugs
UPDATE workspace_credits SET grace_limit = 1000  WHERE subscription_plan = 'pilot';
UPDATE workspace_credits SET grace_limit = 3000  WHERE subscription_plan = 'small_business';
UPDATE workspace_credits SET grace_limit = 8000  WHERE subscription_plan = 'middle_business';
UPDATE workspace_credits SET grace_limit = 20000 WHERE subscription_plan = 'enterprise';

-- Legacy slugs (from previous migration, in case any exist)
UPDATE workspace_credits SET grace_limit = 3000  WHERE subscription_plan = 'business';
UPDATE workspace_credits SET grace_limit = 100   WHERE subscription_plan = 'pro';
UPDATE workspace_credits SET grace_limit = 100   WHERE subscription_plan = 'basic';

COMMIT;
