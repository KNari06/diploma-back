-- ============================================================================
-- INTENT TEST CASES UNIFICATION MIGRATION
-- ============================================================================
-- Purpose: Make intent_test_cases the single source of truth for UI test cases.
-- Adds all replay/regression fields from saved_test_cases; adds status column.
-- Drops saved_test_case_id FK, relaxes start_url requirement.
-- ============================================================================

-- 1) Add status column for lifecycle management
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived'));

-- 2) Add classification (standalone vs regression member)
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'standalone'
    CHECK (kind IN ('standalone', 'regression_member'));

-- 3) Add replay strategy and data columns
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS replay_strategy TEXT DEFAULT 'commands'
    CHECK (replay_strategy IN ('commands', 'graph_extract'));

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS commands JSONB;

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS graph_ref JSONB;

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS parameters_schema JSONB;

-- 4) Add url column for regression/tree usage (fallback from start_url)
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS url TEXT;

-- 5) Make start_url nullable (flow-created placeholders may not have URL)
ALTER TABLE intent_test_cases
  ALTER COLUMN start_url DROP NOT NULL;

-- 6) Add dependency tracking (array of intent_test_cases IDs)
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS depends_on UUID[] DEFAULT '{}';

-- 7) Add metadata fields for parity with saved_test_cases
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS priority TEXT
    CHECK (priority IS NULL OR priority IN ('critical', 'high', 'medium', 'low'));

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS preconditions TEXT[] DEFAULT '{}';

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS setup_steps JSONB DEFAULT '[]'::jsonb;

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS teardown_steps JSONB DEFAULT '[]'::jsonb;

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS expected_result TEXT;

-- 8) Add provenance fields (for save-from-test flow)
ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS source_test_id UUID REFERENCES tests(id) ON DELETE SET NULL;

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS source_intelligent_session_id UUID REFERENCES intelligent_test_sessions(id) ON DELETE SET NULL;

-- 9) Drop the saved_test_case_id column and its FK (no longer needed)
ALTER TABLE intent_test_cases
  DROP CONSTRAINT IF EXISTS intent_test_cases_saved_test_case_id_fkey;

ALTER TABLE intent_test_cases
  DROP COLUMN IF EXISTS saved_test_case_id;

-- ============================================================================
-- INDEXES for new columns
-- ============================================================================

-- Status-based filtering (draft vs published)
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_status
  ON intent_test_cases(status);

-- Combined lookup for tree/flow queries: flow + user + status
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_flow_user_status
  ON intent_test_cases(flow_id, user_id, status);

-- Kind-based filtering
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_kind
  ON intent_test_cases(kind, project_id);

-- Source test lookup (for finding derived test cases)
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_source_test
  ON intent_test_cases(source_test_id)
  WHERE source_test_id IS NOT NULL;

-- ============================================================================
-- COMMENTS for documentation
-- ============================================================================

COMMENT ON COLUMN intent_test_cases.status IS 'Lifecycle status: draft (editing), published (ready for regression), archived (hidden)';
COMMENT ON COLUMN intent_test_cases.kind IS 'Classification: standalone (independent test) or regression_member (part of a flow/suite)';
COMMENT ON COLUMN intent_test_cases.replay_strategy IS 'Preferred replay method: commands (executable) or graph_extract (needs conversion)';
COMMENT ON COLUMN intent_test_cases.commands IS 'Executable Playwright commands for replay';
COMMENT ON COLUMN intent_test_cases.graph_ref IS 'Fallback: minimal step reference from graph_data';
COMMENT ON COLUMN intent_test_cases.parameters_schema IS 'JSON schema for runtime parameters (e.g., passwords)';
COMMENT ON COLUMN intent_test_cases.url IS 'Target URL for regression/tree (fallback from start_url)';
COMMENT ON COLUMN intent_test_cases.depends_on IS 'Array of intent_test_cases IDs this test depends on';
COMMENT ON COLUMN intent_test_cases.tags IS 'User-defined tags for categorization';
COMMENT ON COLUMN intent_test_cases.priority IS 'Test priority: critical, high, medium, low';
COMMENT ON COLUMN intent_test_cases.preconditions IS 'List of preconditions that must be met';
COMMENT ON COLUMN intent_test_cases.setup_steps IS 'Steps to run before the main test';
COMMENT ON COLUMN intent_test_cases.teardown_steps IS 'Steps to run after the main test';
COMMENT ON COLUMN intent_test_cases.expected_result IS 'Expected outcome description';
COMMENT ON COLUMN intent_test_cases.source_test_id IS 'Original test ID if saved from a completed test';
COMMENT ON COLUMN intent_test_cases.source_intelligent_session_id IS 'Original intelligent session ID if saved from intelligent test';

-- ============================================================================
-- SUCCESS
-- ============================================================================
