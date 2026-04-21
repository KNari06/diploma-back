-- ═══════════════════════════════════════════════════════════════════════════
-- REGRESSION DOCTOR APPLY SNAPSHOTS — one-version-back safety net for bulk apply
--
-- Phase-2 Slice B: the Bulk Apply flow mutates `intent_test_cases.steps_json`
-- in place. There is no general history table for intent_test_cases, so an
-- accidental wrong patch applied to 15 tests would be irreversible without
-- manual work. This table captures the pre-apply `steps_json` for every test
-- case touched by a Doctor-driven apply, so the UI (and a future rollback
-- endpoint) can show diff + revert the exact cells we wrote.
--
-- Why a separate table, not a column on intent_test_cases:
--   • Per-test-case, per-apply granularity — multiple applies to the same
--     test case accumulate as rows, each with its own finding_id.
--   • Snapshot payload can be large (JSONB steps blob); keeping it out of
--     the hot test-cases row avoids bloating every query that touches
--     intent_test_cases.
--   • Retention policy is different — we likely want to prune snapshots
--     after N days, but never prune test cases themselves.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS regression_doctor_apply_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which finding caused this apply. CASCADE so snapshots disappear when
  -- the finding is hard-deleted (same lifecycle semantics as the finding
  -- itself — if the run is gone, we don't keep orphan snapshots).
  finding_id UUID NOT NULL REFERENCES regression_doctor_findings(id) ON DELETE CASCADE,

  -- Which test case was patched. CASCADE because a deleted test case has
  -- nothing to revert to.
  test_case_id UUID NOT NULL REFERENCES intent_test_cases(id) ON DELETE CASCADE,

  -- Ownership — matches intent_test_cases user_id column type (TEXT, not UUID).
  user_id TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- ── Snapshot payload ─────────────────────────────────────────────────────
  -- The EXACT steps_json that was on the test case right before we wrote
  -- the patch. `before_updated_at` pins the version — if the user edits
  -- the test after apply, we still have the snapshot of what we wrote
  -- on top of.
  steps_before JSONB NOT NULL,
  before_updated_at TIMESTAMPTZ NOT NULL,

  -- The steps we wrote. Stored so the diff UI can compare without having
  -- to re-derive; also lets us detect "user edited since apply" by
  -- comparing current steps_json against this snapshot.
  steps_after JSONB NOT NULL,

  -- Human-readable note: "inserted step 7: click 'Solve captcha'".
  -- Generated server-side from the patch action + target — cheaper for
  -- the UI than re-rendering the diff every time.
  change_description TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Hot path: "show me all snapshots for this finding" — the review UI.
CREATE INDEX IF NOT EXISTS idx_doctor_apply_snapshots_finding
  ON regression_doctor_apply_snapshots(finding_id);

-- "Has this test case ever been touched by a Doctor apply?" — used
-- to warn users in the editor if they're about to overwrite an AI patch.
CREATE INDEX IF NOT EXISTS idx_doctor_apply_snapshots_test_case
  ON regression_doctor_apply_snapshots(test_case_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — owner-only access
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE regression_doctor_apply_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own apply snapshots"
  ON regression_doctor_apply_snapshots FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can insert own apply snapshots"
  ON regression_doctor_apply_snapshots FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

-- Deletion is intentionally NOT user-accessible — snapshots are immutable
-- history. If retention is needed later, it'll be a scheduled job using
-- the service-role key, not a user action.

COMMENT ON TABLE regression_doctor_apply_snapshots IS
  'Pre-apply steps_json snapshots captured by Bulk Apply. One row per (finding, test_case) pair.';
COMMENT ON COLUMN regression_doctor_apply_snapshots.before_updated_at IS
  'The intent_test_cases.updated_at observed at snapshot time. Used for optimistic concurrency detection on apply.';
COMMENT ON COLUMN regression_doctor_apply_snapshots.change_description IS
  'Server-generated human-readable note (e.g. "inserted step 7: click Solve captcha"). Backs the diff UI without client-side re-derivation.';
