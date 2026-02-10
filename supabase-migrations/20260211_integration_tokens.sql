-- ============================================================================
-- INTEGRATION TOKENS TABLE (Unified OAuth Tokens)
-- ============================================================================
-- Unified table for storing OAuth tokens for all integration providers
-- Supports: Jira, GitHub, GitLab, Notion, Trello, Slack, etc.
-- ============================================================================

CREATE TABLE IF NOT EXISTS integration_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- User this token belongs to
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Workspace this integration is scoped to (optional - some integrations may be user-level)
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Provider identifier
  provider VARCHAR(50) NOT NULL CHECK (provider IN (
    'jira',
    'github',
    'gitlab',
    'notion',
    'trello',
    'slack',
    'telegram'
  )),

  -- OAuth tokens
  access_token TEXT NOT NULL,
  refresh_token TEXT,

  -- Token expiration
  expires_at TIMESTAMP WITH TIME ZONE,

  -- OAuth scope granted
  scope TEXT,

  -- Token type (usually 'Bearer')
  token_type VARCHAR(50) DEFAULT 'Bearer',

  -- External identifiers (provider-specific)
  external_id TEXT, -- e.g., Jira cloud ID, GitHub user ID, Notion workspace ID
  external_url TEXT, -- e.g., Jira site URL, GitHub repo URL

  -- Provider-specific metadata (JSON)
  metadata JSONB DEFAULT '{}'::JSONB,

  -- Integration enabled/disabled
  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Unique constraint: one token per user+provider+external_id
  -- This allows multiple integrations of same provider (e.g., multiple GitHub repos)
  CONSTRAINT unique_user_provider_external_id UNIQUE (user_id, provider, external_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_integration_tokens_user_id
  ON integration_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_integration_tokens_workspace_id
  ON integration_tokens(workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_integration_tokens_provider
  ON integration_tokens(provider);

CREATE INDEX IF NOT EXISTS idx_integration_tokens_enabled
  ON integration_tokens(enabled)
  WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_integration_tokens_expires_at
  ON integration_tokens(expires_at)
  WHERE expires_at IS NOT NULL;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

-- Enable RLS
ALTER TABLE integration_tokens ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own tokens
CREATE POLICY integration_tokens_select_policy ON integration_tokens
  FOR SELECT
  USING (user_id = auth.uid());

-- Policy: Users can insert their own tokens
CREATE POLICY integration_tokens_insert_policy ON integration_tokens
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Policy: Users can update their own tokens
CREATE POLICY integration_tokens_update_policy ON integration_tokens
  FOR UPDATE
  USING (user_id = auth.uid());

-- Policy: Users can delete their own tokens
CREATE POLICY integration_tokens_delete_policy ON integration_tokens
  FOR DELETE
  USING (user_id = auth.uid());

-- Policy: Service role can do anything (for backend operations like token refresh)
CREATE POLICY integration_tokens_service_role_policy ON integration_tokens
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- TRIGGER: update integration_tokens updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_integration_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_integration_tokens_updated_at ON integration_tokens;
CREATE TRIGGER update_integration_tokens_updated_at
  BEFORE UPDATE ON integration_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_integration_tokens_updated_at();

-- ============================================================================
-- MIGRATION NOTE: Existing jira_tokens table
-- ============================================================================
-- The existing jira_tokens table will continue to work during migration period.
-- Backend will check both tables:
--   1. Try integration_tokens first
--   2. Fall back to jira_tokens if not found
-- This ensures zero-downtime migration.
-- After full migration, jira_tokens can be deprecated.
-- ============================================================================

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE integration_tokens IS 'Unified OAuth tokens for all integration providers';
COMMENT ON COLUMN integration_tokens.provider IS 'Integration provider (jira, github, gitlab, notion, trello, slack, telegram)';
COMMENT ON COLUMN integration_tokens.external_id IS 'Provider-specific external ID (cloud ID, user ID, workspace ID, etc.)';
COMMENT ON COLUMN integration_tokens.external_url IS 'Provider-specific URL (site URL, repo URL, etc.)';
COMMENT ON COLUMN integration_tokens.metadata IS 'Provider-specific metadata (JSON)';
COMMENT ON COLUMN integration_tokens.workspace_id IS 'Optional workspace scoping (some integrations may be user-level)';
