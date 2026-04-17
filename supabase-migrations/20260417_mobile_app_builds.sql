-- Phase 5: mobile_app_builds — APK / IPA version history keyed by git metadata.
--
-- Until now, each `POST /api/v1/mobile/projects/:id/app` (and the CI variant)
-- overwrote `projects.settings.mobileApp`. That's fine when you have one
-- build at a time and run tests against it manually, but regression runs
-- triggered by a git webhook on a feature branch need the APK built FROM
-- that feature branch — not whatever main shipped yesterday.
--
-- This table sits alongside the legacy JSONB field, never replaces it.
-- `project.settings.mobileApp` continues to store "the latest upload,
-- unscoped". The resolver falls back to it when no versioned build
-- matches the run context, so existing customers (who never set
-- branch/commit) are unaffected.
--
-- Lookup patterns the resolver needs:
--   (1) "exact APK for this commit"  → unique (project, platform, commit_sha)
--   (2) "latest APK on this branch"  → (project, platform, branch) order by uploaded_at desc
--   (3) "latest APK anywhere"        → last row for (project, platform)
-- All three are satisfied by the indexes below.

CREATE TABLE IF NOT EXISTS mobile_app_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id UUID,
  uploaded_by UUID,   -- users.id of the human uploader (NULL for CI)

  -- Platform (mirrors intent_test_cases.platform enum, minus 'web')
  platform TEXT NOT NULL
    CHECK (platform IN ('android', 'ios', 'flutter', 'react_native')),

  -- Git metadata — ALL optional. A row with none of these is effectively
  -- "untagged" and only wins as a global fallback. In the typical flow a
  -- CI pipeline uploads with branch + commit_sha; manual uploads from the
  -- UI start empty.
  branch TEXT,
  commit_sha TEXT,
  build_number TEXT,   -- CI build id / job number (free-form)
  ci_run_id TEXT,      -- optional CI run reference for audit

  -- APK / IPA metadata — same shape as the legacy MobileAppMetadata so the
  -- resolver can return either without a mapper.
  storage_path TEXT NOT NULL,
  public_url TEXT NOT NULL,
  original_name TEXT NOT NULL,
  package_name TEXT,
  file_size BIGINT NOT NULL DEFAULT 0,

  -- Provenance
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'ci', 'webhook')),
  notes TEXT,

  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast "give me the build for this exact commit" lookup.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mobile_app_builds_commit
  ON mobile_app_builds (project_id, platform, commit_sha)
  WHERE commit_sha IS NOT NULL;

-- Fast "latest build on this branch" — resolver orders by uploaded_at DESC
-- inside the filter set, so a plain index on (project, platform, branch)
-- plus uploaded_at is enough.
CREATE INDEX IF NOT EXISTS idx_mobile_app_builds_branch_latest
  ON mobile_app_builds (project_id, platform, branch, uploaded_at DESC)
  WHERE branch IS NOT NULL;

-- General history pagination / "what have we ever uploaded for this project".
CREATE INDEX IF NOT EXISTS idx_mobile_app_builds_history
  ON mobile_app_builds (project_id, platform, uploaded_at DESC);

COMMENT ON TABLE mobile_app_builds IS
  'APK/IPA upload history keyed by git metadata. Resolver picks the right build for a run based on trigger context (commit > branch > legacy project.settings.mobileApp).';
COMMENT ON COLUMN mobile_app_builds.source IS
  'manual = human upload from UI, ci = POST /mobile/ci/run, webhook = auto-pulled after a git push event.';
COMMENT ON COLUMN mobile_app_builds.branch IS
  'Git branch this build was produced from (e.g. "feat-login"). NULL = untagged.';
