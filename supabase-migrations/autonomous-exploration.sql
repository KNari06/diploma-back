-- =====================================================
-- Autonomous Exploration & Test Plan Tables
-- =====================================================

-- 1. Exploration Cache Table
-- Stores results of autonomous product explorations
CREATE TABLE IF NOT EXISTS exploration_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id TEXT NOT NULL,
  url TEXT NOT NULL,
  scope TEXT NOT NULL,

  -- Exploration results
  screenshot TEXT, -- base64 or storage URL
  visual_analysis JSONB, -- GPT-4o Vision results
  dom_analysis JSONB, -- DOM structure
  page_info JSONB, -- Title, URL, auth status
  recommendations TEXT[], -- Array of recommendations

  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '7 days'), -- Cache for 7 days
  hit_count INTEGER DEFAULT 0 -- How many times this cache was used
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_exploration_cache_url
  ON exploration_cache(url, project_id);
CREATE INDEX IF NOT EXISTS idx_exploration_cache_user
  ON exploration_cache(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exploration_cache_expires
  ON exploration_cache(expires_at);

-- 2. Test Plans Table
-- Stores test plans awaiting user confirmation
CREATE TABLE IF NOT EXISTS test_plans (
  id TEXT PRIMARY KEY, -- plan_timestamp_random
  user_id UUID NOT NULL,
  project_id TEXT NOT NULL,

  -- Plan details
  url TEXT NOT NULL,
  scope TEXT NOT NULL,
  summary TEXT NOT NULL,
  steps JSONB NOT NULL, -- Array of test steps
  commands JSONB NOT NULL, -- Playwright commands

  -- Additional info
  estimated_duration TEXT,
  what_will_be_tested TEXT[],
  what_will_not_be_tested TEXT[],
  risks TEXT[],

  -- Status
  status TEXT DEFAULT 'pending_confirmation'
    CHECK (status IN ('pending_confirmation', 'confirmed', 'rejected', 'expired')),
  rejection_reason TEXT,

  -- Related exploration
  exploration_id UUID REFERENCES exploration_cache(id),

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '1 hour'), -- Expires after 1 hour
  confirmed_at TIMESTAMP,
  rejected_at TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_test_plans_user
  ON test_plans(user_id, status);
CREATE INDEX IF NOT EXISTS idx_test_plans_status
  ON test_plans(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_plans_expires
  ON test_plans(expires_at) WHERE status = 'pending_confirmation';

-- 3. Test Credentials Table
-- Securely stores test credentials (encrypted)
CREATE TABLE IF NOT EXISTS test_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id TEXT NOT NULL,

  -- Encrypted credentials
  email_encrypted TEXT,
  username_encrypted TEXT,
  password_encrypted TEXT NOT NULL, -- Always required

  -- Metadata
  label TEXT, -- User-friendly label (e.g., "Test Account 1")
  url_pattern TEXT, -- Which URLs these credentials are for
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_used_at TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_test_credentials_user
  ON test_credentials(user_id, project_id);

-- 4. Auto-cleanup function
-- Automatically delete expired items
CREATE OR REPLACE FUNCTION cleanup_expired_items()
RETURNS void AS $$
BEGIN
  -- Delete expired exploration cache
  DELETE FROM exploration_cache
  WHERE expires_at < NOW();

  -- Expire old test plans
  UPDATE test_plans
  SET status = 'expired'
  WHERE status = 'pending_confirmation'
    AND expires_at < NOW();

  RAISE NOTICE 'Cleanup completed';
END;
$$ LANGUAGE plpgsql;

-- 5. Row Level Security (RLS)

-- Enable RLS
ALTER TABLE exploration_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_credentials ENABLE ROW LEVEL SECURITY;

-- Exploration cache policies
CREATE POLICY "Users can view their own exploration cache"
  ON exploration_cache FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own exploration cache"
  ON exploration_cache FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own exploration cache"
  ON exploration_cache FOR UPDATE
  USING (auth.uid() = user_id);

-- Test plans policies
CREATE POLICY "Users can view their own test plans"
  ON test_plans FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own test plans"
  ON test_plans FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own test plans"
  ON test_plans FOR UPDATE
  USING (auth.uid() = user_id);

-- Credentials policies (most restrictive)
CREATE POLICY "Users can view their own credentials"
  ON test_credentials FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own credentials"
  ON test_credentials FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own credentials"
  ON test_credentials FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own credentials"
  ON test_credentials FOR DELETE
  USING (auth.uid() = user_id);

-- 6. Comments for documentation
COMMENT ON TABLE exploration_cache IS 'Caches autonomous exploration results for faster repeat tests';
COMMENT ON TABLE test_plans IS 'Stores test plans awaiting user confirmation before execution';
COMMENT ON TABLE test_credentials IS 'Securely stores encrypted test credentials for authenticated testing';

COMMENT ON COLUMN test_credentials.password_encrypted IS 'Encrypted with AES-256';
COMMENT ON COLUMN test_plans.status IS 'pending_confirmation | confirmed | rejected | expired';

-- 7. Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_test_credentials_updated_at
  BEFORE UPDATE ON test_credentials
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- Usage Examples
-- =====================================================

-- Insert exploration cache:
-- INSERT INTO exploration_cache (user_id, project_id, url, scope, visual_analysis, dom_analysis, page_info, recommendations)
-- VALUES (...);

-- Check for cached exploration:
-- SELECT * FROM exploration_cache
-- WHERE url = 'https://example.com'
--   AND project_id = 'proj-123'
--   AND expires_at > NOW()
-- ORDER BY created_at DESC LIMIT 1;

-- Insert test plan:
-- INSERT INTO test_plans (id, user_id, project_id, url, scope, summary, steps, commands, ...)
-- VALUES (...);

-- Confirm test plan:
-- UPDATE test_plans
-- SET status = 'confirmed', confirmed_at = NOW()
-- WHERE id = 'plan_xxx' AND user_id = 'user_yyy';

-- Store credentials (encrypted):
-- INSERT INTO test_credentials (user_id, project_id, password_encrypted, label)
-- VALUES (...);

-- Manual cleanup:
-- SELECT cleanup_expired_items();
