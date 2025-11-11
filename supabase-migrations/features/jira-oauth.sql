-- Jira OAuth 2.0 Integration Migration
-- This migration adds support for Jira OAuth 2.0 authentication
--
-- Prerequisites:
-- - users table must exist
-- - update_updated_at_column() function must exist (created in main schema)

-- Jira tokens table (for OAuth 2.0)
CREATE TABLE IF NOT EXISTS jira_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    scope TEXT,
    cloud_id TEXT NOT NULL,
    site_url TEXT,
    token_type TEXT DEFAULT 'Bearer',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, cloud_id)
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_jira_tokens_user_id ON jira_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_jira_tokens_cloud_id ON jira_tokens(cloud_id);

-- Row Level Security (RLS) policies
ALTER TABLE jira_tokens ENABLE ROW LEVEL SECURITY;

-- Jira tokens policies
-- Drop existing policies if they exist (for idempotency)
DROP POLICY IF EXISTS "Users can view own Jira tokens" ON jira_tokens;
DROP POLICY IF EXISTS "Users can create own Jira tokens" ON jira_tokens;
DROP POLICY IF EXISTS "Users can update own Jira tokens" ON jira_tokens;
DROP POLICY IF EXISTS "Users can delete own Jira tokens" ON jira_tokens;

CREATE POLICY "Users can view own Jira tokens" ON jira_tokens
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own Jira tokens" ON jira_tokens
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own Jira tokens" ON jira_tokens
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own Jira tokens" ON jira_tokens
    FOR DELETE USING (auth.uid() = user_id);

-- Trigger for automatic timestamp updates
-- Ensure function exists (created in main schema, but safe to recreate here if needed)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop trigger if exists (for idempotency)
DROP TRIGGER IF EXISTS update_jira_tokens_updated_at ON jira_tokens;

CREATE TRIGGER update_jira_tokens_updated_at BEFORE UPDATE ON jira_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
