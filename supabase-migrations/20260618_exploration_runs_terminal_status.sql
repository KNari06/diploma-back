-- Allow terminal statuses 'timed_out' and 'cancelled' on exploration_runs.
--
-- WHY: exploration_runs.status only modeled 'running' | 'completed' | 'failed'
-- (features/exploration-runs.sql). A run whose worker dies never receives a
-- terminal write, so it stays 'running' forever — the history list shows a
-- perpetual spinner and there is no way to cancel. The client-side stall
-- watchdog (web ExplorationLive) papers over the LIVE view, but the DB row is
-- still 'running', so the list and any server consumer can't tell stuck from
-- in-progress. This adds the two terminal statuses the backend needs to mark a
-- run timed out (stale-run sweep) or cancelled (future cancel endpoint).
-- Mirrors the tests.status set, which already carries 'timeout'/'cancelled'
-- (20260603_add_timeout_to_test_status.sql).
--
-- status is TEXT + CHECK here (not an enum), so we swap the CHECK constraint.
-- Production currently has NO check constraint on this column (the table was
-- applied without the one declared in features/exploration-runs.sql), so the
-- DROP is guarded by IF EXISTS and the ADD installs the canonical set.
--
-- Idempotent: DROP IF EXISTS + a fixed constraint name make re-runs safe.

ALTER TABLE public.exploration_runs
  DROP CONSTRAINT IF EXISTS exploration_runs_status_check;

ALTER TABLE public.exploration_runs
  ADD CONSTRAINT exploration_runs_status_check
  CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled'));

COMMENT ON COLUMN public.exploration_runs.status IS
  'Run lifecycle: running | completed | failed | timed_out (worker died / stale sweep) | cancelled (user aborted).';
