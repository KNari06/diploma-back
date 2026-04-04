-- ═══════════════════════════════════════════════════════════════════════════
-- API FLOW SPECS — stores parsed Swagger/OpenAPI specs and AI-generated DAGs
-- for the API Flow Testing feature
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- api_flow_specs table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_flow_specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,

  -- Optional link to existing api_environments for base URL / auth config
  environment_id UUID REFERENCES api_environments(id) ON DELETE SET NULL,

  -- Identity
  name TEXT NOT NULL,                         -- from spec info.title or user-provided
  source_type TEXT NOT NULL CHECK (source_type IN (
    'openapi_url', 'openapi_file', 'postman', 'curl', 'har', 'insomnia', 'graphql', 'raml'
  )),
  source_url TEXT,                            -- swagger URL (if source_type = openapi_url / graphql)
  spec_version TEXT,                          -- "3.0.2" | "2.0" | "1.0" etc.

  -- Full dereferenced spec (for re-analysis without re-fetching)
  raw_spec JSONB NOT NULL DEFAULT '{}',

  -- AI-generated execution DAG
  -- Structure: { nodes, edges, executionOrder, parallelGroups, summary, totalEndpoints, unsupportedEndpoints }
  execution_dag JSONB NOT NULL DEFAULT '{}',

  -- Variable chain config (extracted from DAG, for quick access)
  -- Structure: { "auth_token": { extractFrom: "POST /login", jsonPath: "$.token", ... } }
  variable_chain JSONB NOT NULL DEFAULT '{}',

  -- Stats
  total_endpoints INTEGER NOT NULL DEFAULT 0,
  supported_endpoints INTEGER NOT NULL DEFAULT 0,
  unsupported_endpoints JSONB NOT NULL DEFAULT '[]',

  -- Execution config
  error_strategy TEXT NOT NULL DEFAULT 'stop_on_failure' CHECK (
    error_strategy IN ('stop_on_failure', 'continue_on_failure', 'retry_then_skip')
  ),

  -- Last run info (denormalized for quick list view)
  last_run_id UUID,
  last_run_status TEXT CHECK (last_run_status IN (
    'pending', 'running', 'completed', 'failed', 'cancelled'
  )),
  last_run_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- api_flow_runs table — tracks individual run executions of a flow spec
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_spec_id UUID NOT NULL REFERENCES api_flow_specs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'completed', 'failed', 'cancelled'
  )),

  -- Full run summary (step results, timing, variable resolution stats)
  -- Structure: { total, passed, failed, skipped, totalDurationMs, variablesResolved, stepResults[] }
  summary JSONB,

  -- Used to route WebSocket events to the correct client
  chat_session_id TEXT,

  -- Execution config used for this run (snapshot at run time)
  config JSONB NOT NULL DEFAULT '{}',

  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Extend api_test_executions to link back to flow
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE api_test_executions
  ADD COLUMN IF NOT EXISTS flow_spec_id UUID REFERENCES api_flow_specs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS flow_run_id UUID REFERENCES api_flow_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS flow_step_index INTEGER;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_api_flow_specs_user_id ON api_flow_specs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_flow_specs_project_id ON api_flow_specs(project_id);
CREATE INDEX IF NOT EXISTS idx_api_flow_specs_project_user ON api_flow_specs(project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_api_flow_specs_updated_at ON api_flow_specs(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_flow_runs_flow_spec_id ON api_flow_runs(flow_spec_id);
CREATE INDEX IF NOT EXISTS idx_api_flow_runs_user_id ON api_flow_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_flow_runs_status ON api_flow_runs(status);
CREATE INDEX IF NOT EXISTS idx_api_flow_runs_started_at ON api_flow_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_test_executions_flow_run_id ON api_test_executions(flow_run_id);
CREATE INDEX IF NOT EXISTS idx_api_test_executions_flow_spec_id ON api_test_executions(flow_spec_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-update updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_api_flow_specs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_api_flow_specs_updated_at
  BEFORE UPDATE ON api_flow_specs
  FOR EACH ROW EXECUTE FUNCTION update_api_flow_specs_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS (Row Level Security)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE api_flow_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_flow_runs ENABLE ROW LEVEL SECURITY;

-- Users can only access their own flow specs
CREATE POLICY "Users can view own flow specs"
  ON api_flow_specs FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can insert own flow specs"
  ON api_flow_specs FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can update own flow specs"
  ON api_flow_specs FOR UPDATE
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can delete own flow specs"
  ON api_flow_specs FOR DELETE
  USING (user_id = auth.uid()::text);

-- Users can only access their own flow runs
CREATE POLICY "Users can view own flow runs"
  ON api_flow_runs FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can insert own flow runs"
  ON api_flow_runs FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can update own flow runs"
  ON api_flow_runs FOR UPDATE
  USING (user_id = auth.uid()::text);
