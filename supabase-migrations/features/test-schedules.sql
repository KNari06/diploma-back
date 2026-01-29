-- ============================================================================
-- TEST SCHEDULES TABLE
-- ============================================================================
-- Scheduled test runs (cron-based)
-- Can target modules, suites, or regression plans
-- ============================================================================

-- Test Schedules Table
-- NOTE: This table references regression_plans which must be created first
-- Run regression-plans.sql before this migration
CREATE TABLE IF NOT EXISTS test_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- Metadata
  name TEXT NOT NULL,

  -- Target (one of these must be set)
  module_id UUID REFERENCES test_modules(id) ON DELETE CASCADE,
  suite_id UUID REFERENCES regression_suites(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES regression_plans(id) ON DELETE CASCADE,

  -- Schedule configuration
  cron_expression TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  is_active BOOLEAN DEFAULT true,

  -- Runtime parameters
  parameters JSONB DEFAULT '{}',

  -- Tracking
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraint: exactly one target must be set
  CONSTRAINT check_schedule_target CHECK (
    (module_id IS NOT NULL)::int +
    (suite_id IS NOT NULL)::int +
    (plan_id IS NOT NULL)::int = 1
  )
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_test_schedules_project
  ON test_schedules(project_id);

CREATE INDEX IF NOT EXISTS idx_test_schedules_user
  ON test_schedules(user_id);

CREATE INDEX IF NOT EXISTS idx_test_schedules_next_run
  ON test_schedules(next_run_at) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_test_schedules_active
  ON test_schedules(is_active, next_run_at);

CREATE INDEX IF NOT EXISTS idx_test_schedules_module
  ON test_schedules(module_id) WHERE module_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_schedules_suite
  ON test_schedules(suite_id) WHERE suite_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_schedules_plan
  ON test_schedules(plan_id) WHERE plan_id IS NOT NULL;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE test_schedules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_schedules'
      AND policyname = 'Users can view own test schedules'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own test schedules" ON test_schedules FOR SELECT USING (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_schedules'
      AND policyname = 'Users can insert own test schedules'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own test schedules" ON test_schedules FOR INSERT WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_schedules'
      AND policyname = 'Users can update own test schedules'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own test schedules" ON test_schedules FOR UPDATE USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_schedules'
      AND policyname = 'Users can delete own test schedules'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own test schedules" ON test_schedules FOR DELETE USING (user_id = auth.uid()::text)';
  END IF;
END $$;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Get schedules due for execution
CREATE OR REPLACE FUNCTION get_due_schedules()
RETURNS TABLE (
  schedule_id UUID,
  project_id UUID,
  user_id TEXT,
  target_type TEXT,
  target_id UUID,
  parameters JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id as schedule_id,
    s.project_id,
    s.user_id,
    CASE
      WHEN s.module_id IS NOT NULL THEN 'module'
      WHEN s.suite_id IS NOT NULL THEN 'suite'
      WHEN s.plan_id IS NOT NULL THEN 'plan'
    END as target_type,
    COALESCE(s.module_id, s.suite_id, s.plan_id) as target_id,
    s.parameters
  FROM test_schedules s
  WHERE s.is_active = true
    AND s.next_run_at <= NOW();
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE test_schedules IS 'Scheduled test runs with cron expressions';
COMMENT ON COLUMN test_schedules.cron_expression IS 'Cron expression for scheduling (e.g., "0 0 * * *" for daily)';
COMMENT ON COLUMN test_schedules.timezone IS 'Timezone for cron expression interpretation';
COMMENT ON COLUMN test_schedules.next_run_at IS 'Calculated next run time based on cron expression';
COMMENT ON FUNCTION get_due_schedules IS 'Get all schedules that are due for execution';
