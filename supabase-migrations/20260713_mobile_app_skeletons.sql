-- mobile_app_skeletons — a durable, per-app map of the screens an exploration
-- discovered and how they connect.
--
-- WHY THIS EXISTS
-- The mobile explorer builds a rich screen graph every run (screens keyed by a
-- stable fingerprint, navigable transitions between them, and the test
-- scenarios each screen affords) and ships it to the backend inside the result
-- snapshot as `mobile.graph`. Today the ingestion job fetches that snapshot and
-- keeps only the discovered test cases — the graph is discarded. So a later
-- request ("test the checkout in this app", "how does login work here") has no
-- stored structure to consult and the agent must re-crawl from zero.
--
-- This table gives that graph a durable home, MERGED across runs of the same
-- app, so it can be read back to brief an agent or seed a directed run.
--
-- SCOPE / KEY
-- Keyed (project_id, platform, package_name) — the same identity the mobile
-- build + variant tables use. The runner is app-only (no project concept); the
-- backend owns project/workspace scoping, so the skeleton lives here, one row
-- per app under test per project. `platform` uses the intent_test_cases enum
-- form (mobile_android | mobile_ios | mobile_flutter), NOT the bare
-- mobile_app_builds form, because a skeleton is a test-case-space concept.
--
-- IT IS A PRIOR, NOT TRUTH. The live crawl always wins; a stored screen that an
-- app update moved simply reads as "new" next run. `fingerprint_version` records
-- the algorithm version the stored graph was keyed with — on a bump the merge
-- discards the old graph and rebuilds rather than mixing incompatible keys.
--
-- Server-owned: written by the exploration ingestion job (service role), read
-- by backend services (chat mobile_agent brief, resolver) — never queried
-- directly by clients. All real access is service-role (RLS bypassed), so the
-- SELECT policy is defense-in-depth only. It is OWNER-ONLY (auth.uid()) by
-- deliberate repo convention (see 20260429_test_case_chat.sql: "RLS does not
-- have cheap access to workspace_members joins") — workspace-member access is
-- enforced at the APPLICATION layer instead (AppSkeletonService.getAppModel →
-- hasProjectAccess: owner OR workspace member), not in this policy.

CREATE TABLE IF NOT EXISTS mobile_app_skeletons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership / key
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL
    CHECK (platform IN ('mobile_android', 'mobile_ios', 'mobile_flutter')),
  package_name TEXT NOT NULL,          -- the app id / bundle (runner's appId)

  -- Identity guard: the fingerprint algorithm version the graph was keyed with.
  fingerprint_version INTEGER NOT NULL,

  -- The graph, mirroring the wire shape (mobile.graph):
  --   screens:     [{ fingerprint, name, purpose?, isTerminal?, visitCount,
  --                   scenarios: [{ name, kind, status }] }]
  --   transitions: [{ from, to, action, description }]
  -- JSONB blobs — this is a navigation + scenario MAP, not a replay map
  -- (the wire edges drop the replayable IntentStep; replay lives in the
  -- discovered test cases' steps_json). Kept denormalised: it is read whole,
  -- never queried by inner field.
  screens JSONB NOT NULL DEFAULT '[]'::jsonb,
  transitions JSONB NOT NULL DEFAULT '[]'::jsonb,
  root_fingerprint TEXT,

  -- Cross-run rollups, useful for the agent brief without loading the graph.
  domain_guess TEXT,
  screen_count INTEGER NOT NULL DEFAULT 0,
  run_count INTEGER NOT NULL DEFAULT 0,       -- how many runs merged in
  best_coverage_score INTEGER NOT NULL DEFAULT 0,
  last_run_id TEXT,                            -- runner runId of the last merge

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One skeleton per app per project.
  UNIQUE (project_id, platform, package_name)
);

-- The only lookup: "the skeleton for this app in this project".
CREATE INDEX IF NOT EXISTS idx_mobile_app_skeletons_key
  ON mobile_app_skeletons(project_id, platform, package_name);

-- RLS — owner-only SELECT (defense-in-depth; the app layer does the real
-- owner-OR-member gate, per the header). Service role does all writes.
ALTER TABLE mobile_app_skeletons ENABLE ROW LEVEL SECURITY;

-- DROP-then-CREATE so the migration is idempotent on replay (mirrors the newer
-- 20260429_test_case_chat convention; the table itself is IF NOT EXISTS).
DROP POLICY IF EXISTS mas_project_owner_read ON mobile_app_skeletons;
CREATE POLICY mas_project_owner_read
  ON mobile_app_skeletons FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = mobile_app_skeletons.project_id
        -- projects.user_id is TEXT in this schema, so auth.uid() (uuid) MUST be
        -- cast or the whole migration fails with "operator does not exist:
        -- text = uuid". Same convention as project_kb_chunks and
        -- mobile_test_results.
        AND p.user_id = (auth.uid())::text
    )
  );

DROP POLICY IF EXISTS mas_service_manage ON mobile_app_skeletons;
CREATE POLICY mas_service_manage
  ON mobile_app_skeletons FOR ALL
  USING (true)
  WITH CHECK (true);
