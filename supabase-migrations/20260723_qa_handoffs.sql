-- ============================================================================
-- QA HANDOFFS — structured hand-off artifact per (project, issue)
-- ============================================================================
-- Persists the QA readiness assessment as a STRUCTURED artifact the next
-- pipeline stage reads instead of parsing chat. Produced at assess-time
-- (possibly before any test run exists), then updated post-run with status +
-- the fix-prompt reference. One row per (project_id, issue_key) — re-assessing
-- a ticket upserts.
-- ============================================================================

CREATE TABLE IF NOT EXISTS qa_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Project this handoff belongs to (drives access via project ownership/membership).
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Source task tracker reference (Jira today; issue_key is the tracker key).
  issue_key TEXT NOT NULL,
  cloud_id TEXT,

  -- Honest status: ready | empty | blocked | skipped | in_progress | done.
  status TEXT NOT NULL DEFAULT 'blocked' CHECK (status IN (
    'ready', 'empty', 'blocked', 'skipped', 'in_progress', 'done'
  )),

  -- Full QaHandoff artifact (groundTruth, readiness, suggestedBranches, refs).
  handoff JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- Linked run once dispatched (nullable — set at run time).
  test_id UUID,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- One handoff per project+issue; re-assessment upserts.
  CONSTRAINT unique_project_issue UNIQUE (project_id, issue_key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_qa_handoffs_project_id ON qa_handoffs(project_id);
CREATE INDEX IF NOT EXISTS idx_qa_handoffs_status ON qa_handoffs(status);

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE qa_handoffs ENABLE ROW LEVEL SECURITY;

-- Read/write scoped to projects the user owns. (Service role bypasses via its
-- own policy below; the backend writes through the service key.)
CREATE POLICY qa_handoffs_select_policy ON qa_handoffs
  FOR SELECT
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE POLICY qa_handoffs_insert_policy ON qa_handoffs
  FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE POLICY qa_handoffs_update_policy ON qa_handoffs
  FOR UPDATE
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE POLICY qa_handoffs_service_role_policy ON qa_handoffs
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- updated_at trigger
-- ============================================================================
CREATE OR REPLACE FUNCTION update_qa_handoffs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_qa_handoffs_updated_at ON qa_handoffs;
CREATE TRIGGER update_qa_handoffs_updated_at
  BEFORE UPDATE ON qa_handoffs
  FOR EACH ROW
  EXECUTE FUNCTION update_qa_handoffs_updated_at();

COMMENT ON TABLE qa_handoffs IS 'Structured QA hand-off artifact per (project, issue) — honest status + readiness + branches, read by the next pipeline stage instead of chat';
