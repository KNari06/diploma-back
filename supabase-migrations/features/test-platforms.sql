-- ============================================================================
-- TEST PLATFORMS TABLE
-- ============================================================================
-- Top-level platform categories: Web UI tests and API tests
-- Each platform contains multiple test modules
-- ============================================================================

-- Test Platforms Table
CREATE TABLE IF NOT EXISTS test_platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- Platform key (fixed: web_ui or api)
  platform_key TEXT NOT NULL CHECK (platform_key IN ('web_ui', 'api')),

  -- Metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Exactly one platform of each type per project
  CONSTRAINT uq_test_platforms_project_key UNIQUE (project_id, platform_key)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_test_platforms_project
  ON test_platforms(project_id);

CREATE INDEX IF NOT EXISTS idx_test_platforms_user
  ON test_platforms(user_id);

CREATE INDEX IF NOT EXISTS idx_test_platforms_key
  ON test_platforms(platform_key);

-- ============================================================================
-- TRIGGER: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_test_platforms_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_test_platforms_updated_at ON test_platforms;
CREATE TRIGGER trigger_update_test_platforms_updated_at
  BEFORE UPDATE ON test_platforms
  FOR EACH ROW
  EXECUTE FUNCTION update_test_platforms_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE test_platforms ENABLE ROW LEVEL SECURITY;

-- Users can only see/modify their own platforms
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_platforms'
      AND policyname = 'Users can view own test platforms'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own test platforms" ON test_platforms FOR SELECT USING (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_platforms'
      AND policyname = 'Users can insert own test platforms'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own test platforms" ON test_platforms FOR INSERT WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_platforms'
      AND policyname = 'Users can update own test platforms'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own test platforms" ON test_platforms FOR UPDATE USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_platforms'
      AND policyname = 'Users can delete own test platforms'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own test platforms" ON test_platforms FOR DELETE USING (user_id = auth.uid()::text)';
  END IF;
END $$;

-- ============================================================================
-- LINK TEST_MODULES TO PLATFORM
-- ============================================================================

-- Add platform_id column to test_modules (nullable initially for migration)
ALTER TABLE test_modules
  ADD COLUMN IF NOT EXISTS platform_id UUID REFERENCES test_platforms(id) ON DELETE RESTRICT;

-- Index for platform lookups
CREATE INDEX IF NOT EXISTS idx_test_modules_platform
  ON test_modules(platform_id) WHERE platform_id IS NOT NULL;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE test_platforms IS 'Top-level platform categories: Web UI tests and API tests';
COMMENT ON COLUMN test_platforms.platform_key IS 'Platform type: web_ui or api';
COMMENT ON COLUMN test_modules.platform_id IS 'Reference to parent platform (web_ui or api)';
