-- Migration: Create test_chat_mappings table
-- Purpose: Link test executions with chat sessions for result notifications
-- Date: 2024-11-08

-- Create test_chat_mappings table
CREATE TABLE IF NOT EXISTS test_chat_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id UUID NOT NULL,
    chat_session_id UUID NOT NULL,
    user_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_test_chat_mappings_test_id ON test_chat_mappings(test_id);
CREATE INDEX IF NOT EXISTS idx_test_chat_mappings_chat_session_id ON test_chat_mappings(chat_session_id);
CREATE INDEX IF NOT EXISTS idx_test_chat_mappings_user_id ON test_chat_mappings(user_id);
CREATE INDEX IF NOT EXISTS idx_test_chat_mappings_created_at ON test_chat_mappings(created_at);

-- Add unique constraint to prevent duplicate mappings
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_chat_mappings_unique
ON test_chat_mappings(test_id, chat_session_id);

-- Add foreign key constraints (if tables exist)
-- Note: We use soft references since test_id might reference different test tables
-- and chat_session_id references chat_sessions table

-- Add RLS (Row Level Security) policies
ALTER TABLE test_chat_mappings ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own mappings
CREATE POLICY "Users can view own test chat mappings" ON test_chat_mappings
    FOR SELECT USING (user_id = auth.uid()::text OR user_id = current_setting('app.current_user_id', true));

-- Policy: Users can create mappings for their own tests
CREATE POLICY "Users can create own test chat mappings" ON test_chat_mappings
    FOR INSERT WITH CHECK (user_id = auth.uid()::text OR user_id = current_setting('app.current_user_id', true));

-- Policy: Users can delete their own mappings
CREATE POLICY "Users can delete own test chat mappings" ON test_chat_mappings
    FOR DELETE USING (user_id = auth.uid()::text OR user_id = current_setting('app.current_user_id', true));

-- Add comments for documentation
COMMENT ON TABLE test_chat_mappings IS 'Links test executions with chat sessions for automatic result notifications';
COMMENT ON COLUMN test_chat_mappings.id IS 'Unique identifier for the mapping';
COMMENT ON COLUMN test_chat_mappings.test_id IS 'ID of the test being executed';
COMMENT ON COLUMN test_chat_mappings.chat_session_id IS 'ID of the chat session that initiated the test';
COMMENT ON COLUMN test_chat_mappings.user_id IS 'ID of the user who owns both the test and chat session';
COMMENT ON COLUMN test_chat_mappings.created_at IS 'When the mapping was created';
COMMENT ON COLUMN test_chat_mappings.updated_at IS 'When the mapping was last updated';

-- Create function to automatically update updated_at
CREATE OR REPLACE FUNCTION update_test_chat_mappings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for automatic updated_at updates
CREATE TRIGGER trigger_update_test_chat_mappings_updated_at
    BEFORE UPDATE ON test_chat_mappings
    FOR EACH ROW
    EXECUTE FUNCTION update_test_chat_mappings_updated_at();

-- Grant necessary permissions
GRANT SELECT, INSERT, DELETE ON test_chat_mappings TO authenticated;
GRANT SELECT, INSERT, DELETE ON test_chat_mappings TO anon;
