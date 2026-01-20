-- ============================================================================
-- GIT INTEGRATIONS (CRUD only, webhook later)
-- ============================================================================
-- Stores Git provider integration settings per project.
-- This migration only adds storage (no webhook endpoint / processing).
-- ============================================================================

CREATE TABLE IF NOT EXISTS git_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Provider: github | gitlab
  provider VARCHAR(50) NOT NULL CHECK (provider IN ('github', 'gitlab')),

  -- Repository URL (can be normalized by backend)
  repository_url TEXT NOT NULL,

  -- Secret to be used later for webhook validation
  webhook_secret TEXT NOT NULL,

  -- Optional: regression suite to run (used later when webhooks are implemented)
  suite_id UUID REFERENCES regression_suites(id) ON DELETE SET NULL,

  -- Events configured for this integration (used later)
  events TEXT[] NOT NULL DEFAULT ARRAY['pull_request', 'release', 'push']::TEXT[],

  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Ensure one integration per project+repository
  CONSTRAINT unique_project_repository UNIQUE (project_id, repository_url)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_git_integrations_project_id
  ON git_integrations(project_id);

CREATE INDEX IF NOT EXISTS idx_git_integrations_repository_url
  ON git_integrations(repository_url);

CREATE INDEX IF NOT EXISTS idx_git_integrations_enabled
  ON git_integrations(enabled)
  WHERE enabled = TRUE;

-- updated_at trigger (local to this table)
CREATE OR REPLACE FUNCTION update_git_integrations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_git_integrations_updated_at ON git_integrations;
CREATE TRIGGER update_git_integrations_updated_at
  BEFORE UPDATE ON git_integrations
  FOR EACH ROW
  EXECUTE FUNCTION update_git_integrations_updated_at();
