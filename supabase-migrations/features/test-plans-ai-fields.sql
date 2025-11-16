-- =====================================================
-- Test Plans AI Fields Migration
-- Adds support for AI-generated test plan fields
-- =====================================================

-- Add new AI-generated fields to test_plans table
ALTER TABLE public.test_plans
ADD COLUMN IF NOT EXISTS intelligent_mode BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS estimated_pages TEXT,
ADD COLUMN IF NOT EXISTS estimated_cost TEXT;

-- Add index for intelligent mode filtering
CREATE INDEX IF NOT EXISTS idx_test_plans_intelligent_mode
  ON public.test_plans(intelligent_mode, status, created_at DESC);

-- Add comments for documentation
COMMENT ON COLUMN public.test_plans.intelligent_mode IS 'Whether this test plan uses AI intelligent testing mode';
COMMENT ON COLUMN public.test_plans.estimated_pages IS 'AI estimate of pages to be tested (e.g., "3-8 pages")';
COMMENT ON COLUMN public.test_plans.estimated_cost IS 'AI estimate of testing cost (e.g., "$0.05-0.15")';
