-- ============================================================================
-- WORKSPACE MEMORY TABLE (Persistent Agent Memory)
-- ============================================================================
-- Stores semantic memory for workspaces with vector search capabilities
-- Inspired by OpenClaw's persistent memory architecture
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspace_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Workspace this memory belongs to
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- User who created this memory (for audit)
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Memory category for filtering
  category VARCHAR(50) NOT NULL CHECK (category IN (
    'fact',              -- General facts about the workspace/project
    'preference',        -- User preferences and settings
    'test_pattern',      -- Common test patterns and scenarios
    'bug_pattern',       -- Recurring bug patterns
    'integration_context' -- Context about integrations (Jira, GitHub, etc.)
  )),

  -- Unique key for this memory (e.g., 'jira_default_project', 'preferred_browser')
  -- Allows upsert by key
  key VARCHAR(255) NOT NULL,

  -- The actual memory content (text)
  content TEXT NOT NULL,

  -- Vector embedding for semantic search (OpenAI text-embedding-3-small: 1536 dimensions)
  embedding vector(1536),

  -- Source of this memory
  source VARCHAR(50) NOT NULL DEFAULT 'agent_written' CHECK (source IN (
    'agent_written',   -- Agent explicitly remembered this
    'auto_extracted',  -- Auto-extracted from conversation
    'user_provided'    -- User explicitly provided this info
  )),

  -- Confidence score (0.0-1.0) for auto-extracted memories
  confidence FLOAT DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),

  -- Usage tracking (for LRU eviction if needed)
  access_count INTEGER DEFAULT 0,
  last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Metadata (JSON)
  metadata JSONB DEFAULT '{}'::JSONB,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Optional expiration
  expires_at TIMESTAMP WITH TIME ZONE,

  -- Unique constraint: one memory per workspace+key
  CONSTRAINT unique_workspace_key UNIQUE (workspace_id, key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_workspace_memory_workspace_id
  ON workspace_memory(workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_category
  ON workspace_memory(category);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_user_id
  ON workspace_memory(user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_expires_at
  ON workspace_memory(expires_at)
  WHERE expires_at IS NOT NULL;

-- HNSW vector index for fast semantic search
-- Using HNSW (Hierarchical Navigable Small World) for better performance
-- m=16: number of connections per layer (higher = better recall, more memory)
-- ef_construction=64: controls index construction (higher = better quality, slower build)
CREATE INDEX IF NOT EXISTS idx_workspace_memory_embedding
  ON workspace_memory
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================================
-- RPC FUNCTION: search_workspace_memory
-- ============================================================================
-- Semantic search for relevant memories using vector similarity
-- ============================================================================

CREATE OR REPLACE FUNCTION search_workspace_memory(
  p_workspace_id UUID,
  p_query_embedding vector(1536),
  p_match_count INT DEFAULT 5,
  p_match_threshold FLOAT DEFAULT 0.5,
  p_category VARCHAR DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  workspace_id UUID,
  user_id UUID,
  category VARCHAR,
  key VARCHAR,
  content TEXT,
  source VARCHAR,
  confidence FLOAT,
  access_count INTEGER,
  last_accessed_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    wm.id,
    wm.workspace_id,
    wm.user_id,
    wm.category,
    wm.key,
    wm.content,
    wm.source,
    wm.confidence,
    wm.access_count,
    wm.last_accessed_at,
    wm.metadata,
    wm.created_at,
    wm.updated_at,
    wm.expires_at,
    (1 - (wm.embedding <=> p_query_embedding)) AS similarity
  FROM workspace_memory wm
  WHERE
    wm.workspace_id = p_workspace_id
    AND (wm.expires_at IS NULL OR wm.expires_at > NOW())
    AND (p_category IS NULL OR wm.category = p_category)
    AND (1 - (wm.embedding <=> p_query_embedding)) >= p_match_threshold
  ORDER BY wm.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

-- Enable RLS
ALTER TABLE workspace_memory ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read memories from their workspaces
CREATE POLICY workspace_memory_select_policy ON workspace_memory
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT w.id FROM workspaces w
      WHERE w.user_id = auth.uid()::TEXT
    )
  );

-- Policy: Users can insert memories into their workspaces
CREATE POLICY workspace_memory_insert_policy ON workspace_memory
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT w.id FROM workspaces w
      WHERE w.user_id = auth.uid()::TEXT
    )
  );

-- Policy: Users can update memories in their workspaces
CREATE POLICY workspace_memory_update_policy ON workspace_memory
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT w.id FROM workspaces w
      WHERE w.user_id = auth.uid()::TEXT
    )
  );

-- Policy: Users can delete memories from their workspaces
CREATE POLICY workspace_memory_delete_policy ON workspace_memory
  FOR DELETE
  USING (
    workspace_id IN (
      SELECT w.id FROM workspaces w
      WHERE w.user_id = auth.uid()::TEXT
    )
  );

-- Policy: Service role can do anything (for backend operations)
CREATE POLICY workspace_memory_service_role_policy ON workspace_memory
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- TRIGGER: update workspace_memory updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_workspace_memory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_workspace_memory_updated_at ON workspace_memory;
CREATE TRIGGER update_workspace_memory_updated_at
  BEFORE UPDATE ON workspace_memory
  FOR EACH ROW
  EXECUTE FUNCTION update_workspace_memory_updated_at();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE workspace_memory IS 'Persistent semantic memory for workspace agents';
COMMENT ON COLUMN workspace_memory.key IS 'Unique key for upsert operations (e.g., jira_default_project)';
COMMENT ON COLUMN workspace_memory.embedding IS 'Vector embedding for semantic search (1536 dims, OpenAI text-embedding-3-small)';
COMMENT ON COLUMN workspace_memory.category IS 'Memory category for filtering (fact, preference, test_pattern, bug_pattern, integration_context)';
COMMENT ON COLUMN workspace_memory.source IS 'How this memory was created (agent_written, auto_extracted, user_provided)';
COMMENT ON COLUMN workspace_memory.confidence IS 'Confidence score for auto-extracted memories (0.0-1.0)';
COMMENT ON FUNCTION search_workspace_memory IS 'Semantic search for workspace memories using vector similarity';
