-- Full LLM prompt+completion store for hallucination debugging.
--
-- WHY: ai_usage_log holds aggregates (tokens, cost, pipeline decisions) but NOT
-- the actual prompt/completion text. To debug "the agent hallucinated X" you
-- need the exact input and output of the offending LLM call, correlated to the
-- run. This table holds that — one row per persisted LLM call.
--
-- SENSITIVE BY NATURE. Two hard rules enforced by the application layer:
--   1. prompt_redacted / completion_redacted MUST be passed through
--      redactForPersist() (utils/security/redact-llm-text) before insert —
--      secrets / PII / URL tokens stripped. The column names carry "_redacted"
--      precisely so no future caller stores raw text here by reflex.
--   2. Writes are OPT-IN and OFF by default (env LLM_IO_PERSIST_ENABLED).
--
-- Safeguards in this migration: workspace-scoped RLS, immutable rows (no
-- UPDATE/DELETE policy — purge happens via service role only), TTL via
-- expires_at + a retention job, and a user_id column so account-deletion can
-- purge by user (GDPR right-to-erasure).
--
-- Idempotent: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS ai_call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Attribution / correlation
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT,                       -- REQUIRED for account-deletion purge by user_id
  run_id UUID,                        -- regression_runs.id; NULL for non-run calls
  test_id UUID,                       -- tests.id; NULL when not test-scoped

  -- Call identity
  provider TEXT NOT NULL,             -- 'openai' | 'gemini'
  model TEXT,
  status TEXT NOT NULL,               -- 'succeeded' | 'failed'
  operation_type TEXT,                -- 'analysis' | 'chat' | 'regression' | ...
  call_index INTEGER,                 -- ordinal within a run/session, when known

  -- Payload — REDACTED text only (see redactForPersist). Never raw.
  prompt_redacted TEXT,
  completion_redacted TEXT,
  error_message TEXT,

  -- Metrics
  tokens_in INTEGER,
  tokens_out INTEGER,
  duration_ms INTEGER,

  -- Lifecycle
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- Default 30-day TTL. Retention job (ai-call-logs-retention.job) deletes
  -- rows past expires_at. STORED generated column keeps it tamper-consistent.
  expires_at TIMESTAMP WITH TIME ZONE
    GENERATED ALWAYS AS (created_at + INTERVAL '30 days') STORED
);

-- Indexes: the core query is "all LLM calls for run X", plus retention sweeps.
CREATE INDEX IF NOT EXISTS idx_ai_call_logs_run ON ai_call_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_ai_call_logs_workspace_date ON ai_call_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_call_logs_expires ON ai_call_logs(expires_at);
CREATE INDEX IF NOT EXISTS idx_ai_call_logs_user ON ai_call_logs(user_id);

-- ── Row Level Security ──────────────────────────────────────────────────────
ALTER TABLE ai_call_logs ENABLE ROW LEVEL SECURITY;

-- Read: only within your own workspaces (mirrors ai_usage_log policy).
CREATE POLICY "Users can view their workspace AI call logs"
  ON ai_call_logs
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT w.id FROM workspaces w
      WHERE w.user_id = auth.uid()::TEXT
    )
  );

-- Write: service role only (the app inserts via the service key).
CREATE POLICY "Service role can insert AI call logs"
  ON ai_call_logs
  FOR INSERT
  WITH CHECK (true);

-- No UPDATE / DELETE policies → rows are immutable to clients. Retention and
-- account-deletion run via the service role, which bypasses RLS.

COMMENT ON TABLE ai_call_logs IS
  'Per-call LLM prompt/completion store (REDACTED) for hallucination debugging. Opt-in (LLM_IO_PERSIST_ENABLED), 30-day TTL, workspace-scoped RLS.';
COMMENT ON COLUMN ai_call_logs.prompt_redacted IS
  'LLM input AFTER redactForPersist (secrets/PII/URL-tokens stripped). Never store raw prompt.';
COMMENT ON COLUMN ai_call_logs.completion_redacted IS
  'LLM output AFTER redactForPersist. Never store raw completion.';
