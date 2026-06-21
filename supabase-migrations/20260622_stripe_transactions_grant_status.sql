-- ============================================================================
-- Migration: stripe_transactions.credits_granted — make the payment idempotency
--            barrier track whether credits were actually delivered.
-- Date: 2026-06-22
-- Description:
--   handleInvoicePaymentSucceeded INSERTs a stripe_transactions row FIRST (the
--   UNIQUE(stripe_invoice_id) barrier prevents double-grant), THEN grants
--   credits. But the row existing != credits delivered. If the grant fails
--   transiently or the process dies between INSERT and grant, the row is left
--   behind: Stripe's retry hits the 23505 barrier and bows out WITHOUT granting,
--   so the user paid and never received credits — permanently.
--
--   This column lets the barrier double as a RECONCILIATION point: the row is
--   inserted with credits_granted=false, flipped to true only after the grant
--   succeeds. On a duplicate (23505) delivery the handler re-checks the column
--   and re-attempts the grant when it is still false, so transient failures and
--   crashes self-heal on Stripe's retry instead of silently losing money.
--
-- SAFE TO APPLY AS-IS. Adds a nullable-with-default column. Backfills existing
-- rows to TRUE (they were inserted by the old code only on the success path, so
-- treating them as granted preserves current behavior and avoids re-granting
-- historical invoices). Apply BEFORE deploying the backend that writes it.
-- ============================================================================

ALTER TABLE public.stripe_transactions
  ADD COLUMN IF NOT EXISTS credits_granted BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.stripe_transactions.credits_granted IS
  'Whether the credit grant for this invoice actually completed. New rows are inserted false and flipped true after the grant succeeds; the webhook re-attempts the grant on a duplicate delivery while this is false. Existing rows backfilled true (old code only inserted on success).';

-- New rows must start false; only the post-grant UPDATE sets true. The DEFAULT
-- true above is purely to backfill existing rows as already-granted — the
-- application always inserts an explicit credits_granted value going forward.
