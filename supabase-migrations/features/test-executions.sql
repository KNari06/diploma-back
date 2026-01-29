-- ============================================================================
-- TEST EXECUTIONS TABLE
-- ============================================================================
-- Unified execution layer for both UI and API tests
-- Provides consistent reporting and analytics across test types
-- ============================================================================

-- Test Executions Table
CREATE TABLE IF NOT EXISTS test_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to regression run
  run_id UUID REFERENCES regression_runs(id) ON DELETE CASCADE,

  -- Test identification
  test_type TEXT NOT NULL CHECK (test_type IN ('ui', 'api')),
  test_case_id UUID NOT NULL,  -- saved_test_cases.id or api_test_configs.id

  -- Hierarchy context (denormalized for fast queries)
  module_id UUID REFERENCES test_modules(id) ON DELETE SET NULL,
  suite_id UUID REFERENCES regression_suites(id) ON DELETE SET NULL,
  flow_id UUID REFERENCES test_flows(id) ON DELETE SET NULL,

  -- Execution status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'passed', 'failed', 'skipped', 'cancelled')),

  -- Timing
  duration_ms INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Results
  result JSONB DEFAULT '{}',
  error_message TEXT,

  -- Artifacts
  screenshot_url TEXT,
  trace_url TEXT,

  -- Context
  browser TEXT,
  environment TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_test_executions_run
  ON test_executions(run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_test_executions_status
  ON test_executions(status);

CREATE INDEX IF NOT EXISTS idx_test_executions_module
  ON test_executions(module_id, status) WHERE module_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_executions_suite
  ON test_executions(suite_id, status) WHERE suite_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_executions_flow
  ON test_executions(flow_id, status) WHERE flow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_executions_case
  ON test_executions(test_case_id);

CREATE INDEX IF NOT EXISTS idx_test_executions_type
  ON test_executions(test_type, status);

CREATE INDEX IF NOT EXISTS idx_test_executions_completed
  ON test_executions(completed_at DESC) WHERE completed_at IS NOT NULL;

-- Speed up mapping UI test completion -> unified executions (result->>testId)
CREATE INDEX IF NOT EXISTS idx_test_executions_result_test_id
  ON test_executions ((result->>'testId'))
  WHERE result ? 'testId';

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE test_executions ENABLE ROW LEVEL SECURITY;

-- Access via regression_runs ownership
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_executions'
      AND policyname = 'Users can view own test executions'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own test executions" ON test_executions FOR SELECT USING (EXISTS (SELECT 1 FROM regression_runs rr WHERE rr.id = test_executions.run_id AND rr.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_executions'
      AND policyname = 'Users can insert own test executions'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own test executions" ON test_executions FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM regression_runs rr WHERE rr.id = test_executions.run_id AND rr.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_executions'
      AND policyname = 'Users can update own test executions'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own test executions" ON test_executions FOR UPDATE USING (EXISTS (SELECT 1 FROM regression_runs rr WHERE rr.id = test_executions.run_id AND rr.user_id = auth.uid()::text))';
  END IF;
END $$;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Get execution stats for a run
CREATE OR REPLACE FUNCTION get_execution_stats(p_run_id UUID)
RETURNS TABLE (
  total INTEGER,
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  pending INTEGER,
  running INTEGER,
  cancelled INTEGER,
  pass_rate NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::INTEGER as total,
    COUNT(*) FILTER (WHERE status = 'passed')::INTEGER as passed,
    COUNT(*) FILTER (WHERE status = 'failed')::INTEGER as failed,
    COUNT(*) FILTER (WHERE status = 'skipped')::INTEGER as skipped,
    COUNT(*) FILTER (WHERE status = 'pending')::INTEGER as pending,
    COUNT(*) FILTER (WHERE status = 'running')::INTEGER as running,
    COUNT(*) FILTER (WHERE status = 'cancelled')::INTEGER as cancelled,
    CASE
      WHEN COUNT(*) FILTER (WHERE status IN ('passed', 'failed')) > 0
      THEN ROUND(
        COUNT(*) FILTER (WHERE status = 'passed')::NUMERIC /
        COUNT(*) FILTER (WHERE status IN ('passed', 'failed'))::NUMERIC * 100,
        2
      )
      ELSE 0
    END as pass_rate
  FROM test_executions
  WHERE run_id = p_run_id;
END;
$$ LANGUAGE plpgsql;

-- Get execution stats for a module
CREATE OR REPLACE FUNCTION get_module_execution_stats(p_module_id UUID, p_days INTEGER DEFAULT 30)
RETURNS TABLE (
  total INTEGER,
  passed INTEGER,
  failed INTEGER,
  pass_rate NUMERIC,
  avg_duration_ms NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::INTEGER as total,
    COUNT(*) FILTER (WHERE status = 'passed')::INTEGER as passed,
    COUNT(*) FILTER (WHERE status = 'failed')::INTEGER as failed,
    CASE
      WHEN COUNT(*) FILTER (WHERE status IN ('passed', 'failed')) > 0
      THEN ROUND(
        COUNT(*) FILTER (WHERE status = 'passed')::NUMERIC /
        COUNT(*) FILTER (WHERE status IN ('passed', 'failed'))::NUMERIC * 100,
        2
      )
      ELSE 0
    END as pass_rate,
    ROUND(AVG(duration_ms)::NUMERIC, 2) as avg_duration_ms
  FROM test_executions
  WHERE module_id = p_module_id
    AND created_at > NOW() - (p_days || ' days')::INTERVAL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE test_executions IS 'Unified execution records for UI and API tests';
COMMENT ON COLUMN test_executions.test_case_id IS 'References saved_test_cases.id for UI or api_test_configs.id for API';
COMMENT ON COLUMN test_executions.result IS 'JSON object with detailed test results';
COMMENT ON FUNCTION get_execution_stats IS 'Get aggregated execution stats for a regression run';
COMMENT ON FUNCTION get_module_execution_stats IS 'Get execution stats for a module over N days';
