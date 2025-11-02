-- ========================================
-- Knowledge Base Migration for RAG System
-- ========================================
--
-- Purpose: Creates tables for global (admin) and project-specific (user) knowledge bases
-- Dependencies: users, projects tables (from main schema)
-- Supabase Version: PostgreSQL 15+
--
-- BEFORE RUNNING:
-- 1. Ensure main schema (supabase-schema.sql) is applied
-- 2. Verify vector extension is enabled
-- 3. Check that users table has 'role' column with 'admin' value support
--
-- ========================================

-- Verify vector extension (should already exist from main schema)
CREATE EXTENSION IF NOT EXISTS vector;

-- ========================================
-- TABLES
-- ========================================

-- Global Knowledge Base (Admin only)
-- Stores universal QA knowledge: Playwright guides, API testing best practices, etc.
CREATE TABLE IF NOT EXISTS global_kb_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding VECTOR(1536), -- text-embedding-3-small (1536 dims, HNSW-compatible)
  source_file TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}', -- { chunk_index, total_chunks, section_title, file_type, etc }
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Project Knowledge Base (User-specific per project)
-- Stores project-specific knowledge: API specs, custom guides, technical requirements
CREATE TABLE IF NOT EXISTS project_kb_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536), -- text-embedding-3-small (1536 dims, HNSW-compatible)
  metadata JSONB DEFAULT '{}', -- { chunk_index, total_chunks, file_type, section_title, etc }
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ========================================
-- INDEXES
-- ========================================

-- Global KB indexes
CREATE INDEX IF NOT EXISTS idx_global_kb_source_file ON global_kb_chunks(source_file);
CREATE INDEX IF NOT EXISTS idx_global_kb_tags ON global_kb_chunks USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_global_kb_created_at ON global_kb_chunks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_global_kb_uploaded_by ON global_kb_chunks(uploaded_by);

-- Project KB indexes
CREATE INDEX IF NOT EXISTS idx_project_kb_project_id ON project_kb_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_project_kb_file_name ON project_kb_chunks(file_name);
CREATE INDEX IF NOT EXISTS idx_project_kb_uploaded_by ON project_kb_chunks(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_project_kb_created_at ON project_kb_chunks(created_at DESC);

-- Vector similarity search indexes (HNSW for fast ANN search)
-- These may take time to build on large datasets
CREATE INDEX IF NOT EXISTS idx_global_kb_embedding ON global_kb_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_project_kb_embedding ON project_kb_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ========================================
-- ROW LEVEL SECURITY
-- ========================================

ALTER TABLE global_kb_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_kb_chunks ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for re-running migration)
DROP POLICY IF EXISTS "Everyone can view global KB" ON global_kb_chunks;
DROP POLICY IF EXISTS "Only admins can insert global KB" ON global_kb_chunks;
DROP POLICY IF EXISTS "Only admins can update global KB" ON global_kb_chunks;
DROP POLICY IF EXISTS "Only admins can delete global KB" ON global_kb_chunks;

DROP POLICY IF EXISTS "Users can view own project KB" ON project_kb_chunks;
DROP POLICY IF EXISTS "Users can insert into own project KB" ON project_kb_chunks;
DROP POLICY IF EXISTS "Users can update own project KB" ON project_kb_chunks;
DROP POLICY IF EXISTS "Users can delete own project KB" ON project_kb_chunks;

-- Global KB policies: Only admins can manage, everyone (authenticated) can read
CREATE POLICY "Everyone can view global KB" ON global_kb_chunks
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Only admins can insert global KB" ON global_kb_chunks
    FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM users
            WHERE users.id = auth.uid()
            AND users.role = 'admin'
        )
    );

CREATE POLICY "Only admins can update global KB" ON global_kb_chunks
    FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users
            WHERE users.id = auth.uid()
            AND users.role = 'admin'
        )
    );

CREATE POLICY "Only admins can delete global KB" ON global_kb_chunks
    FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users
            WHERE users.id = auth.uid()
            AND users.role = 'admin'
        )
    );

-- Project KB policies: Users can only access their own project KB
CREATE POLICY "Users can view own project KB" ON project_kb_chunks
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = project_kb_chunks.project_id
            AND projects.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert into own project KB" ON project_kb_chunks
    FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = project_kb_chunks.project_id
            AND projects.user_id = auth.uid()
        )
        AND auth.uid() = uploaded_by
    );

CREATE POLICY "Users can update own project KB" ON project_kb_chunks
    FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = project_kb_chunks.project_id
            AND projects.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can delete own project KB" ON project_kb_chunks
    FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = project_kb_chunks.project_id
            AND projects.user_id = auth.uid()
        )
    );

-- ========================================
-- FUNCTIONS
-- ========================================

-- Function to search global KB by vector similarity
CREATE OR REPLACE FUNCTION search_global_kb(
    query_embedding VECTOR(1536),
    match_threshold FLOAT DEFAULT 0.7,
    match_count INT DEFAULT 5
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    source_file TEXT,
    tags TEXT[],
    metadata JSONB,
    similarity FLOAT
)
SECURITY DEFINER -- Run with function owner's permissions
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        global_kb_chunks.id,
        global_kb_chunks.content,
        global_kb_chunks.source_file,
        global_kb_chunks.tags,
        global_kb_chunks.metadata,
        1 - (global_kb_chunks.embedding <=> query_embedding) AS similarity
    FROM global_kb_chunks
    WHERE global_kb_chunks.embedding IS NOT NULL
    AND 1 - (global_kb_chunks.embedding <=> query_embedding) > match_threshold
    ORDER BY global_kb_chunks.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Function to search project KB by vector similarity
CREATE OR REPLACE FUNCTION search_project_kb(
    p_project_id UUID,
    query_embedding VECTOR(1536),
    match_threshold FLOAT DEFAULT 0.7,
    match_count INT DEFAULT 5
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    file_name TEXT,
    metadata JSONB,
    similarity FLOAT
)
SECURITY DEFINER -- Run with function owner's permissions
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        project_kb_chunks.id,
        project_kb_chunks.content,
        project_kb_chunks.file_name,
        project_kb_chunks.metadata,
        1 - (project_kb_chunks.embedding <=> query_embedding) AS similarity
    FROM project_kb_chunks
    WHERE project_kb_chunks.project_id = p_project_id
    AND project_kb_chunks.embedding IS NOT NULL
    AND 1 - (project_kb_chunks.embedding <=> query_embedding) > match_threshold
    ORDER BY project_kb_chunks.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Function to get KB statistics
CREATE OR REPLACE FUNCTION get_kb_stats(p_project_id UUID DEFAULT NULL)
RETURNS JSON
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    stats JSON;
BEGIN
    IF p_project_id IS NULL THEN
        -- Global stats only
        SELECT json_build_object(
            'globalChunkCount', (SELECT COUNT(*) FROM global_kb_chunks),
            'globalFileCount', (SELECT COUNT(DISTINCT source_file) FROM global_kb_chunks),
            'projectChunkCount', 0,
            'projectFileCount', 0
        ) INTO stats;
    ELSE
        -- Combined stats
        SELECT json_build_object(
            'globalChunkCount', (SELECT COUNT(*) FROM global_kb_chunks),
            'globalFileCount', (SELECT COUNT(DISTINCT source_file) FROM global_kb_chunks),
            'projectChunkCount', (SELECT COUNT(*) FROM project_kb_chunks WHERE project_id = p_project_id),
            'projectFileCount', (SELECT COUNT(DISTINCT file_name) FROM project_kb_chunks WHERE project_id = p_project_id)
        ) INTO stats;
    END IF;

    RETURN stats;
END;
$$;

-- ========================================
-- PERMISSIONS
-- ========================================

-- Grant permissions to authenticated users
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON global_kb_chunks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_kb_chunks TO authenticated;
GRANT EXECUTE ON FUNCTION search_global_kb TO authenticated;
GRANT EXECUTE ON FUNCTION search_project_kb TO authenticated;
GRANT EXECUTE ON FUNCTION get_kb_stats TO authenticated;

-- Grant permissions to service_role (for backend operations)
GRANT ALL ON global_kb_chunks TO service_role;
GRANT ALL ON project_kb_chunks TO service_role;
GRANT EXECUTE ON FUNCTION search_global_kb TO service_role;
GRANT EXECUTE ON FUNCTION search_project_kb TO service_role;
GRANT EXECUTE ON FUNCTION get_kb_stats TO service_role;

-- ========================================
-- VERIFICATION QUERIES (for testing)
-- ========================================

-- Run these queries after migration to verify setup:
--
-- 1. Check tables exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name LIKE '%kb_chunks%';
--
-- 2. Check indexes:
-- SELECT indexname FROM pg_indexes
-- WHERE tablename IN ('global_kb_chunks', 'project_kb_chunks');
--
-- 3. Check RLS is enabled:
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE schemaname = 'public' AND tablename LIKE '%kb_chunks%';
--
-- 4. Test vector extension:
-- SELECT '[1,2,3]'::vector(3);
--
-- ========================================
