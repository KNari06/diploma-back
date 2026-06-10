-- =============================================================================
-- Negative Testing — per-negative enable/disable toggle
-- =============================================================================
-- Lets the user disable an individual generated negative without deleting it.
-- A disabled negative is kept (steps, meta) but excluded from regression runs.
-- Distinct from negative_stale_reason (which marks a negative as outdated after
-- the parent's steps changed). Both must be clear for a negative to run.

BEGIN;

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS negative_enabled BOOLEAN DEFAULT TRUE;

-- Run-expansion filters runnable negatives by source: WHERE is_negative AND
-- stale IS NULL AND negative_enabled, then IN (source ids). Lead the partial
-- index with source_intent_test_case_id so the IN-clause is seekable under the
-- predicate (matches getFreshNegativesBySources exactly).
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_negative_run
  ON intent_test_cases(source_intent_test_case_id)
  WHERE is_negative = TRUE
    AND negative_stale_reason IS NULL
    AND negative_enabled = TRUE;

COMMENT ON COLUMN intent_test_cases.negative_enabled IS 'Per-negative run toggle: true=included in regression, false=kept but skipped. Independent of negative_stale_reason.';

COMMIT;
