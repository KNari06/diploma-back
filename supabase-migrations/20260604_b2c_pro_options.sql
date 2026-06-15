-- Repoint Pro credit options to the B2C tier model: $19 / $49 / $99, fixed
-- tiers with a volume discount (replaces the old flat slider: 1000-3000
-- credits @ $30-$90).
--
-- These rows back the pricing page (GET /api/v1/user/pricing-plans →
-- getPlansForAPI → pro_plan_options) and render as the Pro card's volume
-- dropdown. The `price` here is the SHOWN price and must match the Stripe
-- Price created for the matching plans.code (pro_19/49/99). credits here
-- mirror plans.credits_per_period.
--
-- Idempotent: deletes the pro plan's existing options, then inserts the three
-- tiers. Safe to re-run.

DO $$
DECLARE
  pro_plan_id uuid;
BEGIN
  SELECT id INTO pro_plan_id FROM public.pricing_plans WHERE slug = 'pro';

  IF pro_plan_id IS NULL THEN
    RAISE EXCEPTION 'pricing_plans row with slug=pro not found — cannot set B2C options';
  END IF;

  DELETE FROM public.pro_plan_options WHERE plan_id = pro_plan_id;

  -- savings = % cheaper per credit vs the entry $19 tier ($0.0192/cr).
  INSERT INTO public.pro_plan_options
    (plan_id, credits, price, price_per_credit, is_default, savings, description)
  VALUES
    (pro_plan_id,   990, 19.00, 0.0192, true,   0, 'Pro — 990 credits/mo'),
    (pro_plan_id,  7000, 49.00, 0.0070, false, 64, 'Pro 5x — 7,000 credits/mo'),
    (pro_plan_id, 18000, 99.00, 0.0055, false, 71, 'Max — 18,000 credits/mo');
END $$;
