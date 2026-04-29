-- ============================================================================
-- TEST CASE CHAT — Per-test-case isolated chat context
-- ============================================================================
-- Each (user_id, test_case_id) gets its own chat session.
-- Lazy creation: row is created only on first user message via POST /chat.
-- Hard cascade delete from intent_test_cases removes session + messages +
-- embeddings + summaries + feedback in one transaction.
--
-- Mirrors the global chat schema 1:1 (chat_sessions / chat_messages /
-- chat_message_embeddings / chat_summaries / message_feedback) so that the
-- ChatStore layer in code can swap table names without behavioral drift.
-- ============================================================================

-- pgvector is required by chat_message_embeddings; no-op if already enabled.
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- 1. Sessions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test_case_chat_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- intent_test_cases.user_id is TEXT but its PK is UUID — we FK to PK.
    test_case_id    UUID NOT NULL REFERENCES intent_test_cases(id) ON DELETE CASCADE,
    title           TEXT NOT NULL DEFAULT 'New Chat',
    context         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One chat per (user, test case). Enables ON CONFLICT upsert and
    -- guarantees lazy-create idempotency under concurrent first-message races.
    CONSTRAINT test_case_chat_sessions_user_tc_unique UNIQUE (user_id, test_case_id)
);

CREATE INDEX IF NOT EXISTS idx_tcc_sessions_user_updated
    ON test_case_chat_sessions (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tcc_sessions_testcase_updated
    ON test_case_chat_sessions (test_case_id, updated_at DESC);

-- ----------------------------------------------------------------------------
-- 2. Messages
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test_case_chat_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES test_case_chat_sessions(id) ON DELETE CASCADE,
    role            chat_role NOT NULL,                  -- reuse existing enum: 'user' | 'ai' (defined in supabase-schema.sql:19)
    content         TEXT NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {testId?, testType?, testResult?, hasDraftSteps?, ...}
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DESC index for "load last N messages" hot path.
CREATE INDEX IF NOT EXISTS idx_tcc_messages_session_created_desc
    ON test_case_chat_messages (session_id, created_at DESC);

-- ASC index for chronological pagination from the frontend.
CREATE INDEX IF NOT EXISTS idx_tcc_messages_session_created_asc
    ON test_case_chat_messages (session_id, created_at ASC);

-- ----------------------------------------------------------------------------
-- 3. Trigger: bump session.updated_at on any message insert
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tcc_bump_session_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE test_case_chat_sessions
       SET updated_at = NEW.created_at
     WHERE id = NEW.session_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tcc_messages_bump_session ON test_case_chat_messages;
CREATE TRIGGER trg_tcc_messages_bump_session
AFTER INSERT ON test_case_chat_messages
FOR EACH ROW EXECUTE FUNCTION tcc_bump_session_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Message embeddings (pgvector, mirrors chat_message_embeddings)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test_case_chat_message_embeddings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES test_case_chat_sessions(id) ON DELETE CASCADE,
    message_id      UUID NOT NULL REFERENCES test_case_chat_messages(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,                       -- denormalized for retrieval
    content         TEXT NOT NULL,                       -- denormalized for retrieval
    embedding       VECTOR(1536) NOT NULL,               -- text-embedding-3-small
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT tcc_embeddings_message_unique UNIQUE (message_id)  -- 1 embedding per message
);

CREATE INDEX IF NOT EXISTS idx_tcc_embeddings_session
    ON test_case_chat_message_embeddings (session_id, created_at DESC);

-- IVF-Flat index for cosine similarity search; lists=100 matches existing chat embeddings.
-- ANALYZE is required after population for the planner; keep it as a follow-up step.
CREATE INDEX IF NOT EXISTS idx_tcc_embeddings_vector
    ON test_case_chat_message_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- ----------------------------------------------------------------------------
-- 5. Summaries (mirrors chat_summaries)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test_case_chat_summaries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          UUID NOT NULL REFERENCES test_case_chat_sessions(id) ON DELETE CASCADE,
    summary             TEXT NOT NULL,
    messages_summarized INT NOT NULL,
    oldest_message_at   TIMESTAMPTZ NOT NULL,
    newest_message_at   TIMESTAMPTZ NOT NULL,
    token_count         INT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tcc_summaries_session_newest
    ON test_case_chat_summaries (session_id, newest_message_at DESC);

-- ----------------------------------------------------------------------------
-- 6. Feedback (mirrors message_feedback, scoped to test-case messages)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test_case_message_feedback (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      UUID NOT NULL REFERENCES test_case_chat_messages(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id      UUID NOT NULL REFERENCES test_case_chat_sessions(id) ON DELETE CASCADE,
    feedback_type   feedback_type NOT NULL,              -- reuse existing enum
    intent_type     TEXT,
    context         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One feedback row per (message, user). Re-submitting overwrites via upsert.
    CONSTRAINT tcc_feedback_message_user_unique UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tcc_feedback_session
    ON test_case_message_feedback (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tcc_feedback_user
    ON test_case_message_feedback (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tcc_feedback_intent_type
    ON test_case_message_feedback (intent_type)
    WHERE intent_type IS NOT NULL;

-- ============================================================================
-- ROW-LEVEL SECURITY
-- ============================================================================
-- Strategy: every table is keyed (directly or transitively) to user_id. We
-- enforce `user_id = auth.uid()` so a user can never read or mutate another
-- user's test-case chat — even if they guess the UUID. Workspace-membership
-- checks happen in the application layer (requireTestCaseAccess middleware)
-- because RLS does not have cheap access to workspace_members joins.
-- ----------------------------------------------------------------------------

ALTER TABLE test_case_chat_sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_case_chat_messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_case_chat_message_embeddings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_case_chat_summaries            ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_case_message_feedback          ENABLE ROW LEVEL SECURITY;

-- Sessions: direct user_id check.
DROP POLICY IF EXISTS tcc_sessions_owner_all ON test_case_chat_sessions;
CREATE POLICY tcc_sessions_owner_all ON test_case_chat_sessions
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Messages: indirect via session.
DROP POLICY IF EXISTS tcc_messages_owner_all ON test_case_chat_messages;
CREATE POLICY tcc_messages_owner_all ON test_case_chat_messages
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM test_case_chat_sessions s
             WHERE s.id = test_case_chat_messages.session_id
               AND s.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM test_case_chat_sessions s
             WHERE s.id = test_case_chat_messages.session_id
               AND s.user_id = auth.uid()
        )
    );

-- Embeddings: indirect via session.
DROP POLICY IF EXISTS tcc_embeddings_owner_all ON test_case_chat_message_embeddings;
CREATE POLICY tcc_embeddings_owner_all ON test_case_chat_message_embeddings
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM test_case_chat_sessions s
             WHERE s.id = test_case_chat_message_embeddings.session_id
               AND s.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM test_case_chat_sessions s
             WHERE s.id = test_case_chat_message_embeddings.session_id
               AND s.user_id = auth.uid()
        )
    );

-- Summaries: indirect via session.
DROP POLICY IF EXISTS tcc_summaries_owner_all ON test_case_chat_summaries;
CREATE POLICY tcc_summaries_owner_all ON test_case_chat_summaries
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM test_case_chat_sessions s
             WHERE s.id = test_case_chat_summaries.session_id
               AND s.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM test_case_chat_sessions s
             WHERE s.id = test_case_chat_summaries.session_id
               AND s.user_id = auth.uid()
        )
    );

-- Feedback: direct user_id check (matches message_feedback policy).
DROP POLICY IF EXISTS tcc_feedback_owner_all ON test_case_message_feedback;
CREATE POLICY tcc_feedback_owner_all ON test_case_message_feedback
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- DOCUMENTATION
-- ============================================================================
COMMENT ON TABLE test_case_chat_sessions IS
    'Per-test-case AI chat session. One row per (user, test_case). Lazy-created on first POST /chat with testCaseId. Cascades from intent_test_cases.';

COMMENT ON TABLE test_case_chat_messages IS
    'Messages for test-case chats. Mirrors chat_messages. Trigger bumps session.updated_at on insert.';

COMMENT ON TABLE test_case_chat_message_embeddings IS
    'pgvector embeddings (1536d, text-embedding-3-small) for semantic recall of older messages in test-case chats.';

COMMENT ON TABLE test_case_chat_summaries IS
    'Compressed summaries of older message blocks (>20 messages) for test-case chats.';

COMMENT ON TABLE test_case_message_feedback IS
    'RLHF feedback rows scoped to test-case chat messages. Mirrors message_feedback.';

COMMENT ON CONSTRAINT test_case_chat_sessions_user_tc_unique ON test_case_chat_sessions IS
    'Enforces lazy-create idempotency: ON CONFLICT (user_id, test_case_id) DO NOTHING / UPDATE.';
