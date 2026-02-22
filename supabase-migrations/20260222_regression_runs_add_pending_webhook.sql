-- ============================================================================
-- REGRESSION RUNS: Add 'pending' status and 'webhook' trigger
-- ============================================================================
-- The code uses status='pending' for newly created runs before execution starts,
-- and trigger='webhook' for GitHub/GitLab webhook-triggered runs.
-- The original CHECK constraints didn't include these values.
-- ============================================================================

-- 1. Drop and recreate status check constraint to include 'pending'
ALTER TABLE regression_runs
  DROP CONSTRAINT IF EXISTS regression_runs_status_check;

ALTER TABLE regression_runs
  ADD CONSTRAINT regression_runs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'));

-- 2. Drop and recreate trigger check constraint to include 'webhook'
-- The constraint name may vary — try both possible names
ALTER TABLE regression_runs
  DROP CONSTRAINT IF EXISTS regression_runs_trigger_check;

-- Also try the inline check constraint name that Postgres auto-generates
DO $$
BEGIN
  -- Find and drop any CHECK constraint on the trigger column
  PERFORM 1 FROM pg_constraint c
  JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
  WHERE c.conrelid = 'regression_runs'::regclass
    AND c.contype = 'c'
    AND a.attname = 'trigger'
    AND c.conname != 'regression_runs_trigger_check';

  IF FOUND THEN
    EXECUTE (
      SELECT 'ALTER TABLE regression_runs DROP CONSTRAINT ' || quote_ident(c.conname)
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
      WHERE c.conrelid = 'regression_runs'::regclass
        AND c.contype = 'c'
        AND a.attname = 'trigger'
      LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE regression_runs
  ADD CONSTRAINT regression_runs_trigger_check
  CHECK (trigger IN ('manual', 'chat', 'scheduled', 'webhook'));

-- ============================================================================
-- SUCCESS
-- ============================================================================
