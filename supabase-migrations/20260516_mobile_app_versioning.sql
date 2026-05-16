-- Mobile app versioning + audit trail.
--
-- Before this migration:
--   * `mobile_app_builds` only got rows when the upload included git
--     metadata (CI path). Manual uploads from the UI never made it in,
--     so users couldn't tell which APK ran two weeks ago.
--   * No version_name / version_code anywhere — `package_name` was the
--     only stable identifier, which is the same string for every build.
--   * `test_executions` had no foreign key to the build that actually
--     ran, so an APK overwritten in storage took its audit trail with
--     it.
--
-- After:
--   * Every upload (manual + CI) inserts a `mobile_app_builds` row.
--   * `version_name` / `version_code` are nullable columns; the API
--     refuses uploads that don't supply at least one of them.
--   * `test_executions.mobile_app_build_id` is a soft FK — ON DELETE
--     SET NULL so pruning old builds (kept to last 10 per project +
--     platform) doesn't cascade-delete history rows.

-- ── 1. version columns on mobile_app_builds ──────────────────────────

ALTER TABLE mobile_app_builds
  ADD COLUMN IF NOT EXISTS version_name TEXT,
  ADD COLUMN IF NOT EXISTS version_code BIGINT;

COMMENT ON COLUMN mobile_app_builds.version_name IS
  'Human-readable app version (e.g. "1.2.3"). Free-form string supplied by the uploader. At least one of version_name/version_code must be present for new uploads.';
COMMENT ON COLUMN mobile_app_builds.version_code IS
  'Integer build code (Android versionCode / iOS CFBundleVersion). Optional alongside version_name.';

-- Helpful for "what versions has this project shipped" queries from the UI.
CREATE INDEX IF NOT EXISTS idx_mobile_app_builds_version
  ON mobile_app_builds (project_id, platform, version_code DESC NULLS LAST, uploaded_at DESC);

-- ── 2. test_executions audit linkage ─────────────────────────────────

ALTER TABLE test_executions
  ADD COLUMN IF NOT EXISTS mobile_app_build_id UUID
    REFERENCES mobile_app_builds(id) ON DELETE SET NULL;

COMMENT ON COLUMN test_executions.mobile_app_build_id IS
  'Build that was installed for this execution. ON DELETE SET NULL: pruning old builds preserves the execution row, even though the APK file is gone.';

-- Fast lookup: "show me every run that used build X".
CREATE INDEX IF NOT EXISTS idx_test_executions_mobile_app_build
  ON test_executions (mobile_app_build_id)
  WHERE mobile_app_build_id IS NOT NULL;

-- ── 3. regression_plans build pinning ────────────────────────────────
--
-- A plan can declare its preference for which APK its mobile runs use:
--   * 'latest' (default)  — resolver picks the newest build for the
--                           project + platform at dispatch time. Matches
--                           pre-existing behaviour for plans created
--                           before this column existed.
--   * 'pinned'            — `pinned_mobile_app_build_id` is honoured.
--                           If the pinned build was pruned, the resolver
--                           logs a warning and falls through to 'latest'
--                           (existing behaviour in resolveAppForRun).
--
-- The two-column shape (mode + id) keeps "user explicitly chose pinned
-- then later cleared it" distinguishable from "user never picked anything"
-- without overloading NULL semantics.

ALTER TABLE regression_plans
  ADD COLUMN IF NOT EXISTS mobile_build_mode TEXT NOT NULL DEFAULT 'latest'
    CHECK (mobile_build_mode IN ('latest', 'pinned')),
  ADD COLUMN IF NOT EXISTS pinned_mobile_app_build_id UUID
    REFERENCES mobile_app_builds(id) ON DELETE SET NULL;

COMMENT ON COLUMN regression_plans.mobile_build_mode IS
  'How to pick the APK for mobile tests in this plan. ''latest'' = newest build for project+platform at dispatch (default). ''pinned'' = use pinned_mobile_app_build_id, falling through to latest if the pinned build was pruned.';
COMMENT ON COLUMN regression_plans.pinned_mobile_app_build_id IS
  'Explicit build pin honoured when mobile_build_mode = ''pinned''. ON DELETE SET NULL so pruning a pinned build degrades gracefully to ''latest'' instead of breaking the plan.';

-- Partial index — only relevant for the ~minority of plans that pin.
CREATE INDEX IF NOT EXISTS idx_regression_plans_pinned_build
  ON regression_plans (pinned_mobile_app_build_id)
  WHERE pinned_mobile_app_build_id IS NOT NULL;
