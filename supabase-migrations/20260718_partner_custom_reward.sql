-- Per-partner reward overrides.
--
-- The reward rate (default 70%) and window count (default 2 payments) were global
-- env vars (REFERRAL_REWARD_RATE / REFERRAL_REWARD_MONTHS) applied to every partner.
-- These two nullable columns let staff set a custom rate/window per partner from
-- qait-admin. NULL means "use the global env default" — so existing partners are
-- unchanged and need no backfill.
--
-- Forward-only: a change affects only FUTURE invoices. Past rewards keep the rate
-- they were booked at (partner_reward_transactions is append-only and stores the
-- applied `rate` in metadata; the window gate counts existing rows, so already-paid
-- invoices are never re-rated).
--
-- Additive/idempotent; base referral tables from 20260713_referrals.sql must exist.

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS reward_rate NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS reward_window_count INTEGER;

-- Guard rails at the DB layer (the API validates too): rate in [0,1], window >= 0.
ALTER TABLE partners
  DROP CONSTRAINT IF EXISTS partners_reward_rate_range;
ALTER TABLE partners
  ADD CONSTRAINT partners_reward_rate_range
  CHECK (reward_rate IS NULL OR (reward_rate >= 0 AND reward_rate <= 1));

ALTER TABLE partners
  DROP CONSTRAINT IF EXISTS partners_reward_window_nonneg;
ALTER TABLE partners
  ADD CONSTRAINT partners_reward_window_nonneg
  CHECK (reward_window_count IS NULL OR reward_window_count >= 0);

COMMENT ON COLUMN partners.reward_rate IS
  'Per-partner reward share of the referred user''s paid amount, 0..1. NULL = use global REFERRAL_REWARD_RATE.';
COMMENT ON COLUMN partners.reward_window_count IS
  'Per-partner number of a referred user''s payments that are rewarded. NULL = use global REFERRAL_REWARD_MONTHS.';
