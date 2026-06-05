-- Add run_id correlation column to ai_usage_log.
--
-- WHY: ai_usage_log already carries test_id, but a single regression RUN can
-- span many tests, and the most AI-heavy step (post-run bug analysis) had no
-- way to be tied back to the run it belongs to. Without run_id you cannot ask
-- "show me every LLM decision made for run X" — the core query for debugging a
-- hallucinated bug report. test_id alone doesn't group a multi-test plan run.
--
-- Nullable by design: chat / preview / non-regression operations leave it NULL
-- (same contract as test_id).
--
-- Idempotent: IF NOT EXISTS makes re-runs a no-op.

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS run_id UUID;

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_run_id
  ON ai_usage_log(run_id);

COMMENT ON COLUMN ai_usage_log.run_id IS
  'Regression run ID (regression_runs.id) for correlation. NULL for chat / preview / non-regression operations.';
