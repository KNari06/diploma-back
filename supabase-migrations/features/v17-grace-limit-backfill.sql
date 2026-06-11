-- Migration: V17 Grace Limit Backfill
-- Date: 2026-06-05
-- Realigns grace_limit to the per-plan value on rows that drifted to 0.
--
-- Why this is needed:
--   The grace columns themselves already exist on both credit tables (added out
--   of band — they are NOT in any repo migration, but ARE present on the live DB).
--   The bug is in the DATA, not the schema: rows whose plan was set AFTER the V16
--   one-shot UPDATE — and ALL user_credits rows, which V16 never touched — kept
--   grace_limit = 0. The Stripe webhook path that promotes a user to 'pro' calls
--   UserCreditsService.addCredits() (balance only) and never updateSubscription(),
--   so grace_limit is never set for pro subscribers. Same drift on the workspace
--   side for plans assigned outside assignPilot()/upgradeToPlan().
--
-- Mapping mirrors UserCreditsService.GRACE_LIMITS and WORKSPACE_PLANS / V16 slugs:
--   user_credits:      free=0, basic=100, pro=100, ultra=200, enterprise=1000, business=1000
--   workspace_credits: free=0, basic=100, pro=100, business=3000,
--                      pilot=1000, small_business=3000, middle_business=8000, enterprise=20000
--
-- Idempotent: each UPDATE only rewrites rows whose grace_limit already differs
-- from the target, so re-running is a no-op once aligned.

BEGIN;

-- ── user_credits ─────────────────────────────────────────────────────────────
UPDATE user_credits SET grace_limit = 0    WHERE subscription_plan = 'free'       AND grace_limit <> 0;
UPDATE user_credits SET grace_limit = 100  WHERE subscription_plan = 'basic'      AND grace_limit <> 100;
UPDATE user_credits SET grace_limit = 100  WHERE subscription_plan = 'pro'        AND grace_limit <> 100;
UPDATE user_credits SET grace_limit = 200  WHERE subscription_plan = 'ultra'      AND grace_limit <> 200;
UPDATE user_credits SET grace_limit = 1000 WHERE subscription_plan = 'enterprise' AND grace_limit <> 1000;
UPDATE user_credits SET grace_limit = 1000 WHERE subscription_plan = 'business'   AND grace_limit <> 1000;

-- ── workspace_credits ────────────────────────────────────────────────────────
UPDATE workspace_credits SET grace_limit = 0     WHERE subscription_plan = 'free'            AND grace_limit <> 0;
UPDATE workspace_credits SET grace_limit = 100   WHERE subscription_plan = 'basic'           AND grace_limit <> 100;
UPDATE workspace_credits SET grace_limit = 100   WHERE subscription_plan = 'pro'             AND grace_limit <> 100;
UPDATE workspace_credits SET grace_limit = 3000  WHERE subscription_plan = 'business'        AND grace_limit <> 3000;
UPDATE workspace_credits SET grace_limit = 1000  WHERE subscription_plan = 'pilot'           AND grace_limit <> 1000;
UPDATE workspace_credits SET grace_limit = 3000  WHERE subscription_plan = 'small_business'  AND grace_limit <> 3000;
UPDATE workspace_credits SET grace_limit = 8000  WHERE subscription_plan = 'middle_business' AND grace_limit <> 8000;
UPDATE workspace_credits SET grace_limit = 20000 WHERE subscription_plan = 'enterprise'      AND grace_limit <> 20000;

COMMIT;
