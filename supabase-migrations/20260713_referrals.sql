-- Referrals by link.
--
-- Partners promote QAIT via a shareable link (qait.dev/signup?ref=CODE). We track,
-- per partner: registrations (referred users), paid conversions, credits used by
-- referred users, and an owed-balance reward ledger. Partners log in to see their
-- own numbers (role='partner'); staff see all in qait-admin.
--
-- Apply order matters: STEP 0 (enum ADD VALUE) must run on its own — ALTER TYPE
-- ... ADD VALUE cannot run inside a transaction block and the new value is not
-- usable in the same transaction. Run STEP 0 first, then the rest.

-- ===========================================================================
-- STEP 0 — extend the role enum (run ALONE, before anything writes role='partner')
-- The LIVE user_role enum is ('admin','moderator','user') — the base
-- supabase-schema.sql (('admin','user','ai')) is stale; the recreate-tables copy
-- (('user','admin','moderator')) is the accurate one. ADD VALUE IF NOT EXISTS
-- is safe regardless of the starting set.
-- ===========================================================================
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'partner';

-- ===========================================================================
-- STEP 1 — tables, columns, indexes, and the append-only guard
-- (safe to run together after STEP 0 has committed)
-- ===========================================================================

-- partners: a standalone promoter entity. auth_user_id links the partner's login
-- (a public.users row with role='partner') — nullable until the login is provisioned.
CREATE TABLE IF NOT EXISTS partners (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT NOT NULL,                  -- the ?ref=CODE value (case-insensitive, see index)
  name         TEXT NOT NULL,
  email        TEXT,
  auth_user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'active', -- 'active' | 'disabled'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness + lookup: ?ref=Acme and ?ref=acme are the same partner.
CREATE UNIQUE INDEX IF NOT EXISTS partners_code_lower_idx ON partners (lower(code));

COMMENT ON TABLE partners IS
  'Referral partners. code is the ?ref value (case-insensitive). auth_user_id is the partner''s login (role=partner).';

-- Attribution on the referred user (first-touch, permanent). Set once, never overwritten.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_partner_id UUID REFERENCES partners(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_referred_by_partner_idx ON users (referred_by_partner_id);

COMMENT ON COLUMN users.referred_by_partner_id IS
  'First-touch, permanent referral attribution. Set once at first auth if a ?ref code was captured; never overwritten.';

-- Owed-balance reward ledger. Append-only (see trigger below). One row per reward event.
-- referred_user_id is intentionally NOT a FK: a referred user''s public.users row is
-- hard-deleted on account deletion (on_auth_user_deleted), but the owed balance must
-- survive for settlement.
CREATE TABLE IF NOT EXISTS partner_reward_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        UUID NOT NULL REFERENCES partners(id),
  referred_user_id  UUID NOT NULL,
  event_type        TEXT NOT NULL,                       -- 'paid_conversion' (v1); future: 'signup','adjustment'
  amount            NUMERIC NOT NULL,                    -- reward units owed; interpretation is settlement-side
  currency          TEXT NOT NULL DEFAULT 'reward',
  metadata          JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotency: at most one reward of a given kind per (partner, referred user).
  -- Reward inserts use ON CONFLICT DO NOTHING against this constraint.
  UNIQUE (partner_id, referred_user_id, event_type)
);

CREATE INDEX IF NOT EXISTS partner_reward_partner_idx ON partner_reward_transactions (partner_id);

COMMENT ON TABLE partner_reward_transactions IS
  'Append-only owed-balance ledger for referral rewards. UPDATE/DELETE blocked by triggers (mirrors credit_transactions).';

-- Append-only guard — mirrors deny_credit_transactions_mutation (20260420). Triggers
-- fire regardless of role (service_role bypasses RLS, so RLS would not protect this).
CREATE OR REPLACE FUNCTION public.deny_partner_reward_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'partner_reward_transactions is append-only — % is not allowed. To fix data, disable this trigger in a controlled migration.',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS no_update_partner_reward ON public.partner_reward_transactions;
CREATE TRIGGER no_update_partner_reward
  BEFORE UPDATE ON public.partner_reward_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_partner_reward_mutation();

DROP TRIGGER IF EXISTS no_delete_partner_reward ON public.partner_reward_transactions;
CREATE TRIGGER no_delete_partner_reward
  BEFORE DELETE ON public.partner_reward_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_partner_reward_mutation();
