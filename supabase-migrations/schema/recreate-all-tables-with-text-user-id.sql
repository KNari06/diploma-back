-- COMPLETE DATABASE RECREATION SCRIPT
-- This script recreates all tables with TEXT user_id instead of UUID
-- WARNING: This will DROP and RECREATE all tables - USE ONLY ON CLEAN DATABASE

-- ========================================
-- STEP 1: DROP ALL EXISTING TABLES
-- ========================================

-- Drop tables in correct order (respecting foreign key dependencies)
DROP TABLE IF EXISTS anonymous_chat_messages CASCADE;
DROP TABLE IF EXISTS anonymous_chat_sessions CASCADE;
DROP TABLE IF EXISTS anonymous_usage_limits CASCADE;
DROP TABLE IF EXISTS api_test_executions CASCADE;
DROP TABLE IF EXISTS api_test_configs CASCADE;
DROP TABLE IF EXISTS api_endpoints CASCADE;
DROP TABLE IF EXISTS api_environments CASCADE;
DROP TABLE IF EXISTS api_environments_backup CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP TABLE IF EXISTS chat_sessions CASCADE;
DROP TABLE IF EXISTS credit_transactions CASCADE;
DROP TABLE IF EXISTS exploration_cache CASCADE;
DROP TABLE IF EXISTS global_kb_chunks CASCADE;
DROP TABLE IF EXISTS jira_tokens CASCADE;
DROP TABLE IF EXISTS project_kb_chunks CASCADE;
DROP TABLE IF EXISTS test_results CASCADE;
DROP TABLE IF EXISTS tests CASCADE;
DROP TABLE IF EXISTS test_credentials CASCADE;
DROP TABLE IF EXISTS test_plans CASCADE;
DROP TABLE IF EXISTS trace_files CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;
DROP TABLE IF EXISTS user_credits CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS webhook_events CASCADE;
DROP TABLE IF EXISTS ai_embeddings CASCADE;

-- Drop custom types if they exist
DROP TYPE IF EXISTS user_role CASCADE;
DROP TYPE IF EXISTS test_status CASCADE;
DROP TYPE IF EXISTS browser_type CASCADE;
DROP TYPE IF EXISTS chat_role CASCADE;

-- Note: Functions will be recreated using CREATE OR REPLACE FUNCTION
-- This is safer than DROP FUNCTION as it preserves existing functions

-- ========================================
-- STEP 2: ENABLE REQUIRED EXTENSIONS
-- ========================================

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- ========================================
-- STEP 3: CREATE CUSTOM TYPES
-- ========================================

CREATE TYPE user_role AS ENUM ('user', 'admin', 'moderator');
CREATE TYPE test_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled', 'timeout');
CREATE TYPE browser_type AS ENUM ('chromium', 'firefox', 'webkit');
CREATE TYPE chat_role AS ENUM ('user', 'ai', 'system');

-- ========================================
-- STEP 4: RECREATE ALL TABLES WITH TEXT user_id
-- ========================================

-- Users table (base table)
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email character varying NOT NULL UNIQUE,
  name character varying,
  role user_role DEFAULT 'user'::user_role,
  credits integer DEFAULT 0,
  subscription jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- Workspaces table (TEXT user_id)
CREATE TABLE public.workspaces (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name character varying NOT NULL,
  user_id TEXT NOT NULL, -- Changed from UUID to TEXT
  platforms text[] NOT NULL DEFAULT '{}',
  api_testing boolean DEFAULT false,
  dev_base_url text,
  prod_base_url text,
  settings jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT workspaces_pkey PRIMARY KEY (id)
);

-- Projects table (TEXT user_id)
CREATE TABLE public.projects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name character varying NOT NULL,
  description text,
  user_id TEXT NOT NULL, -- Changed from UUID to TEXT
  settings jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  workspace_id uuid,
  CONSTRAINT projects_pkey PRIMARY KEY (id),
  CONSTRAINT projects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

-- Chat sessions table (TEXT user_id)
CREATE TABLE public.chat_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id TEXT, -- Changed from UUID to TEXT
  project_id uuid,
  title text,
  context jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  workspace_id uuid,
  CONSTRAINT chat_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT chat_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
  CONSTRAINT chat_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

-- Chat messages table
CREATE TABLE public.chat_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id uuid,
  role chat_role NOT NULL,
  content text NOT NULL,
  metadata jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE
);

-- Tests table (TEXT user_id)
CREATE TABLE public.tests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  url text NOT NULL,
  project_id uuid NOT NULL,
  user_id TEXT, -- Changed from UUID to TEXT
  status test_status DEFAULT 'pending'::test_status,
  browsers text[] NOT NULL,
  options jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  CONSTRAINT tests_pkey PRIMARY KEY (id),
  CONSTRAINT tests_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE
);

-- Test results table
CREATE TABLE public.test_results (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL,
  browser browser_type NOT NULL,
  status test_status DEFAULT 'pending'::test_status,
  screenshot text,
  dom text,
  logs text[] DEFAULT '{}',
  network_logs jsonb DEFAULT '[]',
  errors jsonb DEFAULT '[]',
  performance jsonb,
  ai_summary jsonb,
  created_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  CONSTRAINT test_results_pkey PRIMARY KEY (id),
  CONSTRAINT test_results_test_id_fkey FOREIGN KEY (test_id) REFERENCES public.tests(id) ON DELETE CASCADE
);

-- Credit transactions table (TEXT user_id)
CREATE TABLE public.credit_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, -- Changed from UUID to TEXT
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  transaction_type text NOT NULL,
  description text,
  metadata jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT credit_transactions_pkey PRIMARY KEY (id)
);

-- User credits table (TEXT user_id)
CREATE TABLE public.user_credits (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE, -- Changed from UUID to TEXT
  credits_balance integer NOT NULL DEFAULT 0,
  total_purchased integer NOT NULL DEFAULT 0,
  total_used integer NOT NULL DEFAULT 0,
  subscription_plan text DEFAULT 'free',
  subscription_status text DEFAULT 'inactive',
  subscription_expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_credits_pkey PRIMARY KEY (id)
);

-- API Environments table (TEXT user_id)
CREATE TABLE public.api_environments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, -- Already TEXT in schema
  project_id text NOT NULL,
  name text NOT NULL,
  base_url text NOT NULL,
  description text,
  default_headers jsonb DEFAULT '{}',
  auth_type text NOT NULL DEFAULT 'none',
  auth_config jsonb DEFAULT '{}',
  variables jsonb DEFAULT '{}',
  is_active boolean DEFAULT true,
  is_default boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT api_environments_pkey PRIMARY KEY (id)
);

-- API Endpoints table (TEXT user_id)
CREATE TABLE public.api_endpoints (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL,
  user_id TEXT NOT NULL, -- Already TEXT in schema
  name text NOT NULL,
  method text NOT NULL CHECK (method = ANY (ARRAY['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])),
  path text NOT NULL,
  description text,
  headers jsonb DEFAULT '{}',
  query_params jsonb DEFAULT '{}',
  path_params jsonb DEFAULT '{}',
  body_template jsonb,
  expected_responses jsonb DEFAULT '[]',
  timeout_ms integer DEFAULT 10000,
  retry_count integer DEFAULT 0,
  tags text[] DEFAULT '{}',
  category text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT api_endpoints_pkey PRIMARY KEY (id)
);

-- API Test Configs table (TEXT user_id)
CREATE TABLE public.api_test_configs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL,
  user_id TEXT NOT NULL, -- Already TEXT in schema
  name text NOT NULL,
  description text,
  test_data jsonb NOT NULL,
  expected_status integer NOT NULL,
  expected_response jsonb,
  setup_steps jsonb DEFAULT '[]',
  cleanup_steps jsonb DEFAULT '[]',
  dependencies text[],
  validation_rules jsonb DEFAULT '[]',
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT api_test_configs_pkey PRIMARY KEY (id),
  CONSTRAINT api_test_configs_endpoint_id_fkey FOREIGN KEY (endpoint_id) REFERENCES public.api_endpoints(id) ON DELETE CASCADE
);

-- API Test Executions table (TEXT user_id)
CREATE TABLE public.api_test_executions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, -- Already TEXT in schema
  environment_id uuid,
  endpoint_id uuid,
  test_config_id uuid,
  execution_type text NOT NULL DEFAULT 'manual' CHECK (execution_type = ANY (ARRAY['manual', 'chat', 'scheduled', 'ci_cd'])),
  request_data jsonb NOT NULL,
  response_data jsonb NOT NULL,
  status_code integer NOT NULL,
  duration_ms integer NOT NULL,
  success boolean NOT NULL,
  validation_results jsonb DEFAULT '{}',
  error_message text,
  chat_session_id text,
  user_agent text DEFAULT 'QAI-Backend',
  executed_at timestamp with time zone DEFAULT now(),
  CONSTRAINT api_test_executions_pkey PRIMARY KEY (id),
  CONSTRAINT api_test_executions_endpoint_id_fkey FOREIGN KEY (endpoint_id) REFERENCES public.api_endpoints(id) ON DELETE SET NULL,
  CONSTRAINT api_test_executions_test_config_id_fkey FOREIGN KEY (test_config_id) REFERENCES public.api_test_configs(id) ON DELETE SET NULL
);

-- Global KB chunks table (TEXT uploaded_by)
CREATE TABLE public.global_kb_chunks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding vector(1536),
  source_file text NOT NULL,
  tags text[] DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  uploaded_by TEXT, -- Changed from UUID to TEXT
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT global_kb_chunks_pkey PRIMARY KEY (id)
);

-- Project KB chunks table (TEXT uploaded_by)
CREATE TABLE public.project_kb_chunks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  file_name text NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  metadata jsonb DEFAULT '{}',
  uploaded_by TEXT NOT NULL, -- Changed from UUID to TEXT
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT project_kb_chunks_pkey PRIMARY KEY (id),
  CONSTRAINT project_kb_chunks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE
);

-- Anonymous tables (already have TEXT fields)
CREATE TABLE public.anonymous_chat_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  anonymous_id text NOT NULL,
  title text,
  context jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT anonymous_chat_sessions_pkey PRIMARY KEY (id)
);

CREATE TABLE public.anonymous_chat_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['user', 'ai'])),
  content text NOT NULL,
  metadata jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT anonymous_chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT anonymous_chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.anonymous_chat_sessions(id) ON DELETE CASCADE
);

CREATE TABLE public.anonymous_usage_limits (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  anonymous_id text NOT NULL UNIQUE,
  request_count integer DEFAULT 0,
  last_request_at timestamp with time zone DEFAULT now(),
  first_request_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT anonymous_usage_limits_pkey PRIMARY KEY (id)
);

-- Optional tables (may not exist in all environments)
CREATE TABLE IF NOT EXISTS public.exploration_cache (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id TEXT, -- Changed from UUID to TEXT
  project_id text NOT NULL,
  url text NOT NULL,
  scope text NOT NULL,
  screenshot text,
  visual_analysis jsonb,
  dom_analysis jsonb,
  page_info jsonb,
  recommendations text[],
  created_at timestamp without time zone DEFAULT now(),
  expires_at timestamp without time zone DEFAULT (now() + '7 days'::interval),
  hit_count integer DEFAULT 0,
  CONSTRAINT exploration_cache_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.test_plans (
  id text NOT NULL,
  user_id TEXT, -- Changed from UUID to TEXT
  project_id text NOT NULL,
  url text NOT NULL,
  scope text NOT NULL,
  summary text NOT NULL,
  steps jsonb NOT NULL,
  commands jsonb NOT NULL,
  estimated_duration text,
  what_will_be_tested text[],
  what_will_not_be_tested text[],
  risks text[],
  status text DEFAULT 'pending_confirmation' CHECK (status = ANY (ARRAY['pending_confirmation', 'confirmed', 'rejected', 'expired'])),
  rejection_reason text,
  exploration_id uuid,
  created_at timestamp without time zone DEFAULT now(),
  expires_at timestamp without time zone DEFAULT (now() + '01:00:00'::interval),
  confirmed_at timestamp without time zone,
  rejected_at timestamp without time zone,
  CONSTRAINT test_plans_pkey PRIMARY KEY (id),
  CONSTRAINT test_plans_exploration_id_fkey FOREIGN KEY (exploration_id) REFERENCES public.exploration_cache(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.test_credentials (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, -- Changed from UUID to TEXT
  project_id text NOT NULL,
  email_encrypted text,
  username_encrypted text,
  password_encrypted text NOT NULL,
  label text,
  url_pattern text,
  notes text,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  last_used_at timestamp without time zone,
  CONSTRAINT test_credentials_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.trace_files (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, -- Changed from UUID to TEXT
  test_id uuid,
  file_name text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  file_size bigint,
  browser text,
  status text DEFAULT 'uploaded' CHECK (status = ANY (ARRAY['uploaded', 'parsing', 'parsed', 'failed'])),
  parsed_data jsonb,
  public_url text,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  parsed_at timestamp without time zone,
  CONSTRAINT trace_files_pkey PRIMARY KEY (id),
  CONSTRAINT fk_trace_files_test_id FOREIGN KEY (test_id) REFERENCES public.tests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.jira_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, -- Changed from UUID to TEXT
  access_token text NOT NULL,
  refresh_token text,
  expires_at timestamp with time zone,
  scope text,
  cloud_id text NOT NULL,
  site_url text,
  token_type text DEFAULT 'Bearer',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT jira_tokens_pkey PRIMARY KEY (id)
);

-- Webhook events (no user_id)
CREATE TABLE public.webhook_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  type character varying NOT NULL,
  data jsonb NOT NULL,
  signature text,
  processed boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT webhook_events_pkey PRIMARY KEY (id)
);

-- AI embeddings (project_id reference)
CREATE TABLE public.ai_embeddings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid,
  source text,
  content text,
  embedding vector(1536),
  metadata jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT ai_embeddings_pkey PRIMARY KEY (id),
  CONSTRAINT ai_embeddings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE
);

-- ========================================
-- STEP 4: CREATE INDEXES
-- ========================================

-- Workspaces indexes
CREATE INDEX idx_workspaces_user_id ON public.workspaces(user_id);
CREATE INDEX idx_workspaces_created_at ON public.workspaces(created_at DESC);

-- Projects indexes
CREATE INDEX idx_projects_user_id ON public.projects(user_id);
CREATE INDEX idx_projects_workspace_id ON public.projects(workspace_id);
CREATE INDEX idx_projects_created_at ON public.projects(created_at DESC);

-- Chat sessions indexes
CREATE INDEX idx_chat_sessions_user_id ON public.chat_sessions(user_id);
CREATE INDEX idx_chat_sessions_project_id ON public.chat_sessions(project_id);
CREATE INDEX idx_chat_sessions_workspace_id ON public.chat_sessions(workspace_id);

-- Tests indexes
CREATE INDEX idx_tests_user_id ON public.tests(user_id);
CREATE INDEX idx_tests_project_id ON public.tests(project_id);
CREATE INDEX idx_tests_status ON public.tests(status);

-- API environments indexes
CREATE INDEX idx_api_environments_user_id ON public.api_environments(user_id);
CREATE INDEX idx_api_environments_project_id ON public.api_environments(project_id);
CREATE UNIQUE INDEX idx_api_environments_user_base_url ON public.api_environments(user_id, base_url);

-- Knowledge base indexes
CREATE INDEX idx_global_kb_source_file ON public.global_kb_chunks(source_file);
CREATE INDEX idx_global_kb_uploaded_by ON public.global_kb_chunks(uploaded_by);
CREATE INDEX idx_project_kb_project_id ON public.project_kb_chunks(project_id);
CREATE INDEX idx_project_kb_uploaded_by ON public.project_kb_chunks(uploaded_by);

-- Vector indexes (if pgvector is available)
CREATE INDEX IF NOT EXISTS idx_global_kb_embedding ON public.global_kb_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_project_kb_embedding ON public.project_kb_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ========================================
-- STEP 5: ENABLE ROW LEVEL SECURITY
-- ========================================

-- Enable RLS on all user-related tables
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_kb_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_kb_chunks ENABLE ROW LEVEL SECURITY;

-- ========================================
-- STEP 6: CREATE RLS POLICIES (TEXT user_id compatible)
-- ========================================

-- Workspaces policies
CREATE POLICY "Users can view own workspaces" ON public.workspaces
    FOR SELECT USING (
        -- Authenticated users: match UUID
        (auth.uid()::text = user_id) OR
        -- Anonymous users: user_id is IP address (no auth check)
        (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
    );

CREATE POLICY "Users can create workspaces" ON public.workspaces
    FOR INSERT WITH CHECK (
        -- Authenticated users: must match their UUID
        (auth.uid()::text = user_id) OR
        -- Anonymous users: user_id is IP address (no auth check)
        (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
    );

CREATE POLICY "Users can update own workspaces" ON public.workspaces
    FOR UPDATE USING (
        -- Authenticated users: match UUID
        (auth.uid()::text = user_id) OR
        -- Anonymous users: user_id is IP address (no auth check)
        (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
    );

CREATE POLICY "Users can delete own workspaces" ON public.workspaces
    FOR DELETE USING (
        -- Authenticated users: match UUID
        (auth.uid()::text = user_id) OR
        -- Anonymous users: user_id is IP address (no auth check)
        (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
    );

-- Projects policies
CREATE POLICY "Users can view own projects" ON public.projects
    FOR SELECT USING (
        (auth.uid()::text = user_id) OR
        (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
    );

CREATE POLICY "Users can create projects" ON public.projects
    FOR INSERT WITH CHECK (
        (auth.uid()::text = user_id) OR
        (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
    );

-- Chat sessions policies
CREATE POLICY "Users can view own chat sessions" ON public.chat_sessions
    FOR SELECT USING (
        (auth.uid()::text = user_id) OR
        (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
    );

CREATE POLICY "Users can create chat sessions" ON public.chat_sessions
    FOR INSERT WITH CHECK (
        (auth.uid()::text = user_id) OR
        (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
    );

-- Tests policies
CREATE POLICY "Users can view own tests" ON public.tests
    FOR SELECT USING (
        (auth.uid()::text = user_id) OR
        (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
    );

-- API environments policies
CREATE POLICY "api_environments_user_policy" ON public.api_environments
  FOR ALL USING (
    -- Authenticated users: match UUID
    (user_id = auth.uid()::text) OR
    -- Anonymous users: user_id is IP address (no auth check)
    (auth.uid() IS NULL AND user_id ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')
  );

-- Global KB policies (admin only for write, everyone for read)
CREATE POLICY "Everyone can view global KB" ON public.global_kb_chunks
    FOR SELECT TO authenticated USING (true);

-- Project KB policies
CREATE POLICY "Users can view own project KB" ON public.project_kb_chunks
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.projects
            WHERE projects.id = project_kb_chunks.project_id
            AND projects.user_id = auth.uid()::text
        )
    );

-- ========================================
-- STEP 7: CREATE CUSTOM FUNCTIONS
-- ========================================

-- Knowledge Base search functions
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
SECURITY DEFINER
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
SECURITY DEFINER
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

-- User sync functions (for Supabase Auth integration)
CREATE OR REPLACE FUNCTION public.sync_user_to_public()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Insert or update user in public.users table
    INSERT INTO public.users (id, email, name, created_at, updated_at)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        NEW.created_at,
        NEW.updated_at
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        name = COALESCE(EXCLUDED.name, public.users.name),
        updated_at = EXCLUDED.updated_at;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_auth_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Delete user from public.users table
    DELETE FROM public.users WHERE id = OLD.id;
    RETURN OLD;
END;
$$;

-- Utility functions
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cleanup_old_anonymous_data()
RETURNS void AS $$
BEGIN
  DELETE FROM public.anonymous_chat_sessions WHERE created_at < NOW() - INTERVAL '7 days';
  DELETE FROM public.anonymous_usage_limits WHERE last_request_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cleanup_expired_items()
RETURNS void AS $$
BEGIN
  -- Delete expired exploration cache
  DELETE FROM exploration_cache WHERE expires_at < NOW();
  -- Delete expired test plans
  DELETE FROM test_plans WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Anonymous to authenticated migration function
CREATE OR REPLACE FUNCTION public.migrate_anonymous_to_authenticated(
  p_anonymous_id TEXT,
  p_user_id TEXT -- Changed to TEXT to support both UUID and IP
)
RETURNS JSONB AS $$
DECLARE
  v_migrated_sessions INTEGER := 0;
  v_migrated_workspaces INTEGER := 0;
  v_migrated_projects INTEGER := 0;
BEGIN
  -- Migrate anonymous chat sessions
  UPDATE public.anonymous_chat_sessions
  SET anonymous_id = p_user_id
  WHERE anonymous_id = p_anonymous_id;

  GET DIAGNOSTICS v_migrated_sessions = ROW_COUNT;

  -- Migrate workspaces
  UPDATE public.workspaces
  SET user_id = p_user_id
  WHERE user_id = p_anonymous_id;

  GET DIAGNOSTICS v_migrated_workspaces = ROW_COUNT;

  -- Migrate projects
  UPDATE public.projects
  SET user_id = p_user_id
  WHERE user_id = p_anonymous_id;

  GET DIAGNOSTICS v_migrated_projects = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'migrated_sessions', v_migrated_sessions,
    'migrated_workspaces', v_migrated_workspaces,
    'migrated_projects', v_migrated_projects
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ========================================
-- STEP 8: CREATE TRIGGERS
-- ========================================

-- Auth sync triggers (if auth.users table exists)
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users') THEN
        -- Create triggers for auth sync (CREATE OR REPLACE for safety)
        CREATE OR REPLACE TRIGGER sync_user_to_public_trigger
            AFTER INSERT OR UPDATE ON auth.users
            FOR EACH ROW EXECUTE FUNCTION public.sync_user_to_public();

        CREATE OR REPLACE TRIGGER handle_auth_user_delete_trigger
            BEFORE DELETE ON auth.users
            FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_delete();
    END IF;
END $$;

-- Updated_at triggers (CREATE OR REPLACE for safety)
CREATE OR REPLACE TRIGGER update_api_environments_updated_at
    BEFORE UPDATE ON public.api_environments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON public.projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_workspaces_updated_at
    BEFORE UPDATE ON public.workspaces
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ========================================
-- STEP 9: GRANT PERMISSIONS
-- ========================================

-- Grant permissions to authenticated users
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- Grant permissions to service_role (for backend operations)
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- ========================================
-- COMPLETION MESSAGE
-- ========================================

DO $$
BEGIN
    RAISE NOTICE '🚀 DATABASE RECREATION COMPLETED SUCCESSFULLY!';
    RAISE NOTICE '✅ All tables recreated with TEXT user_id';
    RAISE NOTICE '✅ All indexes created';
    RAISE NOTICE '✅ RLS policies configured for anonymous + authenticated users';
    RAISE NOTICE '✅ Permissions granted';
    RAISE NOTICE '';
    RAISE NOTICE '📋 TABLES WITH TEXT user_id:';
    RAISE NOTICE '- workspaces.user_id (TEXT)';
    RAISE NOTICE '- projects.user_id (TEXT)';
    RAISE NOTICE '- chat_sessions.user_id (TEXT)';
    RAISE NOTICE '- tests.user_id (TEXT)';
    RAISE NOTICE '- credit_transactions.user_id (TEXT)';
    RAISE NOTICE '- user_credits.user_id (TEXT)';
    RAISE NOTICE '- api_environments.user_id (TEXT)';
    RAISE NOTICE '- api_endpoints.user_id (TEXT)';
    RAISE NOTICE '- api_test_configs.user_id (TEXT)';
    RAISE NOTICE '- api_test_executions.user_id (TEXT)';
    RAISE NOTICE '- global_kb_chunks.uploaded_by (TEXT)';
    RAISE NOTICE '- project_kb_chunks.uploaded_by (TEXT)';
    RAISE NOTICE '';
    RAISE NOTICE '🎯 Ready for anonymous users (IP addresses) + authenticated users (UUIDs)!';
END $$;
