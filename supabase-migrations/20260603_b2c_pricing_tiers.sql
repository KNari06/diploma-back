-- B2C self-serve pricing tiers: $29 / $49 / $99, price scales by credit volume.
-- One Pro plan, three volume tiers (Claude Pro/Max style); the frontend renders
-- them as a single Pro card with a volume dropdown (Free / Pro / Enterprise = 3
-- cards total). All features available on every tier — price differs only by
-- credit volume.
--
-- SAFE TO APPLY AS-IS. New rows are inserted INACTIVE (is_active = false) with
-- placeholder stripe_price_ids, so they are NOT surfaced to users and cannot
-- reach Stripe checkout. They become purchasable only after activation.
--
-- ACTIVATION (separate, deliberate step — NOT part of this migration):
--   1. In the Stripe Dashboard create 3 recurring (monthly) Prices ($29/$49/$99)
--      and copy each price_id.
--   2. Run, substituting the real ids:
--        UPDATE public.plans SET stripe_price_id='price_REAL_29', is_active=true,
--          updated_at=now() WHERE code='pro_29';
--        -- repeat for pro_49 / pro_99
--   Once active, Stripe checkout (by `code`) and the invoice webhook (by
--   stripe_price_id) work with zero controller changes — pro_* codes fall
--   through to the individual-credit path (UserCreditsService.addCredits).
--
-- The ON CONFLICT clause intentionally does NOT touch stripe_price_id or
-- is_active, so re-applying this migration never reverts a row that has
-- already been activated with a real price.
--
-- Credit volumes target ≥80% gross margin at full credit burn, assuming
-- ~$0.001 COGS/credit (LLM ~$0.0003 + browser-run infra; see
-- project-credit-unit-economics memory). Volume bonus (cheaper $/credit on
-- higher tiers). Monthly reset, no rollover.
--   pro_29 → 5,000 cr  ($0.0058/cr, ~83% margin)
--   pro_49 → 9,000 cr  ($0.0054/cr, ~82% margin)
--   pro_99 → 19,000 cr ($0.0052/cr, ~81% margin)
--
-- All rows reference the existing 'pro' pricing_plans row.

DO $$
DECLARE
  pro_plan_id uuid;
BEGIN
  SELECT id INTO pro_plan_id FROM public.pricing_plans WHERE slug = 'pro';

  IF pro_plan_id IS NULL THEN
    RAISE EXCEPTION 'pricing_plans row with slug=pro not found — cannot link B2C tiers';
  END IF;

  INSERT INTO public.plans (code, stripe_price_id, credits_per_period, is_active, plan_id)
  VALUES
    ('pro_29', 'REPLACE_WITH_STRIPE_PRICE_ID_29',  5000, false, pro_plan_id),
    ('pro_49', 'REPLACE_WITH_STRIPE_PRICE_ID_49',  9000, false, pro_plan_id),
    ('pro_99', 'REPLACE_WITH_STRIPE_PRICE_ID_99', 19000, false, pro_plan_id)
  ON CONFLICT (code) DO UPDATE SET
    -- Only refresh credit volume + plan link on re-apply. Leave stripe_price_id
    -- and is_active alone so an already-activated tier is never clobbered.
    credits_per_period = EXCLUDED.credits_per_period,
    plan_id            = EXCLUDED.plan_id,
    updated_at         = now();

  -- Retire the previous volume ladder (pro_1000 … pro_3000). They are only
  -- HIDDEN (is_active = false), never deleted — existing subscriptions keyed by
  -- their stripe_price_id keep working; they just stop being offered in the UI
  -- so the pricing page shows the new Free / Pro / Enterprise set.
  UPDATE public.plans
  SET is_active = false, updated_at = now()
  WHERE code IN ('pro_1000', 'pro_1500', 'pro_2000', 'pro_2500', 'pro_3000');
END $$;
