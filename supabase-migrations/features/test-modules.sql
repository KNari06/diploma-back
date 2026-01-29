-- ============================================================================
-- TEST MODULES TABLE
-- ============================================================================
-- Functional modules within a project (Auth, Payments, Profile, etc.)
-- Each module contains multiple test suites
-- ============================================================================

-- Test Modules Table
CREATE TABLE IF NOT EXISTS test_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- Metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Classification
  tags TEXT[] DEFAULT '{}',
  priority TEXT CHECK (priority IN ('critical', 'high', 'medium', 'low')),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_test_modules_project
  ON test_modules(project_id);

CREATE INDEX IF NOT EXISTS idx_test_modules_user
  ON test_modules(user_id);

CREATE INDEX IF NOT EXISTS idx_test_modules_tags
  ON test_modules USING GIN(tags);

CREATE INDEX IF NOT EXISTS idx_test_modules_priority
  ON test_modules(priority) WHERE priority IS NOT NULL;

-- ============================================================================
-- TRIGGER: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_test_modules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_test_modules_updated_at ON test_modules;
CREATE TRIGGER trigger_update_test_modules_updated_at
  BEFORE UPDATE ON test_modules
  FOR EACH ROW
  EXECUTE FUNCTION update_test_modules_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE test_modules ENABLE ROW LEVEL SECURITY;

-- Users can only see/modify their own modules
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_modules'
      AND policyname = 'Users can view own test modules'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own test modules" ON test_modules FOR SELECT USING (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_modules'
      AND policyname = 'Users can insert own test modules'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own test modules" ON test_modules FOR INSERT WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_modules'
      AND policyname = 'Users can update own test modules'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own test modules" ON test_modules FOR UPDATE USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_modules'
      AND policyname = 'Users can delete own test modules'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own test modules" ON test_modules FOR DELETE USING (user_id = auth.uid()::text)';
  END IF;
END $$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE test_modules IS 'Functional modules within a project (Auth, Payments, Profile)';
COMMENT ON COLUMN test_modules.tags IS 'Array of tags for filtering and categorization';
COMMENT ON COLUMN test_modules.priority IS 'Module priority: critical, high, medium, low';
