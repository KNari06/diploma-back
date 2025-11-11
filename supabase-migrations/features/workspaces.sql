-- Workspaces migration
-- Adds workspace layer between users and projects
-- Structure: users -> workspaces -> projects -> tests -> test_results
--
-- Prerequisites:
-- - Main schema (supabase-schema.sql) must be applied first
-- - update_updated_at_column() function must exist
-- - users, projects, chat_sessions tables must exist
--
-- Cascade deletion chain:
--   users (deleted) -> workspaces (CASCADE) -> projects (CASCADE) -> tests (CASCADE) -> test_results (CASCADE)
--   workspaces (deleted) -> projects (CASCADE) -> tests (CASCADE) -> test_results (CASCADE)
--   workspaces (deleted) -> chat_sessions (SET NULL) - chats are preserved, only workspace_id is cleared

-- Create workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platforms TEXT[] NOT NULL DEFAULT '{}',
    api_testing BOOLEAN DEFAULT false,
    dev_base_url TEXT,
    prod_base_url TEXT,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add workspace_id to projects table
-- CASCADE: Deleting a workspace will automatically delete all its projects
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

-- Create index for workspace_id in projects
CREATE INDEX IF NOT EXISTS idx_projects_workspace_id ON projects(workspace_id);

-- Create index for user_id in workspaces
CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);

-- Enable RLS on workspaces
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

-- RLS Policies for workspaces
CREATE POLICY "Users can view own workspaces" ON workspaces
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create workspaces" ON workspaces
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own workspaces" ON workspaces
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own workspaces" ON workspaces
    FOR DELETE USING (auth.uid() = user_id);

-- Note: Projects RLS policies will be updated AFTER migration fills workspace_id
-- This prevents blocking access to existing projects during migration

-- Add trigger for updated_at on workspaces
-- Note: update_updated_at_column() function should exist from main schema
-- If it doesn't exist, this will fail - ensure main schema is applied first
DROP TRIGGER IF EXISTS update_workspaces_updated_at ON workspaces;

-- Only create trigger if function exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'update_updated_at_column'
    ) THEN
        CREATE TRIGGER update_workspaces_updated_at BEFORE UPDATE ON workspaces
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    ELSE
        RAISE WARNING 'Function update_updated_at_column() not found. Trigger not created.';
    END IF;
END $$;

-- Migration: Create default workspace for existing users with projects
-- This ensures all existing projects have a workspace
DO $$
DECLARE
    user_record RECORD;
    default_workspace_id UUID;
    system_user_id UUID := '00000000-0000-0000-0000-000000000000';
    system_workspace_id UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
    -- Create default workspace for system/anonymous user if it doesn't exist
    -- Using INSERT ... ON CONFLICT since id is PRIMARY KEY (automatically UNIQUE)
    INSERT INTO workspaces (id, name, user_id, platforms, api_testing, dev_base_url, settings)
    VALUES (
        system_workspace_id,
        'Default Workspace (Anonymous)',
        system_user_id,
        ARRAY['web(chrome, safari, firefox)'],
        false,
        NULL,
        '{}'::jsonb
    )
    ON CONFLICT (id) DO NOTHING;

    -- Update system project to use system workspace if it exists
    UPDATE projects
    SET workspace_id = system_workspace_id
    WHERE user_id = system_user_id
    AND workspace_id IS NULL;

    -- For each real user that has projects but no workspaces
    FOR user_record IN
        SELECT DISTINCT p.user_id
        FROM projects p
        WHERE p.user_id != system_user_id
        AND NOT EXISTS (
            SELECT 1 FROM workspaces w WHERE w.user_id = p.user_id
        )
    LOOP
        -- Create default workspace
        INSERT INTO workspaces (id, name, user_id, platforms, api_testing, dev_base_url, settings)
        VALUES (
            gen_random_uuid(),
            'Default Workspace',
            user_record.user_id,
            ARRAY['web(chrome, safari, firefox)'],
            false,
            NULL,
            '{}'::jsonb
        )
        RETURNING id INTO default_workspace_id;

        -- Update all projects for this user to use the new workspace
        UPDATE projects
        SET workspace_id = default_workspace_id
        WHERE user_id = user_record.user_id
        AND workspace_id IS NULL;
    END LOOP;
END $$;

-- Add workspace_id to chat_sessions table
-- Chat sessions should be linked to workspace for consistency
-- If chat is linked to project, workspace_id should match project's workspace
-- Note: SET NULL instead of CASCADE to preserve chat history when workspace is deleted
ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;

-- Create index for workspace_id in chat_sessions
CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace_id ON chat_sessions(workspace_id);

-- Update chat_sessions RLS policies to check workspace ownership
-- Allow access if workspace_id matches user's workspace OR if workspace_id is NULL (preserved chats)
DROP POLICY IF EXISTS "Users can view own chat sessions" ON chat_sessions;
CREATE POLICY "Users can view own chat sessions" ON chat_sessions
    FOR SELECT USING (
        chat_sessions.user_id = auth.uid() AND (
            chat_sessions.workspace_id IS NULL OR
            EXISTS (
                SELECT 1 FROM workspaces
                WHERE workspaces.id = chat_sessions.workspace_id
                AND workspaces.user_id = auth.uid()
            )
        )
    );

DROP POLICY IF EXISTS "Users can create own chat sessions" ON chat_sessions;
CREATE POLICY "Users can create own chat sessions" ON chat_sessions
    FOR INSERT WITH CHECK (
        chat_sessions.user_id = auth.uid() AND (
            chat_sessions.workspace_id IS NULL OR
            EXISTS (
                SELECT 1 FROM workspaces
                WHERE workspaces.id = chat_sessions.workspace_id
                AND workspaces.user_id = auth.uid()
            )
        )
    );

DROP POLICY IF EXISTS "Users can update own chat sessions" ON chat_sessions;
CREATE POLICY "Users can update own chat sessions" ON chat_sessions
    FOR UPDATE USING (
        chat_sessions.user_id = auth.uid() AND (
            chat_sessions.workspace_id IS NULL OR
            EXISTS (
                SELECT 1 FROM workspaces
                WHERE workspaces.id = chat_sessions.workspace_id
                AND workspaces.user_id = auth.uid()
            )
        )
    );

DROP POLICY IF EXISTS "Users can delete own chat sessions" ON chat_sessions;
CREATE POLICY "Users can delete own chat sessions" ON chat_sessions
    FOR DELETE USING (
        chat_sessions.user_id = auth.uid() AND (
            chat_sessions.workspace_id IS NULL OR
            EXISTS (
                SELECT 1 FROM workspaces
                WHERE workspaces.id = chat_sessions.workspace_id
                AND workspaces.user_id = auth.uid()
            )
        )
    );

-- Migration: Update existing chat_sessions to have workspace_id
-- If chat has project_id, use project's workspace_id
-- Otherwise, use user's default workspace
DO $$
DECLARE
    chat_record RECORD;
    workspace_id_for_chat UUID;
BEGIN
    -- For each chat session without workspace_id
    FOR chat_record IN
        SELECT cs.id, cs.user_id, cs.project_id
        FROM chat_sessions cs
        WHERE cs.workspace_id IS NULL
    LOOP
        IF chat_record.project_id IS NOT NULL THEN
            -- Use project's workspace
            SELECT p.workspace_id INTO workspace_id_for_chat
            FROM projects p
            WHERE p.id = chat_record.project_id;
        END IF;

        -- If no workspace from project, get user's default workspace
        IF workspace_id_for_chat IS NULL THEN
            SELECT w.id INTO workspace_id_for_chat
            FROM workspaces w
            WHERE w.user_id = chat_record.user_id
            ORDER BY w.created_at ASC
            LIMIT 1;
        END IF;

        -- Update chat session with workspace_id
        IF workspace_id_for_chat IS NOT NULL THEN
            UPDATE chat_sessions
            SET workspace_id = workspace_id_for_chat
            WHERE id = chat_record.id;
        END IF;

        workspace_id_for_chat := NULL;
    END LOOP;
END $$;

-- Update projects RLS policies to check workspace ownership
-- This is done AFTER migration to ensure all projects have workspace_id
DROP POLICY IF EXISTS "Users can view own projects" ON projects;
CREATE POLICY "Users can view own projects" ON projects
    FOR SELECT USING (
        projects.workspace_id IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM workspaces
            WHERE workspaces.id = projects.workspace_id
            AND workspaces.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can create projects" ON projects;
CREATE POLICY "Users can create projects" ON projects
    FOR INSERT WITH CHECK (
        projects.workspace_id IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM workspaces
            WHERE workspaces.id = projects.workspace_id
            AND workspaces.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can update own projects" ON projects;
CREATE POLICY "Users can update own projects" ON projects
    FOR UPDATE USING (
        projects.workspace_id IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM workspaces
            WHERE workspaces.id = projects.workspace_id
            AND workspaces.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can delete own projects" ON projects;
CREATE POLICY "Users can delete own projects" ON projects
    FOR DELETE USING (
        projects.workspace_id IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM workspaces
            WHERE workspaces.id = projects.workspace_id
            AND workspaces.user_id = auth.uid()
        )
    );

-- Make workspace_id required for new projects (after migration)
-- Note: We keep it nullable for now to allow migration, but should be NOT NULL in future
-- ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;
