-- ═══════════════════════════════════════════════════════════════════════════
-- REGRESSION DOCTOR FINDINGS — per-run drift pattern aggregation
--
-- Purpose: the Regression Doctor job runs AFTER a regression run completes,
-- reads every test_results.ai_summary produced by the per-test Bug Inspector,
-- and aggregates failures with failureClassification='test_drift' + the same
-- driftSignals shape into grouped "findings". Each finding represents ONE
-- product change that affects N tests.
--
-- Why a separate table (not writing into regression_runs.summary):
--   • Multiple findings per run (one per drift pattern)
--   • Lifecycle per finding (applied / dismissed / resolved)
--   • Direct lookup "which tests are affected by pattern X?"
--   • Indexed by pattern_key so repeat drifts across runs are searchable
--
-- Companion to:
--   • test_results.ai_summary (feeds this table — driftSignals per-test)
--   • regression_runs (lifecycle parent — CASCADE on delete)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- regression_doctor_findings — one row per detected drift pattern
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS regression_doctor_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent regression run. CASCADE so findings disappear with the run.
  run_id UUID NOT NULL REFERENCES regression_runs(id) ON DELETE CASCADE,

  -- Ownership — matches regression_runs conventions (user_id TEXT, project UUID)
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- ── Grouping key ──────────────────────────────────────────────────────────
  -- Deterministic hash of (url_pattern + target_element_key + error_shape).
  -- Computed by the job in TS (SHA-1 hex, 40 chars) so the aggregator can
  -- ask "has this exact pattern been seen before?" across runs without an
  -- expensive 3-column index scan.
  pattern_key TEXT NOT NULL,

  -- Component fields of the pattern_key (stored separately for UI display +
  -- filtering without unpacking the hash).
  url_pattern TEXT NOT NULL,
  target_element_key TEXT,             -- nullable: some drifts are page-level (e.g. 404)
  error_shape TEXT NOT NULL CHECK (error_shape IN (
    'selector_not_found',
    'timeout_on_visible',
    'covered_by_overlay',
    'value_mismatch'
  )),

  -- ── LLM output ────────────────────────────────────────────────────────────
  -- One-paragraph human-readable explanation ("Login page added captcha").
  diagnosis TEXT NOT NULL,

  -- 0.00–1.00 LLM self-confidence. Used to decide whether to auto-apply
  -- (future phase) or only surface as suggestion.
  confidence NUMERIC(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  -- Structured patch the agent recommends:
  --   { action: 'insert_before'|'replace_selector'|'delete_step'|'update_value',
  --     target_step_index?: number,
  --     insert_step?: IntentStep,
  --     new_selector?: string,
  --     reason: string }
  proposed_patch JSONB,

  -- Which KB chunks informed the diagnosis (traceability). Array of
  -- { file_name, content_preview, similarity } so the UI can cite sources.
  kb_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ── Affected tests ────────────────────────────────────────────────────────
  -- All test_cases referencing the same (url_pattern + target_element_key).
  -- Includes tests that failed this run AND tests that haven't run yet
  -- (proactive — they'd fail next time they execute).
  affected_test_ids UUID[] NOT NULL DEFAULT '{}',

  -- 3 sample failures (test_result ids) for the UI to show evidence. Larger
  -- sets cause pager bloat in the report; 3 is enough to convince the user.
  example_test_result_ids UUID[] NOT NULL DEFAULT '{}',

  -- ── Lifecycle ─────────────────────────────────────────────────────────────
  -- open        — awaiting user decision (default)
  -- applied     — user accepted; patch pushed to test cases
  -- dismissed   — user rejected; reason recorded
  -- resolved    — marked resolved without apply (e.g. side-channel fix)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'applied', 'dismissed', 'resolved'
  )),
  applied_at TIMESTAMPTZ,
  applied_by TEXT,                     -- user_id who applied
  dismissed_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Hot path: "give me findings for this run" — opened from the run report UI.
CREATE INDEX IF NOT EXISTS idx_regression_doctor_findings_run
  ON regression_doctor_findings(run_id);

-- Secondary: "open findings in this project" — dashboard alerts / bulk view.
-- Partial index because the vast majority of findings will be resolved;
-- indexing only the active ones keeps the hot tuple fraction small.
CREATE INDEX IF NOT EXISTS idx_regression_doctor_findings_project_open
  ON regression_doctor_findings(project_id, created_at DESC)
  WHERE status = 'open';

-- Pattern recurrence: "has this exact drift been seen before in this project?"
-- Powers "this is the 3rd time the login captcha broke tests" telemetry.
CREATE INDEX IF NOT EXISTS idx_regression_doctor_findings_pattern
  ON regression_doctor_findings(project_id, pattern_key);

-- Affected-tests reverse lookup: "is test T currently under any open
-- finding?" — used by the editor to show a warning before the user runs
-- a test that's flagged by an unresolved drift.
CREATE INDEX IF NOT EXISTS idx_regression_doctor_findings_affected_tests
  ON regression_doctor_findings USING GIN (affected_test_ids)
  WHERE status = 'open';

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-update updated_at on every mutation
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_regression_doctor_findings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_regression_doctor_findings_updated_at
  ON regression_doctor_findings;
CREATE TRIGGER trigger_regression_doctor_findings_updated_at
  BEFORE UPDATE ON regression_doctor_findings
  FOR EACH ROW EXECUTE FUNCTION update_regression_doctor_findings_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — owner-only access
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE regression_doctor_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own doctor findings"
  ON regression_doctor_findings FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can insert own doctor findings"
  ON regression_doctor_findings FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can update own doctor findings"
  ON regression_doctor_findings FOR UPDATE
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can delete own doctor findings"
  ON regression_doctor_findings FOR DELETE
  USING (user_id = auth.uid()::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- Comments
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE regression_doctor_findings IS
  'Aggregated drift patterns produced by the Regression Doctor job after a regression run completes. Groups per-test Bug Inspector driftSignals into one finding per product change.';
COMMENT ON COLUMN regression_doctor_findings.pattern_key IS
  'SHA-1 hex of (url_pattern + target_element_key + error_shape). Lets the aggregator dedupe patterns within a run and track recurrence across runs.';
COMMENT ON COLUMN regression_doctor_findings.proposed_patch IS
  'Structured patch suggestion: { action, target_step_index?, insert_step?, new_selector?, reason }. Consumed by the Bulk Fix UI (future phase).';
COMMENT ON COLUMN regression_doctor_findings.kb_evidence IS
  'Array of KB chunks that supported the diagnosis, so the UI can cite "according to your release_notes_v2.3.pdf".';
COMMENT ON COLUMN regression_doctor_findings.affected_test_ids IS
  'All test_cases referencing the same (url_pattern + target_element_key) — includes tests that havent failed yet but would on next run.';
COMMENT ON COLUMN regression_doctor_findings.example_test_result_ids IS
  'Up to 3 sample test_result rows (real failures) for the UI to show evidence without pagination bloat.';
