-- API Configurations Migration
-- Stores user API configurations for testing

-- 1. API Environments Table
-- Stores different API environments (dev, staging, prod, etc.)
CREATE TABLE IF NOT EXISTS api_environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id TEXT NOT NULL,

  -- Environment details
  name TEXT NOT NULL, -- e.g., "Development", "Staging", "Production"
  base_url TEXT NOT NULL, -- e.g., "https://api.example.com/v1"
  description TEXT,

  -- Default headers for this environment
  default_headers JSONB DEFAULT '{}', -- e.g., {"Content-Type": "application/json"}

  -- Authentication configuration
  auth_type TEXT DEFAULT 'none'
    CHECK (auth_type IN ('none', 'bearer', 'api_key', 'basic', 'oauth2')),
  auth_config JSONB DEFAULT '{}', -- Stores auth-specific config

  -- Environment variables/constants
  variables JSONB DEFAULT '{}', -- e.g., {"userId": "123", "version": "v1"}

  -- Status and metadata
  is_active BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false, -- One default per project

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. API Endpoints Table
-- Stores specific API endpoints with their configurations
CREATE TABLE IF NOT EXISTS api_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id UUID NOT NULL REFERENCES api_environments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,

  -- Endpoint details
  name TEXT NOT NULL, -- e.g., "Get Users", "Create Post"
  method TEXT NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS')),
  path TEXT NOT NULL, -- e.g., "/users", "/posts/{id}"
  description TEXT,

  -- Request configuration
  headers JSONB DEFAULT '{}', -- Endpoint-specific headers
  query_params JSONB DEFAULT '{}', -- Default query parameters
  path_params JSONB DEFAULT '{}', -- Path parameter definitions
  body_template JSONB, -- Template for request body

  -- Expected responses
  expected_responses JSONB DEFAULT '[]', -- Array of {status: 200, description: "Success"}

  -- Test configuration
  timeout_ms INTEGER DEFAULT 10000,
  retry_count INTEGER DEFAULT 0,

  -- Tags and categorization
  tags TEXT[] DEFAULT '{}', -- e.g., ["user-management", "critical"]
  category TEXT, -- e.g., "authentication", "data-management"

  -- Status
  is_active BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. API Test Configurations Table
-- Stores pre-configured test scenarios for endpoints
CREATE TABLE IF NOT EXISTS api_test_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES api_endpoints(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,

  -- Test scenario details
  name TEXT NOT NULL, -- e.g., "Happy Path", "Invalid Data", "Edge Cases"
  description TEXT,

  -- Test data
  test_data JSONB NOT NULL, -- Specific test data for this scenario
  expected_status INTEGER NOT NULL,
  expected_response JSONB, -- Expected response structure/data

  -- Test configuration
  setup_steps JSONB DEFAULT '[]', -- Pre-test setup steps
  cleanup_steps JSONB DEFAULT '[]', -- Post-test cleanup steps
  dependencies TEXT[], -- Other test configs this depends on

  -- Validation rules
  validation_rules JSONB DEFAULT '[]', -- Custom validation rules

  -- Status
  is_active BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. API Test Execution History
-- Stores history of API test executions
CREATE TABLE IF NOT EXISTS api_test_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  environment_id UUID REFERENCES api_environments(id),
  endpoint_id UUID REFERENCES api_endpoints(id),
  test_config_id UUID REFERENCES api_test_configs(id),

  -- Execution details
  execution_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (execution_type IN ('manual', 'chat', 'scheduled', 'ci_cd')),

  -- Request details
  request_data JSONB NOT NULL, -- Actual request sent

  -- Response details
  response_data JSONB NOT NULL, -- Actual response received
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,

  -- Results
  success BOOLEAN NOT NULL,
  validation_results JSONB DEFAULT '{}', -- Results of validation checks
  error_message TEXT,

  -- Context
  chat_session_id TEXT, -- If triggered from chat
  user_agent TEXT DEFAULT 'QAI-Backend',

  -- Timestamps
  executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_api_environments_user_project
  ON api_environments(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_api_environments_default
  ON api_environments(user_id, project_id, is_default) WHERE is_default = true;

CREATE INDEX IF NOT EXISTS idx_api_endpoints_environment
  ON api_endpoints(environment_id, is_active);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_method_path
  ON api_endpoints(environment_id, method, path);

CREATE INDEX IF NOT EXISTS idx_api_test_configs_endpoint
  ON api_test_configs(endpoint_id, is_active);

CREATE INDEX IF NOT EXISTS idx_api_test_executions_user_time
  ON api_test_executions(user_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_test_executions_endpoint
  ON api_test_executions(endpoint_id, executed_at DESC);

-- Constraints
-- Only one default environment per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_environments_unique_default
  ON api_environments(user_id, project_id)
  WHERE is_default = true;

-- Unique endpoint per environment
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_endpoints_unique_method_path
  ON api_endpoints(environment_id, method, path);

-- RLS (Row Level Security) Policies
ALTER TABLE api_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_test_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_test_executions ENABLE ROW LEVEL SECURITY;

-- Users can only access their own data
CREATE POLICY api_environments_user_policy ON api_environments
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY api_endpoints_user_policy ON api_endpoints
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY api_test_configs_user_policy ON api_test_configs
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY api_test_executions_user_policy ON api_test_executions
  FOR ALL USING (user_id = auth.uid());

-- Functions for automatic updates
CREATE OR REPLACE FUNCTION update_api_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER api_environments_updated_at
  BEFORE UPDATE ON api_environments
  FOR EACH ROW EXECUTE FUNCTION update_api_config_updated_at();

CREATE TRIGGER api_endpoints_updated_at
  BEFORE UPDATE ON api_endpoints
  FOR EACH ROW EXECUTE FUNCTION update_api_config_updated_at();

CREATE TRIGGER api_test_configs_updated_at
  BEFORE UPDATE ON api_test_configs
  FOR EACH ROW EXECUTE FUNCTION update_api_config_updated_at();

-- Sample data for testing (optional)
-- INSERT INTO api_environments (user_id, project_id, name, base_url, default_headers, auth_type, is_default) VALUES
-- ('00000000-0000-0000-0000-000000000000', 'test-project', 'Development', 'https://jsonplaceholder.typicode.com', '{"Content-Type": "application/json"}', 'none', true);

COMMENT ON TABLE api_environments IS 'Stores API environment configurations for users';
COMMENT ON TABLE api_endpoints IS 'Stores specific API endpoint configurations';
COMMENT ON TABLE api_test_configs IS 'Stores pre-configured test scenarios for endpoints';
COMMENT ON TABLE api_test_executions IS 'Stores history of API test executions';
