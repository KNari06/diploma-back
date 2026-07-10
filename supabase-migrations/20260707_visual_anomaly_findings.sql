-- ─────────────────────────────────────────────────────────────────────────────
-- Visual anomaly sweep — ADR-0012
-- ─────────────────────────────────────────────────────────────────────────────
-- Tracks a "common sense visual anomaly" (placeholder text, broken image,
-- structurally broken layout, ...) fingerprinted the same way
-- regression_doctor_findings tracks a drift pattern — but with a HARDER
-- gate: a single run's vision-LLM call can never flip `status` to
-- 'surfaced' by itself. Only once the SAME fingerprint has recurred across
-- >= VISUAL_ANOMALY_MIN_RECURRENCE independent runs (tracked via
-- affected_run_ids) does it become visible in a report. This is the actual
-- truthfulness mechanism — see visual-anomaly-check.service.ts.

CREATE TABLE IF NOT EXISTS visual_anomaly_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_case_id UUID NOT NULL REFERENCES intent_test_cases(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- SHA-1 hex of (test_case_id + screenshot_role + category). Deliberately
  -- excludes the free-text description, so wording drift across runs
  -- doesn't fracture one recurring issue into separate fingerprints.
  pattern_key TEXT NOT NULL,

  screenshot_role TEXT NOT NULL CHECK (screenshot_role IN ('final', 'failure')),
  category TEXT NOT NULL CHECK (category IN (
    'placeholder_text', 'broken_image', 'overlapping_cutoff_ui',
    'wrong_locale', 'structurally_broken_layout', 'other'
  )),
  description TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  example_screenshot_url TEXT NOT NULL,

  -- Recurrence tracking — the truthfulness gate.
  affected_run_ids UUID[] NOT NULL DEFAULT '{}',
  recurrence_count INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'below_threshold' CHECK (status IN (
    'below_threshold', 'surfaced', 'dismissed', 'resolved'
  )),

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS visual_anomaly_findings_project_pattern_key
  ON visual_anomaly_findings (project_id, pattern_key);
CREATE INDEX IF NOT EXISTS visual_anomaly_findings_test_case_id
  ON visual_anomaly_findings (test_case_id);
CREATE INDEX IF NOT EXISTS visual_anomaly_findings_surfaced
  ON visual_anomaly_findings (project_id, status, last_seen_at DESC) WHERE status = 'surfaced';

-- updated_at auto-touch trigger, same pattern as regression_doctor_findings.
CREATE OR REPLACE FUNCTION touch_visual_anomaly_findings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS visual_anomaly_findings_touch_updated_at ON visual_anomaly_findings;
CREATE TRIGGER visual_anomaly_findings_touch_updated_at
  BEFORE UPDATE ON visual_anomaly_findings
  FOR EACH ROW EXECUTE FUNCTION touch_visual_anomaly_findings_updated_at();

ALTER TABLE visual_anomaly_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own visual anomaly findings"
  ON visual_anomaly_findings FOR SELECT
  USING (user_id = auth.uid()::text);

CREATE POLICY "Users can insert own visual anomaly findings"
  ON visual_anomaly_findings FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can update own visual anomaly findings"
  ON visual_anomaly_findings FOR UPDATE
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can delete own visual anomaly findings"
  ON visual_anomaly_findings FOR DELETE
  USING (user_id = auth.uid()::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- Comments
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE visual_anomaly_findings IS
  'Cross-run recurrence tracking for the sampled visual anomaly sweep (ADR-0012). A finding only becomes visible (status=surfaced) once its fingerprint recurs across >= VISUAL_ANOMALY_MIN_RECURRENCE independent runs — a single run''s vision-LLM call can never surface a finding by itself.';
COMMENT ON COLUMN visual_anomaly_findings.pattern_key IS
  'SHA-1 hex of (test_case_id + screenshot_role + category). Deliberately excludes free-text description so wording drift does not fracture one recurring issue into separate fingerprints.';
COMMENT ON COLUMN visual_anomaly_findings.affected_run_ids IS
  'Distinct regression_runs.id this fingerprint was observed in, pruned to VISUAL_ANOMALY_RECURRENCE_WINDOW_DAYS. recurrence_count is denormalized from array_length(affected_run_ids, 1) for cheap filtering.';
COMMENT ON COLUMN visual_anomaly_findings.status IS
  'below_threshold -> surfaced is a ONE-WAY RATCHET once recurrence_count clears the threshold (never auto-reverts, so a finding does not disappear mid-investigation). dismissed/resolved are the only human-driven exits.';
