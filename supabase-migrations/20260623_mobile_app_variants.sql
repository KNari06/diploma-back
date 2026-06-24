-- Named APK variants ("3 APKs of 1 app").
--
-- Until now a project had ONE active APK per platform: every upload landed
-- in the same lane, the newest winning at resolve time and older builds
-- pruned to the last 10. Teams that ship the same app in several flavors
-- (Production / Staging / Dev) had no way to keep them side by side.
--
-- A *variant* is a named lane of build history. "The active build of
-- variant X" = the newest `mobile_app_builds` row carrying that label.
-- This reuses the existing pruning + resolver machinery — the only new
-- concept is the label.
--
-- Backwards compatible by construction:
--   * `variant_label` defaults to 'default'; every existing row backfills
--     to it, so a resolve with no variant picks the same build as before.
--   * Pruning is now per (project, platform, variant_label) so a Staging
--     upload never evicts a Production build.
--   * `regression_plans.mobile_variant_label` is NULL (= default) for all
--     existing plans, so their runs are unchanged.

-- ── 1. variant_label on mobile_app_builds ────────────────────────────

ALTER TABLE mobile_app_builds
  ADD COLUMN IF NOT EXISTS variant_label TEXT NOT NULL DEFAULT 'default';

COMMENT ON COLUMN mobile_app_builds.variant_label IS
  'Named variant lane this build belongs to (e.g. "Production"/"Staging"/"default"). A variant groups many builds over time; the newest row per (project, platform, variant_label) is that variant''s active build. Version/app-name/mode are per-build columns, NOT encoded here — the label is stable across versions.';

-- Commit uniqueness is now PER VARIANT: the same git commit may be built
-- into more than one variant (one commit → Production APK AND Staging APK).
-- Replaces the old global (project, platform, commit_sha) unique index.
DROP INDEX IF EXISTS uniq_mobile_app_builds_commit;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mobile_app_builds_commit
  ON mobile_app_builds (project_id, platform, variant_label, commit_sha)
  WHERE commit_sha IS NOT NULL;

-- "latest build in this variant" — resolver orders by uploaded_at DESC
-- inside the (project, platform, variant_label) filter set.
CREATE INDEX IF NOT EXISTS idx_mobile_app_builds_variant_latest
  ON mobile_app_builds (project_id, platform, variant_label, uploaded_at DESC);

-- ── 2. regression_plans variant selection ────────────────────────────
--
-- A plan picks ONE variant for its mobile runs, applied to whichever
-- platform each test runs on. NULL = the platform's default variant
-- (preserves pre-existing behaviour). Composes with mobile_build_mode:
-- 'latest' picks the newest build IN the variant; 'pinned' still honours
-- pinned_mobile_app_build_id (an explicit build pin wins over the variant).

ALTER TABLE regression_plans
  ADD COLUMN IF NOT EXISTS mobile_variant_label TEXT;

COMMENT ON COLUMN regression_plans.mobile_variant_label IS
  'Variant lane this plan''s mobile runs resolve against (matched per platform at dispatch). NULL = default variant. mobile_build_mode/pinned_mobile_app_build_id still apply WITHIN the selected variant.';
