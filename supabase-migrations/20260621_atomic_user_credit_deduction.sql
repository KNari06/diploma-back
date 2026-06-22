-- ============================================================================
-- Migration: Atomic user-credit deduction RPC
-- Date: 2026-06-21
-- Description:
--   UserCreditsService.deductCredits did read-modify-write in JS (read balance,
--   compute new value, write it back with a plain UPDATE keyed only on user_id).
--   Two interleaved deductions each read the same balance and overwrite each
--   other's result — a classic lost-update race: a user could get N test runs
--   for the price of 1 whenever requests overlapped, and total_used / overage
--   drifted from the balance.
--
--   This function folds the read, the grace-floor check, and the write into a
--   single atomic UPDATE. Postgres evaluates the WHERE against the current row
--   under a row lock, so concurrent calls serialize and can never double-spend.
--   Returns the updated row when the deduction succeeds, and NO row when it
--   would breach the grace floor (caller treats empty as "insufficient").
--
--   Mirrors the bookkeeping the TS code did: total_used += amount, overage_balance
--   and grace_started_at maintained when the balance goes negative.
--
-- SAFE TO APPLY AS-IS. Pure additive function; re-applying replaces the body.
-- Apply BEFORE deploying the backend that calls it.
-- ============================================================================

-- RETURNS SETOF (not a scalar composite): a scalar `RETURNS user_credits`
-- function emits ONE all-NULL row when the UPDATE matches nothing, which the
-- caller can't distinguish from a real row (it's a truthy object). SETOF emits
-- a genuinely EMPTY result set on no match, so supabase-js receives `data: []`
-- and the caller correctly treats it as "insufficient / floor breached".
-- DROP first because CREATE OR REPLACE cannot change a function's return type.
DROP FUNCTION IF EXISTS public.deduct_user_credits(text, numeric);

CREATE FUNCTION public.deduct_user_credits(
  p_user_id text,
  p_amount  numeric
) RETURNS SETOF public.user_credits
LANGUAGE sql
AS $$
  UPDATE public.user_credits
     SET credits_balance = round((credits_balance - p_amount)::numeric, 2),
         total_used      = round((COALESCE(total_used, 0) + p_amount)::numeric, 2),
         overage_balance = CASE
                             WHEN credits_balance - p_amount < 0
                               THEN round(abs(credits_balance - p_amount)::numeric, 2)
                             ELSE overage_balance
                           END,
         grace_started_at = CASE
                              WHEN credits_balance - p_amount < 0 AND credits_balance >= 0
                                THEN now()
                              ELSE grace_started_at
                            END,
         last_credit_usage = now(),
         updated_at        = now()
   WHERE user_id = p_user_id
     -- Grace floor: the resulting balance may not drop below -grace_limit.
     AND credits_balance - p_amount >= -COALESCE(grace_limit, 0)
  RETURNING *;
$$;

COMMENT ON FUNCTION public.deduct_user_credits(text, numeric) IS
  'Atomically deduct credits with grace-floor enforcement. Returns the updated user_credits row, or an EMPTY set when the deduction would breach the grace floor (insufficient credits). Replaces the race-prone read-modify-write in UserCreditsService.deductCredits.';
