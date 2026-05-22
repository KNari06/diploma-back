-- ═══════════════════════════════════════════════════════════════════════════
-- ACCOUNT DELETION — soft-delete columns + scheduled hard-purge
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds the minimum schema needed to support self-service account deletion
-- with a 30-day grace period.
--
-- Flow:
--   1. User requests deletion → `deleted_at = now()`, `deletion_scheduled_for
--      = now() + 30 days`. Stripe subscription cancelled immediately, OAuth
--      tokens revoked best-effort, BullMQ repeatables removed.
--   2. Auth middleware sees `deleted_at IS NOT NULL` → returns 401 with
--      `code: 'ACCOUNT_DELETED'` on every subsequent request. The existing
--      JWT becomes useless even though Supabase auth still recognises the
--      user (we don't sign them out of Supabase until hard-purge — that
--      gives support a clean handle to restore the account during the
--      grace window).
--   3. A daily cron job (`jobs/account-deletion-purge.job.ts`) picks up
--      rows where `deletion_scheduled_for <= now()` and runs the full
--      cascade: storage bucket purges, owned workspaces destroyed,
--      `public.users` row deleted (FK CASCADE handles most child tables),
--      `auth.users` deleted via Supabase admin API.
--   4. Support can `UPDATE users SET deleted_at = NULL, deletion_scheduled_for
--      = NULL WHERE id = ?` to undo during the grace window. No public
--      "undo" UX in v1 — that's a v2 follow-up.
--
-- Why a partial unique index on `deleted_at IS NULL`:
--   We don't want a deleted user to keep blocking re-signup with the same
--   email. The trade-off is intentional — if `auth.users.email` is unique
--   and we leave the deleted-but-not-purged row in place, a user who
--   accidentally deleted can't sign back up until the cron fires. v2 may
--   handle re-signup by purging the soft-deleted row early on email match.
--
-- Idempotent: safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.users.deleted_at IS
  'Set when user initiates self-deletion. Auth middleware rejects requests when non-null.';
COMMENT ON COLUMN public.users.deletion_scheduled_for IS
  'When the hard-purge cron should fire. Typically deleted_at + 30 days.';

-- Cron sweep predicate: index on `deletion_scheduled_for WHERE deleted_at IS
-- NOT NULL` keeps the daily lookup ~O(log n) even at millions of rows.
-- Partial index is intentional — the vast majority of users are not deleted
-- so a full index would be wasted space.
--
-- Production note: this CREATE INDEX (non-CONCURRENT) acquires a SHARE
-- lock on `public.users` for the duration of the build. The build scans
-- every row but commits to the index only those matching the partial
-- predicate — at adoption-day zero that's zero rows, so the scan is
-- I/O-bound and brief. If you ever re-apply this on a 50M-row table
-- under load and the lock is unacceptable, split into a separate
-- non-transactional migration with `CREATE INDEX CONCURRENTLY`.
CREATE INDEX IF NOT EXISTS idx_users_deletion_scheduled
  ON public.users (deletion_scheduled_for)
  WHERE deleted_at IS NOT NULL;

-- RLS posture: existing policies on `public.users` already gate by
-- `auth.uid() = id`. We DON'T add `deleted_at IS NULL` predicates to those
-- policies — that would break the support-tooling path of reading a
-- soft-deleted user's row to restore them. Auth middleware is the
-- enforcement layer; RLS stays read-permissive for the owner during grace.
