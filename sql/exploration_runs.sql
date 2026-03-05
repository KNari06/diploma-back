-- ═══════════════════════════════════════════════════════════════════════════
-- EXPLORATION RUNS TABLE
-- Tracks autonomous exploration sessions and their results.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS exploration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exploration_id TEXT UNIQUE NOT NULL,
  project_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  chat_session_id UUID,
  entry_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed
  config JSONB,
  summary JSONB,
  budget_used JSONB,
  duration_ms INTEGER,
  test_cases_count INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_exploration_runs_project_id ON exploration_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_exploration_runs_user_id ON exploration_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_exploration_runs_status ON exploration_runs(status);
CREATE INDEX IF NOT EXISTS idx_exploration_runs_started_at ON exploration_runs(started_at DESC);

-- Checkpoint/resume support
ALTER TABLE exploration_runs
  ADD COLUMN IF NOT EXISTS checkpoint JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS resume_count INTEGER DEFAULT 0;

-- FK constraint: exploration runs must belong to a valid project
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_exploration_runs_project'
      AND table_name = 'exploration_runs'
  ) THEN
    ALTER TABLE exploration_runs
      ADD CONSTRAINT fk_exploration_runs_project
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  END IF;
END;
$$;

-- RLS policy (optional - service role bypasses RLS)
ALTER TABLE exploration_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'exploration_runs'
      AND policyname = 'Users can view their own exploration runs'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view their own exploration runs"
      ON exploration_runs FOR SELECT
      USING (user_id = auth.uid()::text)';
  END IF;
END;
$$;

-- Atomic resume count increment to avoid read-then-write race in crash recovery.
-- Returns the NEW resume_count value after increment.
CREATE OR REPLACE FUNCTION increment_exploration_resume_count(p_exploration_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE exploration_runs
    SET resume_count = COALESCE(resume_count, 0) + 1,
        status = 'running'
    WHERE exploration_id = p_exploration_id
  RETURNING resume_count INTO v_new_count;

  IF NOT FOUND THEN
    RETURN 999;
  END IF;

  RETURN v_new_count;
END;
$$;
