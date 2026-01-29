-- ============================================================================
-- INTENT TEST CASES: LINK TO FLOW + SAVED TEST CASE
-- ============================================================================
-- Purpose:
-- - Attach Step Editor drafts (intent_test_cases) to a specific Flow (test_flows)
-- - Optionally attach the draft to the Flow's replay entity (saved_test_cases)
-- This enables "open flow -> load its draft steps" UX without changing replay logic.
-- ============================================================================

-- 1) Columns (nullable to avoid breaking existing rows)
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS flow_id UUID,
  ADD COLUMN IF NOT EXISTS saved_test_case_id UUID;

-- 2) Foreign keys (added defensively; Postgres has no ADD CONSTRAINT IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'intent_test_cases_flow_id_fkey'
  ) THEN
    ALTER TABLE intent_test_cases
      ADD CONSTRAINT intent_test_cases_flow_id_fkey
      FOREIGN KEY (flow_id)
      REFERENCES test_flows(id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'intent_test_cases_saved_test_case_id_fkey'
  ) THEN
    ALTER TABLE intent_test_cases
      ADD CONSTRAINT intent_test_cases_saved_test_case_id_fkey
      FOREIGN KEY (saved_test_case_id)
      REFERENCES saved_test_cases(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

-- 3) Indexes
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_flow_id
  ON intent_test_cases(flow_id);

CREATE INDEX IF NOT EXISTS idx_intent_test_cases_saved_test_case_id
  ON intent_test_cases(saved_test_case_id);

-- Common access pattern: list drafts by user within a flow (editor reopen)
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_flow_user
  ON intent_test_cases(flow_id, user_id);

-- 4) Comments
COMMENT ON COLUMN intent_test_cases.flow_id IS 'Optional link to test_flows.id (Flow this editor draft belongs to)';
COMMENT ON COLUMN intent_test_cases.saved_test_case_id IS 'Optional link to saved_test_cases.id (replay entity for this draft)';
