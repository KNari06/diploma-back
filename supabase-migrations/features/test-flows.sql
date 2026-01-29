-- ============================================================================
-- TEST FLOWS TABLE
-- ============================================================================
-- Test flows within a suite (Happy path, Error handling, Edge cases)
-- Each flow contains multiple test cases
-- ============================================================================

-- Test Flows Table
CREATE TABLE IF NOT EXISTS test_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent reference
  suite_id UUID NOT NULL REFERENCES regression_suites(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- Metadata
  name TEXT NOT NULL,
  description TEXT,
  order_index INTEGER DEFAULT 0,

  -- Type classification
  flow_type TEXT DEFAULT 'ui' CHECK (flow_type IN ('ui', 'api', 'mixed')),

  -- Classification
  tags TEXT[] DEFAULT '{}',
  priority TEXT CHECK (priority IN ('critical', 'high', 'medium', 'low')),

  -- Test configuration
  preconditions JSONB DEFAULT '[]',
  expected_result TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_test_flows_suite
  ON test_flows(suite_id, order_index);

CREATE INDEX IF NOT EXISTS idx_test_flows_type
  ON test_flows(flow_type);

CREATE INDEX IF NOT EXISTS idx_test_flows_tags
  ON test_flows USING GIN(tags);

CREATE INDEX IF NOT EXISTS idx_test_flows_priority
  ON test_flows(priority) WHERE priority IS NOT NULL;

-- ============================================================================
-- TRIGGER: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_test_flows_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_test_flows_updated_at ON test_flows;
CREATE TRIGGER trigger_update_test_flows_updated_at
  BEFORE UPDATE ON test_flows
  FOR EACH ROW
  EXECUTE FUNCTION update_test_flows_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE test_flows ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_flows'
      AND policyname = 'Users can view own test flows'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own test flows" ON test_flows FOR SELECT USING (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_flows'
      AND policyname = 'Users can insert own test flows'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own test flows" ON test_flows FOR INSERT WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_flows'
      AND policyname = 'Users can update own test flows'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own test flows" ON test_flows FOR UPDATE USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_flows'
      AND policyname = 'Users can delete own test flows'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own test flows" ON test_flows FOR DELETE USING (user_id = auth.uid()::text)';
  END IF;
END $$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE test_flows IS 'Test flows within a suite (Happy path, Error handling)';
COMMENT ON COLUMN test_flows.flow_type IS 'Type of flow: ui, api, or mixed';
COMMENT ON COLUMN test_flows.order_index IS 'Execution order within the suite';
COMMENT ON COLUMN test_flows.preconditions IS 'JSON array of preconditions for this flow';
