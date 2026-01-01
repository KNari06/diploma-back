-- ============================================================================
-- REGRESSION TESTING TABLES
-- ============================================================================
-- Tables for saving and re-running test flows as regression test cases/suites
-- ============================================================================

-- 1. SAVED TEST CASES
-- Individual test flows saved for replay
CREATE TABLE IF NOT EXISTS saved_test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL,
  user_id TEXT NOT NULL, -- TEXT to match project convention (supports UUID and IP)

  -- Source information
  source_test_id UUID REFERENCES tests(id) ON DELETE SET NULL,
  source_intelligent_session_id UUID REFERENCES intelligent_test_sessions(id) ON DELETE SET NULL,

  -- Metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Classification
  kind TEXT NOT NULL DEFAULT 'standalone' CHECK (kind IN ('standalone', 'regression_member')),

  -- Replay strategy
  replay_strategy TEXT NOT NULL DEFAULT 'commands' CHECK (replay_strategy IN ('commands', 'graph_extract')),

  -- Replay data
  commands JSONB, -- Preferred: list of executable commands
  graph_ref JSONB, -- Fallback: minimal step reference from graph_data
  url TEXT, -- The URL to replay against (persisted from source test)

  -- Parameterization
  parameters_schema JSONB, -- Schema for values that must be provided at runtime

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  CONSTRAINT fk_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_source_test FOREIGN KEY (source_test_id) REFERENCES tests(id) ON DELETE SET NULL,
  CONSTRAINT fk_source_session FOREIGN KEY (source_intelligent_session_id) REFERENCES intelligent_test_sessions(id) ON DELETE SET NULL
  -- Note: user_id is TEXT (no FK) to support both UUID and IP-based anonymous users
);

-- 2. REGRESSION SUITES
-- Collections of related test cases
CREATE TABLE IF NOT EXISTS regression_suites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL,
  user_id TEXT NOT NULL, -- TEXT to match project convention

  -- Metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  CONSTRAINT fk_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  -- Note: user_id is TEXT (no FK) to support both UUID and IP-based anonymous users
);

-- 3. REGRESSION SUITE ITEMS
-- Links test cases to suites with ordering
CREATE TABLE IF NOT EXISTS regression_suite_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References
  suite_id UUID NOT NULL,
  saved_test_case_id UUID NOT NULL,

  -- Ordering
  order_index INTEGER NOT NULL,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  CONSTRAINT fk_suite FOREIGN KEY (suite_id) REFERENCES regression_suites(id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_test_case FOREIGN KEY (saved_test_case_id) REFERENCES saved_test_cases(id) ON DELETE CASCADE,
  CONSTRAINT unique_suite_case UNIQUE (suite_id, saved_test_case_id)
);

-- 4. REGRESSION RUNS
-- Track execution of saved test cases and suites
CREATE TABLE IF NOT EXISTS regression_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was run (one of these will be set)
  suite_id UUID,
  saved_test_case_id UUID,

  -- Ownership
  project_id UUID NOT NULL,
  user_id TEXT NOT NULL, -- TEXT to match project convention

  -- Execution metadata
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'chat', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),

  -- Underlying test tracking (for status updates)
  test_id UUID, -- For single saved test case runs (references tests.id)
  test_ids JSONB, -- For suite runs (array of test.id UUIDs)

  -- Results summary
  summary JSONB, -- { total, passed, failed, cancelled, duration, etc. }

  -- Timestamps
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,

  -- Constraints
  CONSTRAINT fk_suite FOREIGN KEY (suite_id) REFERENCES regression_suites(id) ON DELETE SET NULL,
  CONSTRAINT fk_saved_test_case FOREIGN KEY (saved_test_case_id) REFERENCES saved_test_cases(id) ON DELETE SET NULL,
  CONSTRAINT fk_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_test FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE SET NULL,
  -- Note: user_id is TEXT (no FK) to support both UUID and IP-based anonymous users
  -- Note: test_ids is JSONB array (no FK) - references stored as UUID strings in array
  CONSTRAINT check_run_target CHECK (
    (suite_id IS NOT NULL AND saved_test_case_id IS NULL) OR
    (suite_id IS NULL AND saved_test_case_id IS NOT NULL)
  )
);

-- ============================================================================
-- INDEXES for performance
-- ============================================================================

-- Saved test cases
CREATE INDEX IF NOT EXISTS idx_saved_test_cases_project
  ON saved_test_cases(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_test_cases_user
  ON saved_test_cases(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_test_cases_source_test
  ON saved_test_cases(source_test_id);
CREATE INDEX IF NOT EXISTS idx_saved_test_cases_kind
  ON saved_test_cases(kind, project_id);

-- Regression suites
CREATE INDEX IF NOT EXISTS idx_regression_suites_project
  ON regression_suites(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_regression_suites_user
  ON regression_suites(user_id, created_at DESC);

-- Regression suite items
CREATE INDEX IF NOT EXISTS idx_regression_suite_items_suite
  ON regression_suite_items(suite_id, order_index);
CREATE INDEX IF NOT EXISTS idx_regression_suite_items_case
  ON regression_suite_items(saved_test_case_id);

-- Regression runs
CREATE INDEX IF NOT EXISTS idx_regression_runs_project
  ON regression_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_regression_runs_user
  ON regression_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_regression_runs_suite
  ON regression_runs(suite_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_regression_runs_case
  ON regression_runs(saved_test_case_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_regression_runs_status
  ON regression_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_regression_runs_test_id
  ON regression_runs(test_id) WHERE test_id IS NOT NULL;

-- ✅ GIN index for JSONB array search (test_ids contains operator)
-- Allows efficient queries like: WHERE test_ids @> '["uuid"]'::jsonb
CREATE INDEX IF NOT EXISTS idx_regression_runs_test_ids_gin
  ON regression_runs USING GIN(test_ids) WHERE test_ids IS NOT NULL;

-- ============================================================================
-- TRIGGERS for auto-updating updated_at
-- ============================================================================

-- Function to update updated_at (reuse existing if available)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_saved_test_cases_updated_at ON saved_test_cases;
CREATE TRIGGER update_saved_test_cases_updated_at
  BEFORE UPDATE ON saved_test_cases
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_regression_suites_updated_at ON regression_suites;
CREATE TRIGGER update_regression_suites_updated_at
  BEFORE UPDATE ON regression_suites
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- COMMENTS for documentation
-- ============================================================================

COMMENT ON TABLE saved_test_cases IS 'Saved test flows for replay as standalone cases or regression suite members';
COMMENT ON TABLE regression_suites IS 'Collections of related test cases that run together';
COMMENT ON TABLE regression_suite_items IS 'Links between suites and test cases with ordering';
COMMENT ON TABLE regression_runs IS 'Execution tracking for saved test cases and suites';

COMMENT ON COLUMN saved_test_cases.replay_strategy IS 'Preferred: commands (executable), fallback: graph_extract (needs conversion)';
COMMENT ON COLUMN saved_test_cases.parameters_schema IS 'JSON schema for values that must be provided at runtime (e.g., passwords)';
COMMENT ON COLUMN regression_runs.trigger IS 'How the run was initiated: manual (UI/API), chat (command), scheduled (cron)';
COMMENT ON COLUMN regression_runs.summary IS 'Aggregated results: { total, passed, failed, cancelled, duration_ms, test_ids }';

-- ============================================================================
-- FUNCTIONS for convenience
-- ============================================================================

-- Function to get suite with all test cases
-- Returns one row per test case in the suite, ordered by order_index
-- If suite has no cases, returns one row with suite info and NULL case fields
CREATE OR REPLACE FUNCTION get_suite_with_cases(suite_uuid UUID)
RETURNS TABLE (
  suite_id UUID,
  suite_name TEXT,
  suite_description TEXT,
  case_id UUID,
  case_name TEXT,
  case_order INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.description,
    c.id,
    c.name,
    i.order_index
  FROM regression_suites s
  LEFT JOIN regression_suite_items i ON s.id = i.suite_id
  LEFT JOIN saved_test_cases c ON i.saved_test_case_id = c.id
  WHERE s.id = suite_uuid
  ORDER BY
    CASE WHEN i.order_index IS NULL THEN 999999 ELSE i.order_index END,
    i.order_index NULLS LAST;
END;
$$ LANGUAGE plpgsql;

-- ✅ Add comment for function
COMMENT ON FUNCTION get_suite_with_cases(UUID) IS
  'Returns suite with all test cases ordered by order_index. Returns NULL case fields if suite has no cases.';

-- ============================================================================
-- SUCCESS
-- ============================================================================
