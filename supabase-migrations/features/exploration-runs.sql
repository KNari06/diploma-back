-- =====================================================
-- Exploration Runs Table
-- Tracks autonomous exploration run history and results
-- =====================================================

CREATE TABLE IF NOT EXISTS exploration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exploration_id TEXT UNIQUE NOT NULL,    -- expl-{timestamp}-{userId}
  project_id TEXT NOT NULL,
  user_id UUID NOT NULL,
  chat_session_id UUID,

  -- Input
  entry_url TEXT NOT NULL,
  config JSONB,                          -- budget, scope, credentials hint

  -- Status
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),

  -- Results
  summary JSONB,                         -- pages_visited, flows_executed, coverage, etc.
  budget_used JSONB,                     -- time_ms, ai_calls, pages
  duration_ms INTEGER,
  test_cases_count INTEGER DEFAULT 0,
  error_message TEXT,

  -- Crash recovery
  checkpoint JSONB,
  resume_count INTEGER DEFAULT 0,

  -- Timestamps
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_exploration_runs_project
  ON exploration_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_exploration_runs_user
  ON exploration_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_exploration_runs_status
  ON exploration_runs(status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_exploration_runs_exploration_id
  ON exploration_runs(exploration_id);

-- RLS
ALTER TABLE exploration_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own exploration runs"
  ON exploration_runs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage exploration runs"
  ON exploration_runs FOR ALL
  USING (true)
  WITH CHECK (true);

-- RPC for atomic resume count increment
CREATE OR REPLACE FUNCTION increment_exploration_resume_count(p_exploration_id TEXT)
RETURNS INTEGER AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE exploration_runs
  SET resume_count = resume_count + 1
  WHERE exploration_id = p_exploration_id
  RETURNING resume_count INTO new_count;

  RETURN COALESCE(new_count, 999);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE exploration_runs IS 'Tracks autonomous exploration runs and their results';
