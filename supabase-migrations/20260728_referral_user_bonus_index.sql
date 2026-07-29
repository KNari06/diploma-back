-- Referred-user credit bonus → index support.
--
-- The user-side benefit (a per-plan credit multiplier on a referred user's paid
-- invoice, REFERRAL_USER_BONUS_PLANS) needs two reads on the Stripe webhook
-- path, both in referral.db.ts:
--   hasBonusForInvoice   — metadata->>'referral_bonus_invoice' = <invoice id>
--   countUserBonusGrants — metadata->>'referral_bonus_plan'    = <plan code>
--
-- credit_transactions has NO index on user_id and grows with every credit
-- deduction (~17k rows at time of writing), so without these both reads are
-- sequential scans on a money path that runs per paid invoice.
--
-- PARTIAL indexes: only rows carrying a bonus marker are indexed, so these stay
-- proportional to the number of bonused invoices (a tiny fraction of the table)
-- rather than to the table itself.
--
-- The predicate is `(metadata->>'k') IS NOT NULL`, NOT the more natural
-- `metadata ? 'k'`, and that choice is load-bearing. Postgres only uses a
-- partial index when the query proves the predicate holds, and it does not treat
-- the two forms as equivalent — with a `?` predicate the PostgREST-generated
-- query (which can only express the IS NOT NULL form, via
-- `.not('metadata->>k','is',null)`) fell back to a sequential scan. Verified
-- with EXPLAIN: both reads are Index Scans in this form.
--
-- Callers MUST keep that null-check clause in the query, or the planner drops
-- back to a seq scan over every credit transaction ever written.
--
-- Purely additive and idempotent — no bonus rows exist yet, so this is safe to
-- apply before the feature code deploys.

CREATE INDEX IF NOT EXISTS credit_transactions_referral_bonus_invoice_idx
  ON credit_transactions (user_id, (metadata->>'referral_bonus_invoice'))
  WHERE (metadata->>'referral_bonus_invoice') IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_transactions_referral_bonus_plan_idx
  ON credit_transactions (user_id, (metadata->>'referral_bonus_plan'))
  WHERE (metadata->>'referral_bonus_plan') IS NOT NULL;

COMMENT ON INDEX credit_transactions_referral_bonus_invoice_idx IS
  'Per-invoice idempotency for the referred-user credit bonus: a Stripe webhook retry of an already-bonused invoice must not grant it twice.';
COMMENT ON INDEX credit_transactions_referral_bonus_plan_idx IS
  'Counts a referred user''s bonused invoices PER PLAN — each plan carries its own bonus window, so an upgrade must not inherit the old plan''s spent window.';
