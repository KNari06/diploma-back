-- Repoint Pro credit options to the B2C tier model: $29 / $49 / $99, fixed
-- tiers with a volume discount (replaces the old flat slider: 1000-3000
-- credits @ $30-$90).
--
-- These rows back the pricing page (GET /api/v1/user/pricing-plans →
-- getPlansForAPI → pro_plan_options) and render as the Pro card's volume
-- dropdown. The `price` here is the SHOWN price and must match the Stripe
-- Price created for the matching plans.code (pro_29/49/99). credits here
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

  -- savings = % cheaper per credit vs the entry $29 tier ($0.0058/cr).
  INSERT INTO public.pro_plan_options
    (plan_id, credits, price, price_per_credit, is_default, savings, description)
  VALUES
    (pro_plan_id,  5000, 29.00, 0.0058, true,   0, 'Pro — 5,000 credits/mo'),
    (pro_plan_id,  9000, 49.00, 0.0054, false,  7, 'Pro 5x — 9,000 credits/mo'),
    (pro_plan_id, 19000, 99.00, 0.0052, false, 10, 'Max 10x — 19,000 credits/mo');
END $$;
