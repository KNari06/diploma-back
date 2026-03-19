-- ============================================================================
-- Migration: Add embedding column + vector search RPC to intelligent_test_findings
-- Date: 2026-03-19
-- Description:
--   Enables semantic search on past bug findings so the Jira QA Orchestrator
--   can find similar past bugs by meaning, enriching AI decision-making.
--   Pattern follows search_project_kb (knowledge-base-safe.sql) and
--   search_workspace_memory (20260211_workspace_memory.sql).
-- ============================================================================

-- 1. Add nullable embedding column (existing rows get NULL — invisible to vector search)
ALTER TABLE intelligent_test_findings
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- 2. HNSW index for fast cosine similarity search
-- Parameters match workspace_memory index: m=16, ef_construction=64
CREATE INDEX IF NOT EXISTS idx_findings_embedding
  ON intelligent_test_findings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 3. RPC: search_project_findings
-- Joins findings → sessions to scope by project_id (findings only have session_id).
-- Returns bug findings ranked by cosine similarity to the query embedding.
CREATE OR REPLACE FUNCTION search_project_findings(
  p_project_id UUID,
  p_query_embedding vector(1536),
  p_match_threshold FLOAT DEFAULT 0.5,
  p_match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  session_id UUID,
  finding_type TEXT,
  severity TEXT,
  title TEXT,
  description TEXT,
  ai_confidence DECIMAL,
  status TEXT,
  found_at TIMESTAMP WITH TIME ZONE,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.id,
    f.session_id,
    f.finding_type,
    f.severity,
    f.title,
    f.description,
    f.ai_confidence,
    f.status,
    f.found_at,
    (1 - (f.embedding <=> p_query_embedding))::FLOAT AS similarity
  FROM intelligent_test_findings f
  INNER JOIN intelligent_test_sessions s ON s.id = f.session_id
  WHERE s.project_id = p_project_id
    AND f.embedding IS NOT NULL
    AND f.finding_type = 'bug'
    AND (1 - (f.embedding <=> p_query_embedding)) >= p_match_threshold
  ORDER BY f.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

-- 4. Grant permissions (matches existing RPC patterns)
GRANT EXECUTE ON FUNCTION search_project_findings(UUID, vector, FLOAT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION search_project_findings(UUID, vector, FLOAT, INT) TO service_role;

COMMENT ON FUNCTION search_project_findings IS
  'Semantic search for past bug findings within a project using vector similarity. Used by Jira QA Orchestrator for context enrichment.';
