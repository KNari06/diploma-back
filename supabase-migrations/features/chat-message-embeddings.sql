-- ═══════════════════════════════════════════════════════════════════════════
-- CHAT MESSAGE EMBEDDINGS - Vector storage for semantic search in chat history
-- ═══════════════════════════════════════════════════════════════════════════
-- Purpose: Store vector embeddings of old chat messages for efficient retrieval
-- Instead of GPT summarization, we use semantic search on vectors
-- Cost: ~$0.0001 per 1K messages (vs $0.002 for GPT summary)
-- Speed: ~100ms (vs 2-3 sec for GPT summary)
-- ═══════════════════════════════════════════════════════════════════════════

-- Ensure pgvector extension is enabled
-- (Should already be enabled in supabase-schema.sql, but verify)
CREATE EXTENSION IF NOT EXISTS vector;

-- Chat message embeddings table
CREATE TABLE IF NOT EXISTS chat_message_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Links
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,

    -- Content (for display when retrieved)
    role TEXT NOT NULL, -- 'user' or 'ai'
    content TEXT NOT NULL, -- Original message content

    -- Vector (1536 dimensions for text-embedding-3-small)
    embedding VECTOR(1536) NOT NULL,

    -- Metadata
    metadata JSONB DEFAULT '{}', -- Can store: { tokens: 150, intent_type: 'api_test', ... }

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    UNIQUE(message_id) -- One embedding per message
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_chat_embeddings_session_id
    ON chat_message_embeddings(session_id);

CREATE INDEX IF NOT EXISTS idx_chat_embeddings_message_id
    ON chat_message_embeddings(message_id);

CREATE INDEX IF NOT EXISTS idx_chat_embeddings_created_at
    ON chat_message_embeddings(created_at DESC);

-- ⚡ CRITICAL: Vector similarity search index (HNSW for fast approximate search)
-- This enables <=> operator for cosine distance queries
-- Parameters: m=16 (connections per layer), ef_construction=64 (construction quality)
CREATE INDEX IF NOT EXISTS idx_chat_embeddings_vector
    ON chat_message_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Row Level Security
ALTER TABLE chat_message_embeddings ENABLE ROW LEVEL SECURITY;

-- Users can only access embeddings from their own chat sessions
CREATE POLICY "Users can view own chat embeddings"
    ON chat_message_embeddings
    FOR SELECT
    USING (
        session_id IN (
            SELECT id FROM chat_sessions WHERE user_id = auth.uid()::text
        )
    );

-- Service role can do anything (for backend processing)
CREATE POLICY "Service role full access to chat embeddings"
    ON chat_message_embeddings
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ═══════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTION: Semantic search in chat history
-- ═══════════════════════════════════════════════════════════════════════════
-- Usage: SELECT * FROM search_chat_history('session-uuid', '[vector]', 5)
-- Returns: Top 5 most relevant messages by cosine similarity
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION search_chat_history(
    p_session_id UUID,
    p_query_embedding VECTOR(1536),
    p_match_count INTEGER DEFAULT 5,
    p_match_threshold FLOAT DEFAULT 0.5
)
RETURNS TABLE (
    message_id UUID,
    role TEXT,
    content TEXT,
    similarity FLOAT,
    created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        cme.message_id,
        cme.role,
        cme.content,
        1 - (cme.embedding <=> p_query_embedding) AS similarity,
        cme.created_at
    FROM chat_message_embeddings cme
    WHERE cme.session_id = p_session_id
        AND 1 - (cme.embedding <=> p_query_embedding) > p_match_threshold
    ORDER BY cme.embedding <=> p_query_embedding ASC
    LIMIT p_match_count;
END;
$$;

COMMENT ON TABLE chat_message_embeddings IS 'Vector embeddings for chat messages - enables semantic search in chat history';
COMMENT ON COLUMN chat_message_embeddings.embedding IS 'OpenAI text-embedding-3-small vector (1536 dimensions)';
COMMENT ON FUNCTION search_chat_history IS 'Semantic search in chat history using vector similarity (cosine distance)';
