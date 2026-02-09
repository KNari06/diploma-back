-- ═══════════════════════════════════════════════════════════════════════════
-- WORKSPACE SINGLE CHAT MIGRATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Restructures chat system: one shared chat session per workspace.
-- All workspace members share the same chat session.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Add author_id to chat_messages (tracks who sent each message)
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES auth.users(id);

-- 2. Backfill author_id from session's user_id for existing user messages
UPDATE chat_messages cm
SET author_id = cs.user_id::uuid
FROM chat_sessions cs
WHERE cm.session_id = cs.id
  AND cm.role = 'user'
  AND cm.author_id IS NULL;

-- 3. Consolidate duplicate sessions per workspace
-- For each workspace with multiple sessions, keep the one with the most messages
-- and re-parent messages from other sessions into it.
DO $$
DECLARE
  ws RECORD;
  winner_id UUID;
  winner_count INT;
BEGIN
  -- Find workspaces with multiple sessions
  FOR ws IN
    SELECT workspace_id, COUNT(*) as session_count
    FROM chat_sessions
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id
    HAVING COUNT(*) > 1
  LOOP
    -- Find the session with the most messages
    SELECT cs.id, COALESCE(msg_count.cnt, 0) as cnt
    INTO winner_id, winner_count
    FROM chat_sessions cs
    LEFT JOIN (
      SELECT session_id, COUNT(*) as cnt
      FROM chat_messages
      GROUP BY session_id
    ) msg_count ON cs.id = msg_count.session_id
    WHERE cs.workspace_id = ws.workspace_id
    ORDER BY COALESCE(msg_count.cnt, 0) DESC, cs.created_at ASC
    LIMIT 1;

    -- Re-parent messages from other sessions to the winner
    UPDATE chat_messages
    SET session_id = winner_id
    WHERE session_id IN (
      SELECT id FROM chat_sessions
      WHERE workspace_id = ws.workspace_id AND id != winner_id
    );

    -- Re-parent embeddings from other sessions to the winner
    UPDATE chat_message_embeddings
    SET session_id = winner_id
    WHERE session_id IN (
      SELECT id FROM chat_sessions
      WHERE workspace_id = ws.workspace_id AND id != winner_id
    );

    -- Delete the duplicate sessions (messages already moved)
    DELETE FROM chat_sessions
    WHERE workspace_id = ws.workspace_id AND id != winner_id;

    RAISE NOTICE 'Consolidated workspace % - kept session % with % messages',
      ws.workspace_id, winner_id, winner_count;
  END LOOP;
END $$;

-- 4. Add unique constraint: one session per workspace
-- This enforces the single-chat-per-workspace model at the DB level
ALTER TABLE chat_sessions
  ADD CONSTRAINT uq_chat_sessions_workspace UNIQUE (workspace_id);

-- 5. Create chat_summaries table for auto-summarization (Agent Memory)
CREATE TABLE IF NOT EXISTS chat_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  messages_summarized INT NOT NULL,
  oldest_message_at TIMESTAMPTZ NOT NULL,
  newest_message_at TIMESTAMPTZ NOT NULL,
  token_count INT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_summaries_session
  ON chat_summaries(session_id, newest_message_at DESC);

-- 6. Add index on author_id for querying messages by author
CREATE INDEX IF NOT EXISTS idx_chat_messages_author
  ON chat_messages(author_id) WHERE author_id IS NOT NULL;
