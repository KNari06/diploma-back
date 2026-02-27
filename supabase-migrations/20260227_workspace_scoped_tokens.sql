-- ═══════════════════════════════════════════════════════════════════════════
-- Workspace-scoped integration tokens
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds a partial unique index so that tokens with a workspace_id are unique
-- per (user_id, workspace_id, provider, external_id).
--
-- The existing unique constraint on (user_id, provider, external_id) is kept
-- for legacy rows where workspace_id IS NULL. New workspace-scoped tokens
-- will be enforced by the partial index below.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_tokens_workspace_scoped
  ON integration_tokens (user_id, workspace_id, provider, external_id)
  WHERE workspace_id IS NOT NULL;
