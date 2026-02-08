-- ============================================================================
-- WORKSPACE ORGANIZATION RLS POLICIES UPDATE
-- ============================================================================
-- Updates RLS policies from owner-only (workspaces.user_id = auth.uid())
-- to membership-based access (via workspace_members table)
--
-- Compatible with workspaces.user_id as UUID or TEXT (schema may use TEXT for
-- anonymous/IP; only UUID-shaped user_id is treated as legacy owner).
--
-- Access model:
-- - workspaces: SELECT for all members, INSERT for authenticated, UPDATE for owner/full_access, DELETE for owner
-- - projects: SELECT for all members, INSERT/UPDATE/DELETE for owner/full_access
-- - chat_sessions: SELECT for all members, write for owner/full_access
-- ============================================================================

-- ============================================================================
-- 1. UPDATE WORKSPACES RLS POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own workspaces" ON workspaces;
DROP POLICY IF EXISTS "Users can create workspaces" ON workspaces;
DROP POLICY IF EXISTS "Users can update own workspaces" ON workspaces;
DROP POLICY IF EXISTS "Users can delete own workspaces" ON workspaces;

-- Legacy owner check: safe when user_id is TEXT (e.g. IP); only compare if UUID-shaped
-- (avoids "invalid input syntax for type uuid" on anonymous workspaces)
CREATE OR REPLACE FUNCTION public.workspace_legacy_owner_match(uid_text text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT CASE
        WHEN uid_text ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN uid_text::uuid = auth.uid()
        ELSE false
    END;
$$;

-- Members can view workspaces they belong to
CREATE POLICY "Members can view workspaces" ON workspaces
    FOR SELECT USING (
        public.check_workspace_membership(id)
        OR workspace_legacy_owner_match(user_id::text)
    );

-- Authenticated users can create workspaces (they become owner via trigger)
CREATE POLICY "Authenticated users can create workspaces" ON workspaces
    FOR INSERT WITH CHECK (
        workspace_legacy_owner_match(user_id::text)
    );

-- Owner and full_access can update workspaces
CREATE POLICY "Owner and full_access can update workspaces" ON workspaces
    FOR UPDATE USING (
        public.check_workspace_membership(id, ARRAY['owner', 'full_access'])
        OR workspace_legacy_owner_match(user_id::text)
    );

-- Only owner can delete workspaces
CREATE POLICY "Only owner can delete workspaces" ON workspaces
    FOR DELETE USING (
        public.check_workspace_membership(id, ARRAY['owner'])
        OR workspace_legacy_owner_match(user_id::text)
    );

-- ============================================================================
-- 2. UPDATE PROJECTS RLS POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own projects" ON projects;
DROP POLICY IF EXISTS "Users can create projects" ON projects;
DROP POLICY IF EXISTS "Users can update own projects" ON projects;
DROP POLICY IF EXISTS "Users can delete own projects" ON projects;

-- Members can view projects in workspaces they belong to
CREATE POLICY "Members can view projects" ON projects
    FOR SELECT USING (
        projects.workspace_id IS NOT NULL AND
        public.check_workspace_membership(projects.workspace_id)
    );

-- Owner and full_access can create projects
CREATE POLICY "Owner and full_access can create projects" ON projects
    FOR INSERT WITH CHECK (
        projects.workspace_id IS NOT NULL AND
        public.check_workspace_membership(projects.workspace_id, ARRAY['owner', 'full_access'])
    );

-- Owner and full_access can update projects
CREATE POLICY "Owner and full_access can update projects" ON projects
    FOR UPDATE USING (
        projects.workspace_id IS NOT NULL AND
        public.check_workspace_membership(projects.workspace_id, ARRAY['owner', 'full_access'])
    );

-- Owner and full_access can delete projects
CREATE POLICY "Owner and full_access can delete projects" ON projects
    FOR DELETE USING (
        projects.workspace_id IS NOT NULL AND
        public.check_workspace_membership(projects.workspace_id, ARRAY['owner', 'full_access'])
    );

-- ============================================================================
-- 3. UPDATE CHAT_SESSIONS RLS POLICIES
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can create own chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can update own chat sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can delete own chat sessions" ON chat_sessions;

-- Members can view chat sessions in workspaces they belong to
-- (user_id can be TEXT with UUID or IP; only UUID-shaped compared with auth.uid())
CREATE POLICY "Members can view chat sessions" ON chat_sessions
    FOR SELECT USING (
        workspace_legacy_owner_match(COALESCE(chat_sessions.user_id::text, ''))
        OR (
            chat_sessions.workspace_id IS NOT NULL AND
            public.check_workspace_membership(chat_sessions.workspace_id)
        )
    );

-- Owner and full_access can create chat sessions
CREATE POLICY "Owner and full_access can create chat sessions" ON chat_sessions
    FOR INSERT WITH CHECK (
        workspace_legacy_owner_match(COALESCE(chat_sessions.user_id::text, '')) AND (
            chat_sessions.workspace_id IS NULL OR
            public.check_workspace_membership(chat_sessions.workspace_id, ARRAY['owner', 'full_access'])
        )
    );

-- Owner and full_access can update chat sessions
CREATE POLICY "Owner and full_access can update chat sessions" ON chat_sessions
    FOR UPDATE USING (
        workspace_legacy_owner_match(COALESCE(chat_sessions.user_id::text, ''))
        OR (
            chat_sessions.workspace_id IS NOT NULL AND
            public.check_workspace_membership(chat_sessions.workspace_id, ARRAY['owner', 'full_access'])
        )
    );

-- Owner and full_access can delete chat sessions
CREATE POLICY "Owner and full_access can delete chat sessions" ON chat_sessions
    FOR DELETE USING (
        workspace_legacy_owner_match(COALESCE(chat_sessions.user_id::text, ''))
        OR (
            chat_sessions.workspace_id IS NOT NULL AND
            public.check_workspace_membership(chat_sessions.workspace_id, ARRAY['owner', 'full_access'])
        )
    );

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON POLICY "Members can view workspaces" ON workspaces IS
'B2B org access: Any active member can view workspace. Legacy owner access preserved during migration.';

COMMENT ON POLICY "Owner and full_access can update workspaces" ON workspaces IS
'B2B org access: Owner and full_access roles can update workspace settings.';

COMMENT ON POLICY "Only owner can delete workspaces" ON workspaces IS
'B2B org access: Only owner role can delete workspace.';

COMMENT ON POLICY "Members can view projects" ON projects IS
'B2B org access: Any active member can view projects in workspaces they belong to.';

COMMENT ON POLICY "Owner and full_access can create projects" ON projects IS
'B2B org access: Owner and full_access roles can create projects.';
