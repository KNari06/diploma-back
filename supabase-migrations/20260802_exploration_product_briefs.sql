-- exploration_product_briefs — the Phase 0 ProductBrief, reused across runs.
--
-- WHY: Phase 0 derives the brief per RUN. Measured on prod (2026-08-02): 69% of
-- exploration runs target a URL the system has already explored, and one URL has
-- been run 7 times. So more than two thirds of runs re-fetch the same evidence,
-- re-spend an LLM call deriving the same understanding, and — worse — may
-- re-ask the user the same ≤3 questions they already answered. The ask budget
-- is meant to be per PRODUCT, not per run.
--
-- Keyed by (project_id, origin). Origin, not full URL: `acme.com/login` and
-- `acme.com/pricing` are the same product, and a brief describes the product.
-- Project-scoped like mobile_app_skeletons — a brief carries a user's answers
-- about THEIR environment ("staging, payments are fine"), which must never leak
-- across projects.
--
-- STALENESS is an evidence fingerprint, not a TTL. A time limit is the wrong
-- rule in both directions: a brief for a product that has not changed is still
-- correct after a month, and a brief for a product that pivoted is wrong after
-- an hour. `evidence_fingerprint` hashes what the collector actually read, so
-- the brief is re-derived exactly when the source material changed.
--
-- USER ANSWERS OUTLIVE THE FINGERPRINT. `user_answers` is stored separately
-- from the derived brief because the two have different lifetimes: a homepage
-- rewrite invalidates what the ANALYST inferred, but not what the USER told us
-- about their own environment. On a re-derive the stored answers are re-applied,
-- so a user who said "this is staging" is not asked again every time marketing
-- edits the landing page.
--
-- Read + written by backend services only (service-role, RLS bypassed). The
-- SELECT policy is owner-only defense-in-depth, matching the deliberate repo
-- convention in 20260713_mobile_app_skeletons.sql — workspace-member access is
-- enforced in the application layer, not here.

CREATE TABLE IF NOT EXISTS exploration_product_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Key
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,                    -- scheme + host + port, no path

  -- Identity guard: the brief schema version this row was written with, so a
  -- shape change re-derives instead of feeding stale fields to the agents.
  brief_version INTEGER NOT NULL,

  -- Staleness guard: a hash of the evidence the analyst actually read.
  evidence_fingerprint TEXT,

  -- The normalized ProductBrief, whole. Read as one object, never queried by
  -- inner field — same reasoning as mobile_app_skeletons' graph blobs.
  brief JSONB NOT NULL,

  -- Answers the USER gave, kept apart from the derived brief so they survive a
  -- re-derive. Shape: [{ key, answer }].
  user_answers JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Rollups, useful without loading the brief.
  reuse_count INTEGER NOT NULL DEFAULT 0,  -- how many runs read this row
  last_exploration_id TEXT,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One brief per product per project.
  UNIQUE (project_id, origin)
);

-- The only lookup: "the brief for this origin in this project".
CREATE INDEX IF NOT EXISTS idx_exploration_product_briefs_key
  ON exploration_product_briefs(project_id, origin);

ALTER TABLE exploration_product_briefs ENABLE ROW LEVEL SECURITY;

-- DROP-then-CREATE so the migration is idempotent on replay.
DROP POLICY IF EXISTS "Users can view briefs for their projects" ON exploration_product_briefs;
CREATE POLICY "Users can view briefs for their projects"
  ON exploration_product_briefs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = exploration_product_briefs.project_id
        -- projects.user_id is TEXT in this schema, so auth.uid() (uuid) MUST be
        -- cast or the policy fails to create with "operator does not exist:
        -- text = uuid". Same trap documented in 20260713_mobile_app_skeletons.
        AND p.user_id = (auth.uid())::text
    )
  );

COMMENT ON TABLE exploration_product_briefs IS
  'Phase 0 ProductBrief per (project, origin), reused across exploration runs. Re-derived when evidence_fingerprint changes; user_answers survive the re-derive.';
COMMENT ON COLUMN exploration_product_briefs.evidence_fingerprint IS
  'Hash of the evidence the collector read. Staleness is content-based, not time-based: an unchanged product does not need a new brief, a pivoted one does.';
COMMENT ON COLUMN exploration_product_briefs.user_answers IS
  'What the USER answered ([{key, answer}]). Stored apart from the derived brief because a content change invalidates what the analyst inferred, not what the user stated about their own environment.';
