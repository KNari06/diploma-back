-- Add workspace_id and project_id columns to api_test_executions
-- Enables analytics queries to include API test data alongside regression test data

ALTER TABLE api_test_executions
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id),
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);

-- Indexes for analytics query performance
CREATE INDEX IF NOT EXISTS idx_api_test_exec_workspace ON api_test_executions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_api_test_exec_project ON api_test_executions(project_id);
CREATE INDEX IF NOT EXISTS idx_api_test_exec_executed_at ON api_test_executions(executed_at);
CREATE INDEX IF NOT EXISTS idx_api_test_exec_success ON api_test_executions(success);

-- Backfill project_id from chat_sessions
UPDATE api_test_executions ate
SET project_id = cs.project_id
FROM chat_sessions cs
WHERE ate.chat_session_id::uuid = cs.id
  AND ate.project_id IS NULL
  AND cs.project_id IS NOT NULL;

-- Backfill workspace_id from projects
UPDATE api_test_executions ate
SET workspace_id = p.workspace_id
FROM projects p
WHERE ate.project_id = p.id
  AND ate.workspace_id IS NULL
  AND p.workspace_id IS NOT NULL;
