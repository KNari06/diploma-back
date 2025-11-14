-- ═══════════════════════════════════════════════════════════════════════════
-- MULTI-CHAT SESSIONS - Support for multiple chat sessions per user
-- ═══════════════════════════════════════════════════════════════════════════
-- Purpose: Enable users to create multiple isolated chat sessions (like ChatGPT)
-- Changes:
--   1. Add updated_at column to chat_sessions
--   2. Create trigger to auto-update updated_at on new messages
--   3. Add indexes for better performance
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Add updated_at column to chat_sessions (if not exists)
ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 2. Initialize updated_at for existing sessions (set to created_at)
UPDATE chat_sessions
SET updated_at = created_at
WHERE updated_at IS NULL;

-- 3. Create function to update session timestamp when new message arrives
CREATE OR REPLACE FUNCTION update_chat_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE chat_sessions
  SET updated_at = NOW()
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Create trigger to automatically update session timestamp
DROP TRIGGER IF EXISTS chat_message_updates_session ON chat_messages;
CREATE TRIGGER chat_message_updates_session
AFTER INSERT ON chat_messages
FOR EACH ROW
EXECUTE FUNCTION update_chat_session_timestamp();

-- 5. Create indexes for better performance on multi-session queries
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
  ON chat_sessions(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_created
  ON chat_sessions(user_id, created_at DESC);

-- 6. Add comment to document the purpose
COMMENT ON COLUMN chat_sessions.updated_at IS
  'Last activity timestamp, automatically updated when new message arrives. Used for sorting sessions by recent activity.';

COMMENT ON TRIGGER chat_message_updates_session ON chat_messages IS
  'Automatically updates chat_sessions.updated_at when new message is inserted';

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (for testing)
-- ═══════════════════════════════════════════════════════════════════════════

-- Check if updated_at column exists
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'chat_sessions' AND column_name = 'updated_at';

-- Check if trigger exists
-- SELECT trigger_name, event_manipulation, action_timing, action_statement
-- FROM information_schema.triggers
-- WHERE trigger_name = 'chat_message_updates_session';

-- Test query: Get user's sessions sorted by recent activity
-- SELECT id, title, created_at, updated_at,
--        (SELECT COUNT(*) FROM chat_messages WHERE session_id = chat_sessions.id) as message_count
-- FROM chat_sessions
-- WHERE user_id = 'YOUR_USER_ID'
-- ORDER BY updated_at DESC
-- LIMIT 20;
