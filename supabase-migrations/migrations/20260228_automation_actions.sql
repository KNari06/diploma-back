-- ============================================================================
-- AUTOMATION ACTIONS & LOGS
-- ============================================================================
-- Universal post-event automation system.
-- Configurable actions triggered by test/run lifecycle events.
-- Example: "When regression run fails → send Telegram with share link"
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- TABLE: automation_actions
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS automation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  user_id TEXT NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,

  -- Scoping (optional — narrows when the action fires)
  schedule_id UUID REFERENCES test_schedules(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES regression_plans(id) ON DELETE CASCADE,

  -- What triggers this action
  trigger_event TEXT NOT NULL CHECK (trigger_event IN (
    'run_completed',
    'run_failed',
    'run_passed',
    'test_completed',
    'test_failed',
    'schedule_executed'
  )),

  -- What happens when triggered
  action_type TEXT NOT NULL CHECK (action_type IN (
    'telegram_notify',
    'slack_notify',
    'jira_create_issue',
    'webhook_post',
    'generate_share_link'
  )),

  -- Condition filter
  condition TEXT NOT NULL DEFAULT 'always' CHECK (condition IN (
    'always',
    'on_failure',
    'on_success'
  )),

  -- Action-specific configuration (JSONB, flexible)
  -- telegram_notify:    { "chat_id": "...", "include_share_link": true, "template": "..." }
  -- slack_notify:       { "channel_id": "...", "include_share_link": true }
  -- jira_create_issue:  { "project_key": "...", "issue_type": "Bug", "priority": "High" }
  -- webhook_post:       { "url": "...", "headers": {}, "method": "POST" }
  -- generate_share_link:{ "auto": true }
  config JSONB NOT NULL DEFAULT '{}',

  -- Human-readable label
  name TEXT,

  -- Active/inactive toggle
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  -- Priority for ordering (lower = fires first)
  priority INTEGER NOT NULL DEFAULT 100,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- INDEXES: automation_actions
-- ────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_automation_actions_active_trigger
  ON automation_actions(user_id, trigger_event)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_automation_actions_project
  ON automation_actions(project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_actions_schedule
  ON automation_actions(schedule_id)
  WHERE schedule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_actions_plan
  ON automation_actions(plan_id)
  WHERE plan_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- TABLE: automation_action_logs
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS automation_action_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which action fired
  action_id UUID NOT NULL REFERENCES automation_actions(id) ON DELETE CASCADE,

  -- What triggered it
  trigger_event TEXT NOT NULL,
  source_entity_type TEXT NOT NULL CHECK (source_entity_type IN (
    'regression_run', 'test', 'schedule'
  )),
  source_entity_id TEXT NOT NULL,

  -- Execution result
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
  error_message TEXT,
  response_data JSONB,

  -- Deduplication key: prevents same action firing twice for same event
  idempotency_key TEXT NOT NULL,

  -- Duration
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- INDEXES: automation_action_logs
-- ────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_action_logs_action
  ON automation_action_logs(action_id);

CREATE INDEX IF NOT EXISTS idx_action_logs_source
  ON automation_action_logs(source_entity_type, source_entity_id);

-- Deduplication: only one non-failed log per action+entity
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_logs_dedupe
  ON automation_action_logs(idempotency_key)
  WHERE status != 'failed';

-- ────────────────────────────────────────────────────────────────────────────
-- AUTO-UPDATE updated_at
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_automation_actions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_automation_actions_updated_at ON automation_actions;
CREATE TRIGGER trg_automation_actions_updated_at
  BEFORE UPDATE ON automation_actions
  FOR EACH ROW
  EXECUTE FUNCTION update_automation_actions_updated_at();
