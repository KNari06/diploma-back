-- Referral reward → time-windowed revenue share.
--
-- Supersedes the flat-unit reward from 20260713_referrals.sql. The partner now
-- earns a percentage (default 70%) of the REAL amount a referred user pays, for
-- their first N monthly payments (default 2), then 0% (100% ours) afterward.
--
-- Changes to partner_reward_transactions:
--  - amount now holds the referred user's paid amount share in the SMALLEST
--    currency unit (cents), not an abstract "reward unit". currency already exists.
--  - add stripe_invoice_id: the stable per-invoice key. One reward row per paid
--    invoice, so a webhook retry of the same invoice can't double-pay, while the
--    1st and 2nd monthly payments are distinct rows.
--  - the reward is now count-gated (reward while the referred user has < N reward
--    rows), so the OLD UNIQUE(partner_id, referred_user_id, event_type) — which
--    allowed only ONE reward per user — must go, replaced by a per-invoice unique.
--
-- This is additive/idempotent; the base referral tables/columns from
-- 20260713_referrals.sql must already be applied.

ALTER TABLE partner_reward_transactions
  ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT;

COMMENT ON COLUMN partner_reward_transactions.amount IS
  'Reward owed to the partner in the smallest currency unit (cents), = round(paid_amount * reward_rate). currency holds the ISO code.';
COMMENT ON COLUMN partner_reward_transactions.stripe_invoice_id IS
  'Stripe invoice this reward is for. One reward per invoice — webhook retries dedupe on the unique index below.';

-- Drop the old "one reward per (partner, user, event)" constraint — the window
-- now allows up to N rewards per referred user (one per qualifying invoice).
ALTER TABLE partner_reward_transactions
  DROP CONSTRAINT IF EXISTS partner_reward_transactions_partner_id_referred_user_id_eve_key;

-- New idempotency key: one reward row per Stripe invoice. A plain (non-partial)
-- unique index — NULLs are distinct in a unique index, so any legacy NULL-invoice
-- rows don't collide, AND (unlike a partial index) this can serve as the arbiter
-- for `INSERT ... ON CONFLICT (stripe_invoice_id)` in the reward path. A partial
-- unique index would require repeating its WHERE predicate in every ON CONFLICT,
-- which Postgres rejects otherwise (42P10).
CREATE UNIQUE INDEX IF NOT EXISTS partner_reward_stripe_invoice_uidx
  ON partner_reward_transactions (stripe_invoice_id);
