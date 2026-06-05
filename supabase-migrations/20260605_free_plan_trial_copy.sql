-- ─────────────────────────────────────────────────────────────────────────────
-- Free plan → honest B2C trial copy (June 2026)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The original 20241117 seed advertises the free plan as "3 tests/day,
-- 30 credits/month". Those per-day / per-month limits were NEVER enforced on
-- the run path: deduction gates only on balance + grace_limit
-- (credit-cost-tracker.service.ts), and the check_user_credit_limits RPC is
-- not called by the test-run flow. The real, working behaviour is a one-off
-- 50-credit welcome bonus (user-credits.service.ts), after which a free user
-- (grace_limit = 0) is blocked until they upgrade.
--
-- This is the trial model we actually want for B2C self-serve. This migration
-- aligns the advertised copy with reality so the UI stops promising daily /
-- monthly allowances that don't exist. Additive + idempotent: a single UPDATE
-- of the existing 'free' row, no data recreation, safe against prod.
--
-- credits_per_month is set to 50 to reflect the real one-off trial grant (the
-- column is the closest existing field for "trial credit volume"); it remains
-- display/metadata only — nothing enforces it. credits_per_day → NULL ("no
-- daily limit"), matching the unenforced reality.

UPDATE public.pricing_plans
SET
  description     = 'Free trial — 50 one-off credits to try QAIT, no card required',
  credits_per_month = 50,
  credits_per_day   = NULL,
  features = ARRAY[
    '50 one-off trial credits',
    'All features included',
    'AI-powered exploration & test runs',
    'Email support'
  ],
  limitations = ARRAY[
    'One-off trial credits (no monthly refill)',
    'Upgrade to a paid plan for more credits'
  ],
  updated_at = NOW()
WHERE slug = 'free';
