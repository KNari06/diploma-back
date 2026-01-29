-- ============================================================================
-- TEST HIERARCHY ALTERATIONS
-- ============================================================================
-- Add new columns to existing tables for hierarchy support
-- Run AFTER creating new tables (test_modules, test_flows, regression_plans)
-- ============================================================================

-- ============================================================================
-- 1. REGRESSION_SUITES ALTERATIONS
-- ============================================================================

-- Add module_id reference
ALTER TABLE regression_suites
  ADD COLUMN IF NOT EXISTS module_id UUID REFERENCES test_modules(id) ON DELETE SET NULL;

-- Add suite_type for UI/API distinction
ALTER TABLE regression_suites
  ADD COLUMN IF NOT EXISTS suite_type TEXT DEFAULT 'ui';

-- Add check constraint for suite_type (only if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'regression_suites_suite_type_check'
  ) THEN
    ALTER TABLE regression_suites
      ADD CONSTRAINT regression_suites_suite_type_check
      CHECK (suite_type IN ('ui', 'api', 'mixed'));
  END IF;
END $$;

-- Add tags array
ALTER TABLE regression_suites
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Add priority
ALTER TABLE regression_suites
  ADD COLUMN IF NOT EXISTS priority TEXT;

-- Add check constraint for priority (only if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'regression_suites_priority_check'
  ) THEN
    ALTER TABLE regression_suites
      ADD CONSTRAINT regression_suites_priority_check
      CHECK (priority IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

-- Add setup/teardown steps
ALTER TABLE regression_suites
  ADD COLUMN IF NOT EXISTS setup_steps JSONB DEFAULT '[]';

ALTER TABLE regression_suites
  ADD COLUMN IF NOT EXISTS teardown_steps JSONB DEFAULT '[]';

-- ============================================================================
-- 2. SAVED_TEST_CASES ALTERATIONS
-- ============================================================================

-- Add flow_id reference
ALTER TABLE saved_test_cases
  ADD COLUMN IF NOT EXISTS flow_id UUID REFERENCES test_flows(id) ON DELETE SET NULL;

-- Add tags array
ALTER TABLE saved_test_cases
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Add priority
ALTER TABLE saved_test_cases
  ADD COLUMN IF NOT EXISTS priority TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'saved_test_cases_priority_check'
  ) THEN
    ALTER TABLE saved_test_cases
      ADD CONSTRAINT saved_test_cases_priority_check
      CHECK (priority IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

-- Add preconditions
ALTER TABLE saved_test_cases
  ADD COLUMN IF NOT EXISTS preconditions JSONB DEFAULT '[]';

-- Add setup/teardown steps
ALTER TABLE saved_test_cases
  ADD COLUMN IF NOT EXISTS setup_steps JSONB DEFAULT '[]';

ALTER TABLE saved_test_cases
  ADD COLUMN IF NOT EXISTS teardown_steps JSONB DEFAULT '[]';

-- Add expected_result
ALTER TABLE saved_test_cases
  ADD COLUMN IF NOT EXISTS expected_result TEXT;

-- Add depends_on array (for dependencies between test cases)
ALTER TABLE saved_test_cases
  ADD COLUMN IF NOT EXISTS depends_on UUID[] DEFAULT '{}';

-- ============================================================================
-- 3. INTENT_TEST_CASES ALTERATIONS
-- ============================================================================

-- Add flow_id reference
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS flow_id UUID REFERENCES test_flows(id) ON DELETE SET NULL;

-- Add tags array
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Add priority
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS priority TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intent_test_cases_priority_check'
  ) THEN
    ALTER TABLE intent_test_cases
      ADD CONSTRAINT intent_test_cases_priority_check
      CHECK (priority IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

-- Add preconditions
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS preconditions JSONB DEFAULT '[]';

-- Add setup/teardown steps
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS setup_steps JSONB DEFAULT '[]';

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS teardown_steps JSONB DEFAULT '[]';

-- Add expected_result
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS expected_result TEXT;

-- Add depends_on array
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS depends_on UUID[] DEFAULT '{}';

-- ============================================================================
-- 4. API_TEST_CONFIGS ALTERATIONS
-- ============================================================================

-- Add flow_id reference
ALTER TABLE api_test_configs
  ADD COLUMN IF NOT EXISTS flow_id UUID REFERENCES test_flows(id) ON DELETE SET NULL;

-- Add tags array
ALTER TABLE api_test_configs
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Add priority
ALTER TABLE api_test_configs
  ADD COLUMN IF NOT EXISTS priority TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_test_configs_priority_check'
  ) THEN
    ALTER TABLE api_test_configs
      ADD CONSTRAINT api_test_configs_priority_check
      CHECK (priority IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

-- Add expected_result (in addition to existing expected_response)
ALTER TABLE api_test_configs
  ADD COLUMN IF NOT EXISTS expected_result TEXT;

-- Add depends_on array
ALTER TABLE api_test_configs
  ADD COLUMN IF NOT EXISTS depends_on UUID[] DEFAULT '{}';

-- ============================================================================
-- 5. REGRESSION_RUNS ALTERATIONS
-- ============================================================================

-- Add module_id for module-level runs
ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS module_id UUID REFERENCES test_modules(id) ON DELETE SET NULL;

-- Add flow_id for flow-level runs
ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS flow_id UUID REFERENCES test_flows(id) ON DELETE SET NULL;

-- Add plan_id for plan-based runs
ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES regression_plans(id) ON DELETE SET NULL;

-- Add schedule_id for scheduled runs
ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES test_schedules(id) ON DELETE SET NULL;

-- ============================================================================
-- 6. NEW INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_saved_test_cases_flow
  ON saved_test_cases(flow_id) WHERE flow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_saved_test_cases_tags
  ON saved_test_cases USING GIN(tags);

CREATE INDEX IF NOT EXISTS idx_saved_test_cases_priority
  ON saved_test_cases(priority) WHERE priority IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intent_test_cases_flow
  ON intent_test_cases(flow_id) WHERE flow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intent_test_cases_tags
  ON intent_test_cases USING GIN(tags);

CREATE INDEX IF NOT EXISTS idx_api_test_configs_flow
  ON api_test_configs(flow_id) WHERE flow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_test_configs_tags
  ON api_test_configs USING GIN(tags);

CREATE INDEX IF NOT EXISTS idx_regression_suites_module
  ON regression_suites(module_id) WHERE module_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_regression_suites_tags
  ON regression_suites USING GIN(tags);

CREATE INDEX IF NOT EXISTS idx_regression_runs_module
  ON regression_runs(module_id) WHERE module_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_regression_runs_flow
  ON regression_runs(flow_id) WHERE flow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_regression_runs_plan
  ON regression_runs(plan_id) WHERE plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_regression_runs_schedule
  ON regression_runs(schedule_id) WHERE schedule_id IS NOT NULL;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN regression_suites.module_id IS 'Parent module for this suite';
COMMENT ON COLUMN regression_suites.suite_type IS 'Type of suite: ui, api, or mixed';
COMMENT ON COLUMN saved_test_cases.flow_id IS 'Parent flow for this test case';
COMMENT ON COLUMN saved_test_cases.depends_on IS 'Array of test case IDs this case depends on';
COMMENT ON COLUMN regression_runs.plan_id IS 'Regression plan used for this run';
COMMENT ON COLUMN regression_runs.schedule_id IS 'Schedule that triggered this run';
