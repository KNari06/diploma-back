-- Distinguish WHY an exploration run ended without results.
--
-- WHY: every failure collapses into status='failed' with the reason living only
-- in error_message, a free-text column written from `error.message`. That is
-- honest to a human reading one run, but it cannot be queried: "how many runs
-- died because the site was unreachable?" or "is this user's site blocking us?"
-- both require LIKE-matching prose that changes whenever a message is reworded.
-- The distinction already exists in code — EntryUnreachableError carries
-- navigation_failed | rate_limited | site_degraded — it just had nowhere to go.
--
-- The two added statuses are the outcomes the run itself can reach:
--   unreachable     — the entry URL never loaded (EntryUnreachableError:
--                     navigation_failed). Usually a typo'd URL or a dead host.
--   blocked_by_bot  — a bot wall / rate limiter stopped us (rate_limited or
--                     site_degraded). The site works; it refuses automation.
--
-- Deliberately NOT added, though the audit asked for it:
--   * `auth_required` — a login wall blocks one FLOW, not the run. The run still
--     finishes `completed` with partial results, so nothing could ever write it.
--   * the pre-flight verdicts (dns_failure, tls_error, bot_challenge…) — those
--     are decided BEFORE the job is enqueued, so no exploration_runs row exists.
-- A status no writer can produce is worse than none: it reads as a supported
-- outcome and every consumer has to handle a case that never occurs.
--
-- `failed` stays the catch-all for a genuine internal error, so nothing needs
-- to be backfilled: existing rows remain correct under the new set.
--
-- status is TEXT + CHECK (not an enum), so we swap the CHECK constraint.
-- Idempotent: DROP IF EXISTS + a fixed constraint name make re-runs safe.
-- Extends 20260618_exploration_runs_terminal_status.sql — the full set is
-- restated here because a CHECK cannot be added to incrementally.

ALTER TABLE public.exploration_runs
  DROP CONSTRAINT IF EXISTS exploration_runs_status_check;

ALTER TABLE public.exploration_runs
  ADD CONSTRAINT exploration_runs_status_check
  CHECK (status IN (
    'running',
    'completed',
    'failed',
    'timed_out',
    'cancelled',
    'unreachable',
    'blocked_by_bot'
  ));

COMMENT ON COLUMN public.exploration_runs.status IS
  'Run lifecycle: running | completed | failed (internal error) | timed_out (worker died / stale sweep) | cancelled (user aborted) | unreachable (entry URL never loaded) | blocked_by_bot (bot wall or rate limiter).';
