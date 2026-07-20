-- Retire the individual "ultra" plan (display name "Team").
--
-- Context: `ultra` was an individual paid tier that granted the SAME 1000
-- credits as Pro at a higher price, had 0 users, and was never purchasable via
-- self-serve checkout (no row in the `plans` table — only a contact-sales
-- mailto). The real "Team/Enterprise" offering is the B2B tier set
-- (small_business / middle_business / enterprise), granted via Stripe webhook or
-- the admin panel — NOT this row.
--
-- Effect: individual self-serve now shows only Free + Pro. Deactivating (not
-- deleting) keeps the row for referential history; 0 users point at it, so this
-- is a no-op for entitlements.
--
-- Safe to re-run.

UPDATE pricing_plans
SET is_active = false,
    updated_at = NOW()
WHERE slug = 'ultra';

-- Sanity: this migration assumes nobody is on ultra. If a future run finds
-- users on it, investigate before relying on the deactivation.
DO $$
DECLARE
  n_users INT;
  n_credits INT;
BEGIN
  SELECT count(*) INTO n_users
  FROM users u
  JOIN pricing_plans pp ON pp.id = u.plan_id
  WHERE pp.slug = 'ultra';

  SELECT count(*) INTO n_credits
  FROM user_credits
  WHERE subscription_plan = 'ultra';

  IF n_users > 0 OR n_credits > 0 THEN
    RAISE WARNING 'retire_ultra: % users / % user_credits rows still reference ultra — reassign them to pro or a B2B tier', n_users, n_credits;
  END IF;
END $$;
