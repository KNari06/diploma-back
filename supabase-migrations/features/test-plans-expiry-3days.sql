-- =====================================================
-- Test Plans Expiry: Change from 1 hour to 3 days (72 hours)
-- =====================================================

-- Update default expires_at to 3 days instead of 1 hour
ALTER TABLE public.test_plans
ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '3 days');

-- Update existing pending plans that haven't expired yet to have 3 days expiry
UPDATE public.test_plans
SET expires_at = created_at + INTERVAL '3 days'
WHERE status = 'pending_confirmation'
  AND expires_at > NOW()
  AND expires_at < created_at + INTERVAL '3 days';

-- Add comment for documentation
COMMENT ON COLUMN public.test_plans.expires_at IS 'Test plan expiration time. Default: 3 days (72 hours) from creation. Plans expire automatically after this time.';
