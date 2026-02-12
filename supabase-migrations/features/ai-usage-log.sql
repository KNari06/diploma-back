-- AI Usage Log Table
-- Tracks AI token consumption per workspace for billing and analytics.
-- One row per session (test, chat message, etc.) with aggregated usage.

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Attribution
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT,                      -- User who triggered the operation
  test_id UUID,                      -- NULL for non-test operations (chat, plan gen)

  -- Operation context
  operation_type TEXT NOT NULL,       -- 'lite-test', 'pro-test', 'chat', 'test-plan', 'api-test', 'analysis'

  -- Aggregated usage (summed across all AI calls in this session)
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,   -- Calculated from token pricing

  -- Call breakdown (JSONB for flexibility — model-level breakdown)
  -- Structure: [{ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 200, count: 5 }, ...]
  call_breakdown JSONB DEFAULT '[]',
  ai_call_count INTEGER NOT NULL DEFAULT 0,

  -- Timing
  session_duration_ms INTEGER,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for billing queries
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_workspace ON ai_usage_log(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_workspace_date ON ai_usage_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_test ON ai_usage_log(test_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_operation_type ON ai_usage_log(operation_type);

-- Row Level Security (RLS)
ALTER TABLE ai_usage_log ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view usage for their own workspaces
CREATE POLICY "Users can view their workspace AI usage"
  ON ai_usage_log
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT w.id FROM workspaces w
      WHERE w.user_id = auth.uid()::TEXT
    )
  );

-- Policy: Service role can insert usage logs
CREATE POLICY "Service role can insert usage logs"
  ON ai_usage_log
  FOR INSERT
  WITH CHECK (true);

-- Comment
COMMENT ON TABLE ai_usage_log IS 'Tracks AI token consumption per workspace for billing analytics. One row per session (test, chat, etc.) with aggregated usage.';
