-- ═══════════════════════════════════════════════════════════════════════════
-- Multi-Chat Sessions: Allow multiple chat sessions per user per workspace
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Previously: UNIQUE(user_id, workspace_id) enforced 1 session per user per workspace.
-- Now: Users can create multiple sessions (like "New Chat" in ChatGPT).
-- Old sessions are preserved and accessible via GET /sessions list endpoint.
--
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Drop the single-session constraint
ALTER TABLE chat_sessions
  DROP CONSTRAINT IF EXISTS uq_chat_sessions_user_workspace;

-- 2. Drop the old index (was created alongside the constraint)
DROP INDEX IF EXISTS idx_chat_sessions_user_workspace;

-- 3. Add optimized index for "most recent session" lookups
--    Used by getOrCreateWorkspaceChat() and listUserChatSessions()
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_workspace_recent
  ON chat_sessions(user_id, workspace_id, updated_at DESC);
