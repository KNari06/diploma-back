-- ═══════════════════════════════════════════════════════════════════════════
-- REGRESSION DOCTOR — from cross-test drift patterns to per-step findings
--
-- The original table (20260420_regression_doctor_findings.sql) models a finding
-- as "one product change that broke N tests", keyed on a web-shaped triple
-- (url_pattern × target_element_key × error_shape) supplied by the Bug
-- Inspector's `driftSignals`. That input is never produced in practice — on web
-- `driftSignals` is always null, on mobile it degrades to "unknown" — so the
-- table has stayed empty since it shipped.
--
-- A finding now describes ONE failing step of ONE test case, located by the
-- step id recorded in `tests.executed_steps`. This migration adds that
-- addressing, plus the agent's verdict, and relaxes the two columns whose
-- producer no longer exists.
--
-- Additive and non-destructive: no column is dropped, no row is rewritten.
-- Existing rows (if any environment has some) keep working — they get
-- `verdict = 'test_fix'`, which is what a legacy drift finding meant.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Step addressing + verdict
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE regression_doctor_findings
  -- The single test case this finding targets. `affected_test_ids` stays as the
  -- authoritative apply list (a patch may fit the same step of several cases);
  -- this is the one the evidence came from, and what the UI deep-links to.
  ADD COLUMN IF NOT EXISTS test_case_id UUID REFERENCES intent_test_cases(id) ON DELETE CASCADE,

  -- `intent_test_cases.steps_json[].id`. TEXT, not UUID: authored ids are
  -- arbitrary strings — recorded steps use a UUID, agent drafts use
  -- `d_<draftId>:step-<n>`, inlined preconditions use `pre_<src>_<id>`.
  ADD COLUMN IF NOT EXISTS step_id TEXT,

  -- 0-based position of that step at the time of analysis. Display only — apply
  -- resolves by `step_id` and refuses to guess by position, because the index
  -- from one test case means nothing in another.
  ADD COLUMN IF NOT EXISTS step_index INTEGER,

  -- 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter'. Mirrors
  -- `intent_test_cases.platform`; lets the UI and the apply path pick
  -- platform-correct behaviour without a join.
  ADD COLUMN IF NOT EXISTS platform TEXT,

  -- What the agent concluded. Only 'test_fix' ever carries a proposed_patch;
  -- the other two are read-only diagnoses shown without an Apply button.
  ADD COLUMN IF NOT EXISTS verdict TEXT NOT NULL DEFAULT 'test_fix'
    CHECK (verdict IN ('test_fix', 'app_bug', 'unclear')),

  -- What the agent was looking at, denormalized at analysis time:
  --   { test_case_name, step_type, step_description, action, failed_reason,
  --     failure_explanation, fail_screenshot_url, prior_screenshot_url }
  --
  -- Denormalized on purpose. The run report is a historical document — it
  -- should show the step as it failed that night, not as it looks after
  -- somebody edited it. It also lets the panel render a complete card from the
  -- findings query alone, with no join back to `intent_test_cases` and no
  -- second round-trip for the screenshot.
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Relax the columns whose producer is gone
--
-- `url_pattern` was NOT NULL because every finding was a web URL pattern.
-- Mobile has no URL, and a per-step finding does not need one.
--
-- `error_shape` was a NOT NULL four-value CHECK fed by `driftSignals.errorShape`.
-- Nothing produces that taxonomy any more; the finding's meaning now lives in
-- `verdict` plus the runtime `failedReason` carried inside the evidence. The
-- column is kept (not dropped) so legacy rows stay readable and so a future
-- classification can reuse it without another migration.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE regression_doctor_findings
  ALTER COLUMN url_pattern DROP NOT NULL,
  ALTER COLUMN error_shape DROP NOT NULL;

-- The CHECK is dropped by lookup rather than by name. The table was created
-- with `CREATE TABLE IF NOT EXISTS` and the constraint was declared inline, so
-- its generated name is `regression_doctor_findings_error_shape_check` in a
-- clean environment but could carry a `_check1` suffix in one where an earlier
-- variant of the table existed. A hardcoded `DROP CONSTRAINT IF EXISTS` would
-- silently no-op there and leave inserts failing on the old four-value list.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  FOR con_name IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'regression_doctor_findings'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%error_shape%'
  LOOP
    EXECUTE format('ALTER TABLE regression_doctor_findings DROP CONSTRAINT %I', con_name);
    RAISE NOTICE 'Dropped error_shape check constraint: %', con_name;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Index
--
-- "Does this test case have an open finding?" — asked by the run report when
-- rendering a test row, and by the editor deep-link target. Partial on
-- status='open' for the same reason as the existing project index: resolved
-- findings are the vast majority and never queried this way.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_regression_doctor_findings_test_case_open
  ON regression_doctor_findings(test_case_id)
  WHERE status = 'open';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Comments
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN regression_doctor_findings.test_case_id IS
  'The intent_test_cases row this finding was derived from. affected_test_ids remains the authoritative apply list.';
COMMENT ON COLUMN regression_doctor_findings.step_id IS
  'intent_test_cases.steps_json[].id of the failing step. Arbitrary string, NOT a uuid. Apply matches on this exactly and skips when absent.';
COMMENT ON COLUMN regression_doctor_findings.step_index IS
  'Display-only position of the step at analysis time. Never used to locate the step — an index does not transfer between test cases.';
COMMENT ON COLUMN regression_doctor_findings.evidence IS
  'Denormalized snapshot of what the agent analyzed: test case name, step type/description, failedReason, failureExplanation, screenshot URLs. Historical by design — the run report shows the step as it failed, not as it looks now.';
COMMENT ON COLUMN regression_doctor_findings.verdict IS
  'test_fix = the test is wrong and proposed_patch fixes it; app_bug = the application misbehaved, do not touch the test; unclear = insufficient evidence. Only test_fix carries a patch.';
COMMENT ON COLUMN regression_doctor_findings.error_shape IS
  'Legacy drift taxonomy from the Bug Inspector driftSignals. No longer produced; nullable since 20260813. Superseded by verdict.';
