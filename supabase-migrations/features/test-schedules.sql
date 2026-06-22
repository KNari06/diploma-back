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

-- Due-schedule detection lives in the application layer (ScheduleService.
-- getDueSchedules + claimDueSchedule), which is type-aware (recurring advances
-- next_run_at; one_time deactivates). The old get_due_schedules() RPC was never
-- called and would have masked that divergence — drop it so it can't mislead.
DROP FUNCTION IF EXISTS get_due_schedules();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE test_schedules IS 'Scheduled test runs: recurring (cron) or one_time (run_at, fires once then deactivates)';
COMMENT ON COLUMN test_schedules.cron_expression IS 'Cron expression for a recurring schedule (e.g., "0 0 * * *" for daily). NULL for one_time.';
COMMENT ON COLUMN test_schedules.timezone IS 'Timezone for cron interpretation (recurring). Informational for one_time — run_at is an absolute instant.';
COMMENT ON COLUMN test_schedules.next_run_at IS 'Next run time. For recurring, computed from cron; for one_time, equals run_at and is cleared to NULL after it fires.';

-- ============================================================================
-- ONE-SHOT (ONE-TIME) SCHEDULE SUPPORT
-- ============================================================================
-- A schedule is either:
--   - recurring: fires on every cron_expression occurrence (next_run_at advances)
--   - one_time:  fires once at run_at, then is_active flips to false
-- Due-detection is identical for both (next_run_at <= NOW()); only the
-- claim/advance step differs (advance cron vs. deactivate). Idempotent so it
-- can be re-applied over an existing table.

ALTER TABLE test_schedules
  ADD COLUMN IF NOT EXISTS schedule_type TEXT NOT NULL DEFAULT 'recurring',
  ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ;

-- cron_expression must be nullable so one_time rows can omit it.
ALTER TABLE test_schedules
  ALTER COLUMN cron_expression DROP NOT NULL;

-- Integrity: recurring => cron required & run_at null; one_time => run_at required & cron null.
ALTER TABLE test_schedules
  DROP CONSTRAINT IF EXISTS check_schedule_mode;
ALTER TABLE test_schedules
  ADD CONSTRAINT check_schedule_mode CHECK (
    (schedule_type = 'recurring' AND cron_expression IS NOT NULL AND run_at IS NULL)
    OR
    (schedule_type = 'one_time' AND run_at IS NOT NULL AND cron_expression IS NULL)
  );

COMMENT ON COLUMN test_schedules.schedule_type IS 'recurring (cron) or one_time (fires once at run_at then deactivates)';
COMMENT ON COLUMN test_schedules.run_at IS 'Absolute UTC instant for a one_time schedule. NULL for recurring.';
