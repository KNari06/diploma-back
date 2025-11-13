-- QAI Database Schema for Supabase
-- This file contains the complete database schema for the QAI platform

-- Note: gen_random_uuid() is built-in PostgreSQL function (available from PostgreSQL 13+)
-- Supabase uses PostgreSQL 15+, so we don't need uuid-ossp extension

-- Enable vector extension for embeddings (RAG)
CREATE EXTENSION IF NOT EXISTS vector;

-- Create custom types
CREATE TYPE test_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled', 'timeout');
CREATE TYPE browser_type AS ENUM ('chrome', 'firefox', 'safari', 'edge', 'mobile-chrome', 'mobile-safari');
CREATE TYPE user_role AS ENUM ('admin', 'user', 'ai');
CREATE TYPE subscription_plan AS ENUM ('free', 'starter', 'professional', 'enterprise');
CREATE TYPE subscription_status AS ENUM ('active', 'cancelled', 'past_due', 'unpaid');
CREATE TYPE credit_transaction_type AS ENUM ('purchase', 'usage', 'refund', 'bonus');
CREATE TYPE bug_severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE bug_category AS ENUM ('visual', 'functional', 'performance', 'accessibility', 'security');
CREATE TYPE chat_role AS ENUM ('user', 'ai');
CREATE TYPE feedback_type AS ENUM ('like', 'dislike');

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    role user_role DEFAULT 'user',
    credits INTEGER DEFAULT 0,
    subscription JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Projects table
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tests table
CREATE TABLE tests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status test_status DEFAULT 'pending',
    browsers browser_type[] NOT NULL,
    options JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Test results table
CREATE TABLE test_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    browser browser_type NOT NULL,
    status test_status DEFAULT 'pending',
    screenshot TEXT, -- base64 encoded or file path
    dom TEXT,
    logs TEXT[] DEFAULT '{}',
    network_logs JSONB DEFAULT '[]',
    errors JSONB DEFAULT '[]',
    performance JSONB,
    ai_summary JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Credit transactions table
CREATE TABLE credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    type credit_transaction_type NOT NULL,
    description TEXT NOT NULL,
    test_id UUID REFERENCES tests(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Webhook events table (for future integrations)
CREATE TABLE webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(100) NOT NULL,
    data JSONB NOT NULL,
    signature TEXT,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chat sessions table
CREATE TABLE chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT,
    context JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chat messages table
CREATE TABLE chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role chat_role NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Message feedback table (for RLHF and AI improvement)
CREATE TABLE message_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    feedback_type feedback_type NOT NULL,
    intent_type TEXT,
    context JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- API test logs table
CREATE TABLE api_test_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    status INTEGER,
    success BOOLEAN,
    duration_ms INTEGER,
    request JSONB DEFAULT '{}',
    response JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- AI embeddings table (for RAG)
CREATE TABLE ai_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT,
    content TEXT,
    embedding VECTOR(1536),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX idx_tests_project_id ON tests(project_id);
CREATE INDEX idx_tests_user_id ON tests(user_id);
CREATE INDEX idx_tests_status ON tests(status);
CREATE INDEX idx_tests_created_at ON tests(created_at DESC);
CREATE INDEX idx_test_results_test_id ON test_results(test_id);
CREATE INDEX idx_test_results_browser ON test_results(browser);
CREATE INDEX idx_test_results_status ON test_results(status);
CREATE INDEX idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX idx_credit_transactions_created_at ON credit_transactions(created_at DESC);
CREATE INDEX idx_webhook_events_processed ON webhook_events(processed);
CREATE INDEX idx_webhook_events_type ON webhook_events(type);
CREATE INDEX idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX idx_chat_sessions_project_id ON chat_sessions(project_id);
CREATE INDEX idx_chat_sessions_created_at ON chat_sessions(created_at DESC);
CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at DESC);
CREATE INDEX idx_message_feedback_message_id ON message_feedback(message_id);
CREATE INDEX idx_message_feedback_user_id ON message_feedback(user_id);
CREATE INDEX idx_message_feedback_session_id ON message_feedback(session_id);
CREATE INDEX idx_message_feedback_feedback_type ON message_feedback(feedback_type);
CREATE INDEX idx_message_feedback_intent_type ON message_feedback(intent_type);
CREATE INDEX idx_message_feedback_created_at ON message_feedback(created_at DESC);
CREATE UNIQUE INDEX idx_message_feedback_unique ON message_feedback(message_id, user_id);
CREATE INDEX idx_api_test_logs_user_id ON api_test_logs(user_id);
CREATE INDEX idx_api_test_logs_created_at ON api_test_logs(created_at DESC);
CREATE INDEX idx_api_test_logs_url ON api_test_logs(url);
CREATE INDEX idx_ai_embeddings_project_id ON ai_embeddings(project_id);
CREATE INDEX idx_ai_embeddings_source ON ai_embeddings(source);
-- Vector similarity search index for embeddings (using HNSW)
CREATE INDEX idx_ai_embeddings_vector ON ai_embeddings USING hnsw (embedding vector_cosine_ops);

-- Row Level Security (RLS) policies
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_test_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_embeddings ENABLE ROW LEVEL SECURITY;

-- Users can only see and modify their own data
CREATE POLICY "Users can view own profile" ON users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON users
    FOR UPDATE USING (auth.uid() = id);

-- Projects policies
CREATE POLICY "Users can view own projects" ON projects
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create projects" ON projects
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects" ON projects
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects" ON projects
    FOR DELETE USING (auth.uid() = user_id);

-- Tests policies
CREATE POLICY "Users can view tests from own projects" ON tests
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = tests.project_id
            AND projects.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create tests in own projects" ON tests
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = tests.project_id
            AND projects.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update tests from own projects" ON tests
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = tests.project_id
            AND projects.user_id = auth.uid()
        )
    );

-- Test results policies
CREATE POLICY "Users can view test results from own projects" ON test_results
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM tests
            JOIN projects ON projects.id = tests.project_id
            WHERE tests.id = test_results.test_id
            AND projects.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create test results for own tests" ON test_results
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM tests
            JOIN projects ON projects.id = tests.project_id
            WHERE tests.id = test_results.test_id
            AND projects.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update test results from own tests" ON test_results
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM tests
            JOIN projects ON projects.id = tests.project_id
            WHERE tests.id = test_results.test_id
            AND projects.user_id = auth.uid()
        )
    );

-- Credit transactions policies
CREATE POLICY "Users can view own credit transactions" ON credit_transactions
    FOR SELECT USING (auth.uid() = user_id);

-- Chat sessions policies
CREATE POLICY "Users can view own chat sessions" ON chat_sessions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own chat sessions" ON chat_sessions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own chat sessions" ON chat_sessions
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own chat sessions" ON chat_sessions
    FOR DELETE USING (auth.uid() = user_id);

-- Chat messages policies
CREATE POLICY "Users can view messages from own sessions" ON chat_messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM chat_sessions
            WHERE chat_sessions.id = chat_messages.session_id
            AND chat_sessions.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create messages in own sessions" ON chat_messages
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM chat_sessions
            WHERE chat_sessions.id = chat_messages.session_id
            AND chat_sessions.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update messages in own sessions" ON chat_messages
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM chat_sessions
            WHERE chat_sessions.id = chat_messages.session_id
            AND chat_sessions.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can delete messages from own sessions" ON chat_messages
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM chat_sessions
            WHERE chat_sessions.id = chat_messages.session_id
            AND chat_sessions.user_id = auth.uid()
        )
    );

-- Message feedback policies
CREATE POLICY "Users can view own feedback" ON message_feedback
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can create own feedback" ON message_feedback
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own feedback" ON message_feedback
    FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can delete own feedback" ON message_feedback
    FOR DELETE USING (user_id = auth.uid());

-- API test logs policies
CREATE POLICY "Users can view own API test logs" ON api_test_logs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own API test logs" ON api_test_logs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own API test logs" ON api_test_logs
    FOR DELETE USING (auth.uid() = user_id);

-- AI embeddings policies
CREATE POLICY "Users can view embeddings from own projects" ON ai_embeddings
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = ai_embeddings.project_id
            AND projects.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create embeddings in own projects" ON ai_embeddings
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = ai_embeddings.project_id
            AND projects.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update embeddings in own projects" ON ai_embeddings
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = ai_embeddings.project_id
            AND projects.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can delete embeddings from own projects" ON ai_embeddings
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = ai_embeddings.project_id
            AND projects.user_id = auth.uid()
        )
    );

-- Views for analytics and reporting
CREATE OR REPLACE VIEW feedback_analytics AS
SELECT
    intent_type,
    feedback_type,
    COUNT(*) as count,
    DATE_TRUNC('day', created_at) as date
FROM message_feedback
WHERE intent_type IS NOT NULL
GROUP BY intent_type, feedback_type, DATE_TRUNC('day', created_at)
ORDER BY date DESC, intent_type, feedback_type;

-- Grant access to analytics view
GRANT SELECT ON feedback_analytics TO authenticated;

-- Functions for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for automatic timestamp updates
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tests_updated_at BEFORE UPDATE ON tests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to calculate user credits
CREATE OR REPLACE FUNCTION calculate_user_credits(user_uuid UUID)
RETURNS INTEGER AS $$
DECLARE
    total_credits INTEGER;
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO total_credits
    FROM credit_transactions
    WHERE user_id = user_uuid;

    RETURN total_credits;
END;
$$ LANGUAGE plpgsql;

-- Function to deduct credits for test run
CREATE OR REPLACE FUNCTION deduct_test_credits(
    user_uuid UUID,
    test_uuid UUID,
    credit_amount INTEGER
)
RETURNS BOOLEAN AS $$
DECLARE
    current_credits INTEGER;
BEGIN
    -- Get current credits
    SELECT credits INTO current_credits
    FROM users
    WHERE id = user_uuid;

    -- Check if user has enough credits
    IF current_credits < credit_amount THEN
        RETURN FALSE;
    END IF;

    -- Deduct credits
    UPDATE users
    SET credits = credits - credit_amount
    WHERE id = user_uuid;

    -- Record transaction
    INSERT INTO credit_transactions (user_id, amount, type, description, test_id)
    VALUES (user_uuid, -credit_amount, 'usage', 'Test execution', test_uuid);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Function to get test statistics
CREATE OR REPLACE FUNCTION get_test_stats(project_uuid UUID)
RETURNS JSON AS $$
DECLARE
    stats JSON;
BEGIN
    SELECT json_build_object(
        'total_tests', COUNT(*),
        'completed_tests', COUNT(*) FILTER (WHERE status = 'completed'),
        'failed_tests', COUNT(*) FILTER (WHERE status = 'failed'),
        'pending_tests', COUNT(*) FILTER (WHERE status = 'pending'),
        'running_tests', COUNT(*) FILTER (WHERE status = 'running'),
        'last_test_at', MAX(created_at)
    ) INTO stats
    FROM tests
    WHERE project_id = project_uuid;

    RETURN stats;
END;
$$ LANGUAGE plpgsql;

-- Create storage bucket for screenshots
INSERT INTO storage.buckets (id, name, public)
VALUES ('qai-screenshots', 'qai-screenshots', true);

-- Storage policies for screenshots
CREATE POLICY "Public read access for screenshots" ON storage.objects
    FOR SELECT USING (bucket_id = 'qai-screenshots');

CREATE POLICY "Authenticated users can upload screenshots" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'qai-screenshots'
        AND auth.role() = 'authenticated'
    );

-- Sample data removed - users should register through Auth API
-- To create users, use POST /api/v1/auth/signup

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
