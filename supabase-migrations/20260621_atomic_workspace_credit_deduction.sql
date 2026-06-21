-- ============================================================================
-- Migration: Atomic workspace-credit deduction RPC
-- Date: 2026-06-21
-- Description:
--   WorkspaceCreditsService.deductCredits did a JS read-modify-write (read
--   balance/usage, compute new values, write back keyed only on workspace_id),
--   the same lost-update race the user-credit deduction had: two concurrent
--   workspace deductions read the same balance and overwrite each other, so a
--   workspace can run N operations for the price of 1 and credits_used_this_period
--   / total_used drift. The monthly-cap check was likewise non-atomic, so two
--   overlapping runs could both pass the cap and exceed it.
--
--   This folds the grace-floor check, the monthly_credit_limit cap, and the
--   balance / total_used / credits_used_this_period / last_credit_usage writes
--   into one atomic UPDATE under a row lock. SETOF → an empty result means the
--   deduction was rejected (grace floor breached OR monthly cap exceeded); the
--   caller treats empty as failure (returns null, same as before).
--
--   Note: workspace_credits.workspace_id is uuid (user_credits.user_id is text),
--   hence the uuid parameter here.
--
-- SAFE TO APPLY AS-IS. Additive function. Apply BEFORE deploying the backend.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.deduct_workspace_credits(
  p_workspace_id uuid,
  p_amount       numeric
) RETURNS SETOF public.workspace_credits
LANGUAGE sql
AS $$
  UPDATE public.workspace_credits
     SET credits_balance          = round((credits_balance - p_amount)::numeric, 2),
         total_used               = round((COALESCE(total_used, 0) + p_amount)::numeric, 2),
         credits_used_this_period = round((COALESCE(credits_used_this_period, 0) + p_amount)::numeric, 2),
         last_credit_usage        = now(),
         updated_at               = now()
   WHERE workspace_id = p_workspace_id
     -- Grace floor: resulting balance may not drop below -grace_limit.
     AND credits_balance - p_amount >= -COALESCE(grace_limit, 0)
     -- Monthly cap (NULL = uncapped): period usage may not exceed the limit.
     AND (monthly_credit_limit IS NULL
          OR COALESCE(credits_used_this_period, 0) + p_amount <= monthly_credit_limit)
  RETURNING *;
$$;

COMMENT ON FUNCTION public.deduct_workspace_credits(uuid, numeric) IS
  'Atomically deduct workspace credits with grace-floor + monthly-cap enforcement. Returns the updated row, or an EMPTY set when the deduction would breach the grace floor or the monthly cap. Replaces the race-prone read-modify-write in WorkspaceCreditsService.deductCredits.';
