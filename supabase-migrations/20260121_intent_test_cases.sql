-- ============================================================================
-- INTENT TEST CASES TABLE
-- ============================================================================
-- User-authored test cases with intent-based steps
-- Used by step editor for creating tests from scratch
-- ============================================================================

-- Intent Test Cases Table
CREATE TABLE IF NOT EXISTS intent_test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- Metadata
  name TEXT NOT NULL,
  description TEXT,
  start_url TEXT NOT NULL,

  -- Steps stored as JSON array
  -- Structure: Array of IntentStep objects
  -- Each step has: id, type, description, value?, options?, bindingHints?, evidence?
  steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Ensure timestamps are non-null (safe backfill for existing rows)
UPDATE intent_test_cases
SET
  created_at = COALESCE(created_at, NOW()),
  updated_at = COALESCE(updated_at, NOW())
WHERE created_at IS NULL OR updated_at IS NULL;

ALTER TABLE intent_test_cases
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Fast lookup by project
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_project
  ON intent_test_cases(project_id);

-- Fast lookup by user
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_user
  ON intent_test_cases(user_id);

-- Combined lookup
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_project_user
  ON intent_test_cases(project_id, user_id);

-- Order by updated
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_updated
  ON intent_test_cases(updated_at DESC);

-- ============================================================================
-- TRIGGER: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_intent_test_cases_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_intent_test_cases_updated_at ON intent_test_cases;
CREATE TRIGGER trigger_update_intent_test_cases_updated_at
  BEFORE UPDATE ON intent_test_cases
  FOR EACH ROW
  EXECUTE FUNCTION update_intent_test_cases_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE intent_test_cases ENABLE ROW LEVEL SECURITY;

-- Users can only see their own test cases
CREATE POLICY "Users can view own intent test cases"
  ON intent_test_cases FOR SELECT
  USING (user_id = auth.uid()::text);

-- Users can only insert their own test cases
CREATE POLICY "Users can insert own intent test cases"
  ON intent_test_cases FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

-- Users can only update their own test cases
DROP POLICY IF EXISTS "Users can update own intent test cases" ON intent_test_cases;
CREATE POLICY "Users can update own intent test cases"
  ON intent_test_cases FOR UPDATE
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- Users can only delete their own test cases
CREATE POLICY "Users can delete own intent test cases"
  ON intent_test_cases FOR DELETE
  USING (user_id = auth.uid()::text);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE intent_test_cases IS 'User-authored intent-based test cases for step editor';
COMMENT ON COLUMN intent_test_cases.steps_json IS 'Array of IntentStep objects with id, type, description, value, bindingHints, evidence';
