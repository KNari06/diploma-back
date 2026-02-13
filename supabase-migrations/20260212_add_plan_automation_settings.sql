-- ============================================================================
-- PLAN AUTOMATION SETTINGS
-- ============================================================================
-- Adds automation configuration to regression plans:
--   - automation_config JSONB (schedule, git triggers, runtime config)
--   - notifications_enabled flag
--   - schedule_id FK to test_schedules
--   - plan_id FK on git_integrations
-- ============================================================================

-- regression_plans: add automation fields
ALTER TABLE regression_plans
  ADD COLUMN IF NOT EXISTS automation_config JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS schedule_id UUID DEFAULT NULL REFERENCES test_schedules(id) ON DELETE SET NULL;

-- git_integrations: add plan_id to link webhook triggers to plans
ALTER TABLE git_integrations
  ADD COLUMN IF NOT EXISTS plan_id UUID DEFAULT NULL REFERENCES regression_plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_git_integrations_plan_id ON git_integrations(plan_id);
