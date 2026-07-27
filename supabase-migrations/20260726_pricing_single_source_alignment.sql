-- Align the pricing DATA with the one-source-per-fact model (ADR-0025).
--
-- Three fixes, none of which touch schema — this is a data migration:
--
-- 1. pricing_plans.pro still advertised the retired $28.90 / 1000 plan. What we
--    actually sell is three Stripe-backed tiers ($19/990, $49/7000, $99/18000,
--    in pro_plan_options + plans.credits_per_period). pricing_plans holds ONE
--    price/credits pair, so it can only ever mirror the DEFAULT tier — it is a
--    display mirror, never a source. Set it to the is_default option (19/990).
--
-- 2. The individual "Team"/ultra plan is retired with zero subscriptions, but
--    is_active = true, so it is still offered to customers.
--
-- 3. The three B2B rows in `plans` point at placeholder stripe_price_ids
--    ('price_xxx'/'price_yyy'/'price_zzz') and grant credits_per_period = 0,
--    while marked active. No real Stripe event can match a placeholder id, so
--    they are inert — but an active row granting 0 credits is a trap for the
--    next reader, and would pay-and-grant-nothing if ever reached. B2B grants
--    go through UserCreditsService.grantBusinessPlan, not this table.
--
-- Idempotent: plain UPDATEs keyed on stable slugs / ids. Safe to re-run.
-- Reversible: see the migration record in .claude/migrations/.

-- 1. Pro display mirror -> the is_default tier (pro_19: 990 credits @ $19).
UPDATE public.pricing_plans
   SET price = 19,
       credits_per_month = 990,
       updated_at = now()
 WHERE slug = 'pro';

-- 2. Retire the individual Team/ultra plan.
UPDATE public.pricing_plans
   SET is_active = false,
       updated_at = now()
 WHERE slug = 'ultra';

-- 3. Deactivate the placeholder B2B rows.
UPDATE public.plans
   SET is_active = false,
       updated_at = now()
 WHERE stripe_price_id IN ('price_xxx', 'price_yyy', 'price_zzz');
