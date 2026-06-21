-- ============================================================================
-- Migration: Atomic user-credit ADDITION RPC
-- Date: 2026-06-21
-- Description:
--   UserCreditsService.addCredits did a JS read-modify-write (read balance,
--   compute balance+amount, write it back keyed only on user_id). The deduction
--   path was already made atomic (deduct_user_credits); addCredits was left as
--   the inverse race: a concurrent deduction (RPC) and an addCredits (e.g. a
--   Stripe purchase landing while a test run deducts) read the same balance and
--   the addCredits write clobbers the deduction's result — credits reappear for
--   free, or a concurrent add is lost.
--
--   This function folds the increment, the purchase bookkeeping, and the grace
--   clear into one atomic UPDATE under a row lock so concurrent mutations
--   serialize and cannot lose updates. SETOF so a missing row yields an empty
--   set (caller treats as failure) rather than a single all-NULL row.
--
--   p_is_purchase drives total_purchased / credits_purchased_at (only 'purchase'
--   transactions bump lifetime purchased; 'bonus'/'refund' do not).
--
-- SAFE TO APPLY AS-IS. Additive function. Apply BEFORE deploying the backend
-- that calls it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_user_credits(
  p_user_id     text,
  p_amount      numeric,
  p_is_purchase boolean
) RETURNS SETOF public.user_credits
LANGUAGE sql
AS $$
  UPDATE public.user_credits
     SET credits_balance = round((credits_balance + p_amount)::numeric, 2),
         total_purchased = CASE
                             WHEN p_is_purchase
                               THEN round((COALESCE(total_purchased, 0) + p_amount)::numeric, 2)
                             ELSE total_purchased
                           END,
         credits_purchased_at = CASE
                                  WHEN p_is_purchase THEN now()
                                  ELSE credits_purchased_at
                                END,
         -- A credit addition that lifts the balance to >= 0 clears any grace state.
         overage_balance = CASE
                             WHEN credits_balance + p_amount >= 0 AND grace_started_at IS NOT NULL
                               THEN 0
                             ELSE overage_balance
                           END,
         grace_started_at = CASE
                              WHEN credits_balance + p_amount >= 0
                                THEN NULL
                              ELSE grace_started_at
                            END,
         updated_at = now()
   WHERE user_id = p_user_id
  RETURNING *;
$$;

COMMENT ON FUNCTION public.add_user_credits(text, numeric, boolean) IS
  'Atomically add credits (purchase/bonus/refund). p_is_purchase bumps total_purchased + credits_purchased_at. Clears grace when balance returns to >= 0. Returns the updated row, or empty set if the user_credits row is missing. Replaces the race-prone read-modify-write in UserCreditsService.addCredits.';
