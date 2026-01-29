-- ============================================================================
-- TEST FIXTURES TABLE
-- ============================================================================
-- Reusable test data (users, cards, addresses, etc.)
-- Can be scoped to project, module, suite, or flow level
-- ============================================================================

-- Test Fixtures Table
CREATE TABLE IF NOT EXISTS test_fixtures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- Metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Fixture data
  data JSONB NOT NULL,

  -- Scope
  scope TEXT DEFAULT 'project' CHECK (scope IN ('global', 'project', 'module', 'suite', 'flow')),
  module_id UUID REFERENCES test_modules(id) ON DELETE SET NULL,

  -- Classification
  tags TEXT[] DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_test_fixtures_project
  ON test_fixtures(project_id, scope);

CREATE INDEX IF NOT EXISTS idx_test_fixtures_module
  ON test_fixtures(module_id) WHERE module_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_fixtures_tags
  ON test_fixtures USING GIN(tags);

-- ============================================================================
-- TRIGGER: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_test_fixtures_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_test_fixtures_updated_at ON test_fixtures;
CREATE TRIGGER trigger_update_test_fixtures_updated_at
  BEFORE UPDATE ON test_fixtures
  FOR EACH ROW
  EXECUTE FUNCTION update_test_fixtures_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE test_fixtures ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_fixtures'
      AND policyname = 'Users can view own test fixtures'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own test fixtures" ON test_fixtures FOR SELECT USING (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_fixtures'
      AND policyname = 'Users can insert own test fixtures'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own test fixtures" ON test_fixtures FOR INSERT WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_fixtures'
      AND policyname = 'Users can update own test fixtures'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own test fixtures" ON test_fixtures FOR UPDATE USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_fixtures'
      AND policyname = 'Users can delete own test fixtures'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own test fixtures" ON test_fixtures FOR DELETE USING (user_id = auth.uid()::text)';
  END IF;
END $$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE test_fixtures IS 'Reusable test data (users, cards, addresses)';
COMMENT ON COLUMN test_fixtures.data IS 'JSON object containing fixture data';
COMMENT ON COLUMN test_fixtures.scope IS 'Visibility scope: global, project, module, suite, flow';
