-- ═══════════════════════════════════════════════════════════════════════════
-- PER-USER CHAT SESSIONS MIGRATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Changes chat model from one shared session per workspace to
-- one session per user per workspace. Each workspace member gets their
-- own private chat history while sharing all other workspace resources.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Drop the old unique constraint (one session per workspace)
ALTER TABLE chat_sessions
  DROP CONSTRAINT IF EXISTS uq_chat_sessions_workspace;

-- 2. DATA INTEGRITY: Handle sessions with NULL user_id before adding constraint
-- Assign the workspace owner as user_id for orphaned sessions (NULL user_id)
UPDATE chat_sessions cs
SET user_id = (
  SELECT wm.user_id
  FROM workspace_members wm
  WHERE wm.workspace_id = cs.workspace_id
    AND wm.role = 'owner'
    AND wm.status = 'active'
  LIMIT 1
)
WHERE cs.user_id IS NULL
  AND cs.workspace_id IS NOT NULL;

-- Delete sessions that still have NULL user_id (no workspace or no owner found)
DELETE FROM chat_sessions
WHERE user_id IS NULL;

-- 3. DATA INTEGRITY: Handle duplicate (user_id, workspace_id) pairs
-- Before the migration, workspace had one shared session.
-- If the same user_id appears multiple times for a workspace (shouldn't happen but safe to handle),
-- keep the session with the most messages, discard the rest.
DO $$
DECLARE
  dup RECORD;
  winner_id UUID;
BEGIN
  FOR dup IN
    SELECT user_id, workspace_id, COUNT(*) as cnt
    FROM chat_sessions
    WHERE user_id IS NOT NULL AND workspace_id IS NOT NULL
    GROUP BY user_id, workspace_id
    HAVING COUNT(*) > 1
  LOOP
    -- Keep session with most messages
    SELECT cs.id
    INTO winner_id
    FROM chat_sessions cs
    LEFT JOIN (
      SELECT session_id, COUNT(*) as msg_cnt
      FROM chat_messages
      GROUP BY session_id
    ) msg ON cs.id = msg.session_id
    WHERE cs.user_id = dup.user_id
      AND cs.workspace_id = dup.workspace_id
    ORDER BY COALESCE(msg.msg_cnt, 0) DESC, cs.created_at ASC
    LIMIT 1;

    -- Re-parent messages from losers to winner
    UPDATE chat_messages
    SET session_id = winner_id
    WHERE session_id IN (
      SELECT id FROM chat_sessions
      WHERE user_id = dup.user_id
        AND workspace_id = dup.workspace_id
        AND id != winner_id
    );

    -- Delete loser sessions
    DELETE FROM chat_sessions
    WHERE user_id = dup.user_id
      AND workspace_id = dup.workspace_id
      AND id != winner_id;

    RAISE NOTICE 'Deduped sessions for user % workspace % - kept %',
      dup.user_id, dup.workspace_id, winner_id;
  END LOOP;
END $$;

-- 4. Add new unique constraint (one session per user per workspace)
ALTER TABLE chat_sessions
  ADD CONSTRAINT uq_chat_sessions_user_workspace UNIQUE (user_id, workspace_id);

-- 5. Add index for efficient per-user workspace chat lookups
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_workspace
  ON chat_sessions(user_id, workspace_id);

-- 6. Update RLS policies for chat_sessions: user can only see their own sessions
-- Drop existing policies first
DROP POLICY IF EXISTS "Members can view chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Members can insert chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Members can update chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Members can delete chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Owner/full_access can insert chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Owner/full_access can update chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Owner/full_access can delete chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can view own chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can insert own chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can update own chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can delete own chat sessions" ON chat_sessions;

-- Users can only view their own chat sessions AND must be a workspace member
CREATE POLICY "Users can view own chat sessions" ON chat_sessions
    FOR SELECT USING (
        chat_sessions.user_id::text = auth.uid()::text
        AND (
            chat_sessions.workspace_id IS NULL
            OR public.check_workspace_membership(chat_sessions.workspace_id)
        )
    );

-- Users can insert their own chat sessions (must be workspace member)
CREATE POLICY "Users can insert own chat sessions" ON chat_sessions
    FOR INSERT WITH CHECK (
        chat_sessions.user_id::text = auth.uid()::text
        AND (
            chat_sessions.workspace_id IS NULL
            OR public.check_workspace_membership(chat_sessions.workspace_id)
        )
    );

-- Users can update their own chat sessions
CREATE POLICY "Users can update own chat sessions" ON chat_sessions
    FOR UPDATE USING (
        chat_sessions.user_id::text = auth.uid()::text
        AND (
            chat_sessions.workspace_id IS NULL
            OR public.check_workspace_membership(chat_sessions.workspace_id)
        )
    );

-- Users can delete their own chat sessions
CREATE POLICY "Users can delete own chat sessions" ON chat_sessions
    FOR DELETE USING (
        chat_sessions.user_id::text = auth.uid()::text
    );

-- 7. Update RLS policies for chat_messages: only see messages from own sessions
DROP POLICY IF EXISTS "Users can view own chat messages" ON chat_messages;
DROP POLICY IF EXISTS "Users can insert own chat messages" ON chat_messages;
DROP POLICY IF EXISTS "Members can view chat messages" ON chat_messages;

CREATE POLICY "Users can view own chat messages" ON chat_messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM chat_sessions cs
            WHERE cs.id = chat_messages.session_id
            AND cs.user_id::text = auth.uid()::text
        )
    );

CREATE POLICY "Users can insert own chat messages" ON chat_messages
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM chat_sessions cs
            WHERE cs.id = chat_messages.session_id
            AND cs.user_id::text = auth.uid()::text
        )
    );
