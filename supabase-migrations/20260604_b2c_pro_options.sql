-- Repoint Pro credit options to the B2C tier model: $19 / $49 / $99, fixed
-- tiers with a volume discount (replaces the old flat $0.03/credit slider:
-- 1000-3000 credits @ $30-$90).
--
-- These rows back the pricing page (GET /api/v1/user/pricing-plans →
-- getPlansForAPI → pro_plan_options). The `price` here is the SHOWN price and
-- must match the Stripe Price created for the matching plans.code (pro_19/
-- 49/99). credits here mirror plans.credits_per_period.
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

  INSERT INTO public.pro_plan_options
    (plan_id, credits, price, price_per_credit, is_default, savings, description)
  VALUES
    (pro_plan_id,  3800, 19.00, 0.0050, true,   0, 'Pro — 3,800 credits/mo'),
    (pro_plan_id, 10000, 49.00, 0.0049, false, 18, 'Pro 5x — 10,000 credits/mo'),
    (pro_plan_id, 20000, 99.00, 0.00495, false, 17, 'Max 10x — 20,000 credits/mo');
END $$;
