-- ─────────────────────────────────────────────────────────────────────────────
-- Release-readiness report — ADR-0012
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive, nullable columns on regression_runs. The release verdict itself
-- (ready / ready_with_warnings / not_ready) is a free, always-on pure
-- function (release-verdict.util.ts) computed live on every report fetch —
-- it is NOT stored here. What IS stored is:
--   1. A frozen audit snapshot of the verdict at the moment the narrative
--      was first generated (release_verdict_at_completion +
--      release_verdict_ruleset_version) — lets a later ruleset version bump
--      be told apart from an actual data change when auditing what a
--      release approver was shown.
--   2. The cached optional LLM narrative itself (release_narrative, JSONB —
--      not TEXT: it has structured sub-fields, see ReleaseNarrative in
--      testing.types.ts) and its generation/charge markers.
-- 1:1 scalar-per-run relationship, unlike regression_doctor_findings'
-- many-per-run shape — plain ALTER TABLE, no new table.

ALTER TABLE regression_runs
  ADD COLUMN IF NOT EXISTS release_verdict_at_completion TEXT
    CHECK (release_verdict_at_completion IN ('ready', 'ready_with_warnings', 'not_ready')),
  ADD COLUMN IF NOT EXISTS release_verdict_ruleset_version SMALLINT,
  ADD COLUMN IF NOT EXISTS release_narrative JSONB,
  ADD COLUMN IF NOT EXISTS release_narrative_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS release_narrative_charged_at TIMESTAMPTZ;

COMMENT ON COLUMN regression_runs.release_verdict_at_completion IS
  'Frozen audit snapshot of the deterministic release verdict, written once at first narrative generation (see release-narrative.service.ts). May legitimately differ from a live recompute if RELEASE_VERDICT_RULESET_VERSION changed since — always cross-check against release_verdict_ruleset_version, never assume it still matches the current rule.';
COMMENT ON COLUMN regression_runs.release_verdict_ruleset_version IS
  'RELEASE_VERDICT_RULESET_VERSION (release-verdict.util.ts) at the time release_verdict_at_completion was written.';
COMMENT ON COLUMN regression_runs.release_narrative IS
  'Cached optional LLM narrative: { headline, prioritizedActions: [{bugId, why}], summary }. NULL = not yet generated (lazy, first-report-view-triggered), disabled, or the run is not yet terminal. Never contains a verdict field by design — see release-narrative-prompts.ts.';
COMMENT ON COLUMN regression_runs.release_narrative_charged_at IS
  'Idempotency marker for RELEASE_NARRATIVE_CREDITS, written BEFORE the credit deduction call (same ordering as ai-analysis.job.ts''s bugReportChargedAt) so a retry after a transient post-write failure never double-charges.';
