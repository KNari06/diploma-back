-- =============================================================================
-- B2C SELF-SERVE PRICING — apply to PROD Supabase (SQL Editor)
-- =============================================================================
-- Combines migrations 20260602 → 20260605 in order. Idempotent & additive —
-- safe to re-run. Does NOT delete or alter existing paying-user rows.
--
-- ⚠️ BEFORE RUNNING — fill the 3 real Stripe Price IDs in STEP 3 below.
--    Create them in Stripe Dashboard first (recurring/monthly: $29 / $49 / $99),
--    copy each price_id (format: price_1Sxxxxxxxxxxxx), and paste into the
--    three REPLACE_WITH_* slots. If you run WITHOUT real ids, the tiers stay
--    inactive (is_active=false) and checkout will refuse them — which is safe,
--    you can just re-run STEP 3 later once you have the ids.
-- =============================================================================


-- ── STEP 1 — schema mirror (no-op on prod where it already exists) ───────────
CREATE TABLE IF NOT EXISTS public.plans (
  code               text PRIMARY KEY,
  stripe_price_id    text NOT NULL UNIQUE,
  credits_per_period integer NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  plan_id            uuid REFERENCES public.pricing_plans(id) ON DELETE SET NULL
);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id    text,
  ADD COLUMN IF NOT EXISTS subscription       jsonb;


-- ── STEP 2 — Pro card dropdown options ($29/$49/$99) ─────────────────────────
DO $$
DECLARE
  pro_plan_id uuid;
BEGIN
  SELECT id INTO pro_plan_id FROM public.pricing_plans WHERE slug = 'pro';
  IF pro_plan_id IS NULL THEN
    RAISE EXCEPTION 'pricing_plans row with slug=pro not found';
  END IF;

  DELETE FROM public.pro_plan_options WHERE plan_id = pro_plan_id;

  INSERT INTO public.pro_plan_options
    (plan_id, credits, price, price_per_credit, is_default, savings, description)
  VALUES
    (pro_plan_id,  5000, 29.00, 0.0058, true,   0, 'Pro — 5,000 credits/mo'),
    (pro_plan_id,  9000, 49.00, 0.0054, false,  7, 'Pro 5x — 9,000 credits/mo'),
    (pro_plan_id, 19000, 99.00, 0.0052, false, 10, 'Max 10x — 19,000 credits/mo');
END $$;


-- ── STEP 3 — purchasable Stripe tiers ────────────────────────────────────────
-- Insert the 3 tiers and RETIRE the old volume ladder (pro_1000…pro_3000).
-- ⚠️ Replace the 3 stripe_price_id placeholders below with real Stripe ids,
--    and set is_active=true, BEFORE running if you want them purchasable now.
DO $$
DECLARE
  pro_plan_id uuid;
BEGIN
  SELECT id INTO pro_plan_id FROM public.pricing_plans WHERE slug = 'pro';
  IF pro_plan_id IS NULL THEN
    RAISE EXCEPTION 'pricing_plans row with slug=pro not found';
  END IF;

  INSERT INTO public.plans (code, stripe_price_id, credits_per_period, is_active, plan_id)
  VALUES
    ('pro_29', 'REPLACE_WITH_STRIPE_PRICE_ID_29',  5000, false, pro_plan_id),
    ('pro_49', 'REPLACE_WITH_STRIPE_PRICE_ID_49',  9000, false, pro_plan_id),
    ('pro_99', 'REPLACE_WITH_STRIPE_PRICE_ID_99', 19000, false, pro_plan_id)
  ON CONFLICT (code) DO UPDATE SET
    credits_per_period = EXCLUDED.credits_per_period,
    plan_id            = EXCLUDED.plan_id,
    updated_at         = now();

  -- Hide the previous ladder so the pricing page shows only Free / Pro / Enterprise.
  -- Existing subscriptions keyed by stripe_price_id keep working — only hidden in UI.
  UPDATE public.plans
  SET is_active = false, updated_at = now()
  WHERE code IN ('pro_1000', 'pro_1500', 'pro_2000', 'pro_2500', 'pro_3000');
END $$;


-- ── STEP 4 — honest free-trial copy ──────────────────────────────────────────
UPDATE public.pricing_plans
SET
  description       = 'Free trial — 50 one-off credits to try QAIT, no card required',
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


-- ── ACTIVATE LATER (run once you have real Stripe Price IDs) ──────────────────
-- UPDATE public.plans SET stripe_price_id='price_REAL_29', is_active=true, updated_at=now() WHERE code='pro_29';
-- UPDATE public.plans SET stripe_price_id='price_REAL_49', is_active=true, updated_at=now() WHERE code='pro_49';
-- UPDATE public.plans SET stripe_price_id='price_REAL_99', is_active=true, updated_at=now() WHERE code='pro_99';
