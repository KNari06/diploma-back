-- Migration: Mobile-specific regression orchestration tables.
--
-- Why this exists:
-- The mobile regression path has been growing divergent semantics (per-step
-- batch RPC vs per-step apply, optional/continueOnError verdict tolerance,
-- different aggregate columns on test_results, different concurrency caps,
-- pool-claim cold-start fallback). Sharing regression_runs / test_executions
-- with the web path forces every mobile-only column or check constraint to
-- bleed into the web schema, and every web change risks regressing mobile.
--
-- This migration forks the *orchestration* layer only — the things that
-- record "what was scheduled, what was dispatched, how did it finish at the
-- run/execution grain". The underlying primitives (tests, test_results,
-- intent_test_cases, test_modules, test_flows, saved_test_cases) stay
-- shared because they already discriminate by `platform` column and are
-- consumed by the editor, chat, and intelligent-testing paths in addition
-- to regression.
--
-- Forked here:
--   * mobile_regression_plans
--   * mobile_regression_plan_items
--   * mobile_regression_suites
--   * mobile_regression_suite_items
--   * mobile_regression_runs               (includes share_token from
--                                           20260225_add_share_token.sql)
--   * mobile_test_executions
--   * mobile_test_results                  (includes the mobile-only
--                                           aggregate columns that the
--                                           earlier draft migration
--                                           20260508_test_results_mobile_aggregate_columns.sql
--                                           tried to add to the SHARED
--                                           test_results — that migration
--                                           is replaced by this fork and
--                                           must NOT be applied)
--
-- Foreign-key strategy:
--   Forked-table FKs (plan→items, suite→items, run→executions, etc.)
--   point at the mobile_ twin. Shared-table FKs (test_modules, test_flows,
--   saved_test_cases, tests, projects, workspaces, intelligent_test_sessions)
--   keep pointing at the original table — those are not part of the fork.
--
-- Code rewiring is NOT in this migration. The application still writes to
-- the original tables. Once this migration is applied, a follow-up code PR
-- will repoint the mobile worker (mobile-test-run.job.ts) and the mobile
-- branches of regression-run.service.ts at the new tables. Until that PR
-- lands, the mobile_* tables stay empty — applying this migration is
-- non-destructive and reversible (DROP TABLE mobile_* CASCADE).
--
-- Idempotent: every CREATE uses IF NOT EXISTS, every policy is guarded by
-- a pg_policies existence check, every trigger is dropped+recreated.

BEGIN;

-- ============================================================================
-- 1. mobile_regression_plans
-- ============================================================================
-- Mirror of regression_plans.

CREATE TABLE IF NOT EXISTS mobile_regression_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,

  -- Metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Settings
  is_default BOOLEAN DEFAULT false,

  -- Classification
  tags TEXT[] DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_regression_plans_default
  ON mobile_regression_plans(project_id) WHERE is_default = true;

CREATE INDEX IF NOT EXISTS idx_mobile_regression_plans_project
  ON mobile_regression_plans(project_id);

CREATE INDEX IF NOT EXISTS idx_mobile_regression_plans_user
  ON mobile_regression_plans(user_id);

CREATE INDEX IF NOT EXISTS idx_mobile_regression_plans_tags
  ON mobile_regression_plans USING GIN(tags);

-- ============================================================================
-- 2. mobile_regression_suites
-- ============================================================================
-- Mirror of regression_suites. Created BEFORE mobile_regression_plan_items
-- because plan_items.suite_id FK points here.

CREATE TABLE IF NOT EXISTS mobile_regression_suites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  project_id UUID NOT NULL,
  user_id TEXT NOT NULL,

  -- Metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT fk_mobile_regression_suites_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mobile_regression_suites_project
  ON mobile_regression_suites(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_regression_suites_user
  ON mobile_regression_suites(user_id, created_at DESC);

-- ============================================================================
-- 3. mobile_regression_plan_items
-- ============================================================================
-- Mirror of regression_plan_items. plan_id and suite_id point at the mobile_
-- twins; module_id, flow_id, test_case_id keep pointing at the shared
-- primitives (test_modules, test_flows, saved_test_cases) — the user-picked
-- "orchestration only" fork doesn't fork those.

CREATE TABLE IF NOT EXISTS mobile_regression_plan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  plan_id UUID NOT NULL REFERENCES mobile_regression_plans(id) ON DELETE CASCADE,

  -- Forked FKs go to the mobile_ twin; shared FKs stay on the originals.
  module_id UUID REFERENCES test_modules(id) ON DELETE CASCADE,
  suite_id UUID REFERENCES mobile_regression_suites(id) ON DELETE CASCADE,
  flow_id UUID REFERENCES test_flows(id) ON DELETE CASCADE,
  test_case_id UUID,
  test_case_type TEXT CHECK (test_case_type IN ('ui', 'api')),

  item_type TEXT NOT NULL CHECK (item_type IN ('module', 'suite', 'flow', 'test_case')),

  order_index INTEGER DEFAULT 0,
  parameters_override JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT mobile_check_item_target CHECK (
    (item_type = 'module' AND module_id IS NOT NULL AND suite_id IS NULL AND flow_id IS NULL AND test_case_id IS NULL) OR
    (item_type = 'suite' AND suite_id IS NOT NULL AND module_id IS NULL AND flow_id IS NULL AND test_case_id IS NULL) OR
    (item_type = 'flow' AND flow_id IS NOT NULL AND module_id IS NULL AND suite_id IS NULL AND test_case_id IS NULL) OR
    (item_type = 'test_case' AND test_case_id IS NOT NULL AND test_case_type IS NOT NULL AND module_id IS NULL AND suite_id IS NULL AND flow_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_mobile_regression_plan_items_plan
  ON mobile_regression_plan_items(plan_id, order_index);
CREATE INDEX IF NOT EXISTS idx_mobile_regression_plan_items_module
  ON mobile_regression_plan_items(module_id) WHERE module_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mobile_regression_plan_items_suite
  ON mobile_regression_plan_items(suite_id) WHERE suite_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mobile_regression_plan_items_flow
  ON mobile_regression_plan_items(flow_id) WHERE flow_id IS NOT NULL;

-- ============================================================================
-- 4. mobile_regression_suite_items
-- ============================================================================
-- Mirror of regression_suite_items. suite_id points at the mobile twin;
-- saved_test_case_id keeps pointing at the shared saved_test_cases table.

CREATE TABLE IF NOT EXISTS mobile_regression_suite_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  suite_id UUID NOT NULL,
  saved_test_case_id UUID NOT NULL,

  order_index INTEGER NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT fk_mobile_regression_suite_items_suite
    FOREIGN KEY (suite_id) REFERENCES mobile_regression_suites(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_regression_suite_items_case
    FOREIGN KEY (saved_test_case_id) REFERENCES saved_test_cases(id) ON DELETE CASCADE,
  CONSTRAINT unique_mobile_suite_case UNIQUE (suite_id, saved_test_case_id)
);

CREATE INDEX IF NOT EXISTS idx_mobile_regression_suite_items_suite
  ON mobile_regression_suite_items(suite_id, order_index);
CREATE INDEX IF NOT EXISTS idx_mobile_regression_suite_items_case
  ON mobile_regression_suite_items(saved_test_case_id);

-- ============================================================================
-- 5. mobile_regression_runs
-- ============================================================================
-- Mirror of regression_runs. Includes the `share_token` column added by
-- 20260225_add_share_token.sql so the mobile twin starts at parity.

CREATE TABLE IF NOT EXISTS mobile_regression_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was run (one of these will be set, enforced by check_mobile_run_target)
  suite_id UUID,
  saved_test_case_id UUID,

  project_id UUID NOT NULL,
  user_id TEXT NOT NULL,

  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'chat', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),

  -- Underlying test tracking — `tests` is a shared table (web + mobile both
  -- write into it via tests.platform). Keep the FK pointed there.
  test_id UUID,
  test_ids JSONB,

  summary JSONB,

  -- Public share link. NULLs are unconstrained by UNIQUE in Postgres, so
  -- only rows with a token compete for uniqueness.
  share_token TEXT UNIQUE,

  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT fk_mobile_regression_runs_suite
    FOREIGN KEY (suite_id) REFERENCES mobile_regression_suites(id) ON DELETE SET NULL,
  CONSTRAINT fk_mobile_regression_runs_case
    FOREIGN KEY (saved_test_case_id) REFERENCES saved_test_cases(id) ON DELETE SET NULL,
  CONSTRAINT fk_mobile_regression_runs_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_mobile_regression_runs_test
    FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE SET NULL,
  CONSTRAINT check_mobile_run_target CHECK (
    (suite_id IS NOT NULL AND saved_test_case_id IS NULL) OR
    (suite_id IS NULL AND saved_test_case_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_mobile_regression_runs_project
  ON mobile_regression_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_regression_runs_user
  ON mobile_regression_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_regression_runs_suite
  ON mobile_regression_runs(suite_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_regression_runs_case
  ON mobile_regression_runs(saved_test_case_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_regression_runs_status
  ON mobile_regression_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_regression_runs_test_id
  ON mobile_regression_runs(test_id) WHERE test_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mobile_regression_runs_test_ids_gin
  ON mobile_regression_runs USING GIN(test_ids) WHERE test_ids IS NOT NULL;

-- ============================================================================
-- 6. mobile_test_executions
-- ============================================================================
-- Mirror of test_executions. run_id and suite_id point at the mobile_ twins;
-- module_id and flow_id keep pointing at the shared test_modules / test_flows.

CREATE TABLE IF NOT EXISTS mobile_test_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  run_id UUID REFERENCES mobile_regression_runs(id) ON DELETE CASCADE,

  test_type TEXT NOT NULL CHECK (test_type IN ('ui', 'api')),
  test_case_id UUID NOT NULL,

  module_id UUID REFERENCES test_modules(id) ON DELETE SET NULL,
  suite_id UUID REFERENCES mobile_regression_suites(id) ON DELETE SET NULL,
  flow_id UUID REFERENCES test_flows(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'passed', 'failed', 'skipped', 'cancelled')),

  duration_ms INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  result JSONB DEFAULT '{}',
  error_message TEXT,

  screenshot_url TEXT,
  trace_url TEXT,

  browser TEXT,
  environment TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mobile_test_executions_run
  ON mobile_test_executions(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_test_executions_status
  ON mobile_test_executions(status);
CREATE INDEX IF NOT EXISTS idx_mobile_test_executions_module
  ON mobile_test_executions(module_id, status) WHERE module_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mobile_test_executions_suite
  ON mobile_test_executions(suite_id, status) WHERE suite_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mobile_test_executions_flow
  ON mobile_test_executions(flow_id, status) WHERE flow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mobile_test_executions_case
  ON mobile_test_executions(test_case_id);
CREATE INDEX IF NOT EXISTS idx_mobile_test_executions_type
  ON mobile_test_executions(test_type, status);
CREATE INDEX IF NOT EXISTS idx_mobile_test_executions_completed
  ON mobile_test_executions(completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mobile_test_executions_result_test_id
  ON mobile_test_executions ((result->>'testId'))
  WHERE result ? 'testId';

-- ============================================================================
-- 7. mobile_test_results
-- ============================================================================
-- Mirror of test_results PLUS the mobile-only aggregate columns. Replaces
-- the draft 20260508_test_results_mobile_aggregate_columns.sql which would
-- have added those columns to the shared test_results — that migration is
-- now obsolete and intentionally not applied.
--
-- Type choices that diverge from test_results on purpose:
--   * `browser` is TEXT (not the `browser_type` enum). The enum currently
--     covers chrome/firefox/safari/edge/mobile-chrome/mobile-safari and does
--     NOT include mobile-android / mobile-ios; rather than ALTER TYPE on a
--     shared enum, the mobile twin uses TEXT + CHECK constraint.
--   * `status` is TEXT (not the `test_status` enum) for the same reason —
--     keeps the mobile twin self-contained and free to add mobile-specific
--     statuses later without touching the web schema.
-- All other columns mirror the live shape of test_results
-- (base + intelligent-test-fields.sql + test-reports-and-artifacts.sql +
-- 20260209_test_results_quality_checks.sql + 20260320_add_replay_trace_url).
--
-- Mobile-only aggregate columns at the bottom of the column list match the
-- exact shape the worker writes at mobile-test-run.job.ts:1184-1200.

CREATE TABLE IF NOT EXISTS mobile_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- `tests` is shared (not part of this fork) — keep the FK there.
  test_id UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,

  -- Mobile-only browser values; TEXT + CHECK avoids ALTER TYPE on the
  -- shared browser_type enum.
  browser TEXT NOT NULL CHECK (browser IN ('mobile-android', 'mobile-ios')),

  -- Lifecycle status. Same value set as the test_status enum, but stored
  -- as TEXT so mobile can introduce mobile-specific statuses without
  -- touching the shared enum.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timeout')),

  -- Artifacts (mirror of test_results)
  screenshot TEXT,
  dom TEXT,
  logs TEXT[] DEFAULT '{}',
  network_logs JSONB DEFAULT '[]',
  errors JSONB DEFAULT '[]',
  performance JSONB,
  ai_summary JSONB,
  ai_metadata JSONB,
  video_url TEXT,
  trace_url TEXT,
  replay_trace_url TEXT,
  quality_checks JSONB,

  -- Mobile-only aggregate stats — exact shape that
  -- mobile-test-run.job.ts:createTestResult() writes.
  duration INTEGER,
  steps_total INTEGER,
  steps_passed INTEGER,
  steps_failed INTEGER,
  pass_rate INTEGER,

  -- Provenance — duplicated from tests.user_id / projects.workspace_id to
  -- save analytics queries a two-hop join. NULL FK on user delete keeps
  -- historical results around.
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,

  -- Free-form per-platform extras: { platform: 'mobile', steps: [...],
  -- bugReports: [...] }. Mobile-only — web's test_results doesn't have
  -- this column.
  metadata JSONB DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

COMMENT ON COLUMN mobile_test_results.duration       IS 'Total run duration in seconds. Mirrors runResult.durationMs / 1000 from qait-mobile-runner.';
COMMENT ON COLUMN mobile_test_results.steps_total    IS 'Number of steps the run was supposed to execute (totalSteps from runner).';
COMMENT ON COLUMN mobile_test_results.steps_passed   IS 'Number of steps that ran and produced their expected outcome.';
COMMENT ON COLUMN mobile_test_results.steps_failed   IS 'Number of steps that ran but did not produce expected outcome, plus aborted/timed-out steps (counted as failed since R-HIGH-1 fix).';
COMMENT ON COLUMN mobile_test_results.pass_rate      IS '0-100 integer. (steps_passed / (steps_passed + steps_failed)) * 100. Skipped steps excluded from denominator.';
COMMENT ON COLUMN mobile_test_results.metadata       IS 'Free-form per-platform extras. Stores { platform: "mobile", steps: [...], bugReports: [...] } for the regression UI to drill into per-step results without re-querying the runner.';

CREATE INDEX IF NOT EXISTS idx_mobile_test_results_test_id
  ON mobile_test_results(test_id);
CREATE INDEX IF NOT EXISTS idx_mobile_test_results_user_id
  ON mobile_test_results(user_id);
CREATE INDEX IF NOT EXISTS idx_mobile_test_results_workspace_id
  ON mobile_test_results(workspace_id);
CREATE INDEX IF NOT EXISTS idx_mobile_test_results_status
  ON mobile_test_results(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_test_results_completed_at
  ON mobile_test_results(completed_at DESC) WHERE completed_at IS NOT NULL;

-- ============================================================================
-- TRIGGERS — auto-update updated_at
-- ============================================================================
-- Reuse the global `update_updated_at_column()` function (defined in
-- features/regression-testing.sql). regression_plans uses a dedicated
-- trigger function `update_regression_plans_updated_at()` upstream; the
-- mobile twin reuses the global one to avoid duplicating a trivial one-liner.

DROP TRIGGER IF EXISTS update_mobile_regression_plans_updated_at ON mobile_regression_plans;
CREATE TRIGGER update_mobile_regression_plans_updated_at
  BEFORE UPDATE ON mobile_regression_plans
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_mobile_regression_suites_updated_at ON mobile_regression_suites;
CREATE TRIGGER update_mobile_regression_suites_updated_at
  BEFORE UPDATE ON mobile_regression_suites
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE mobile_regression_plans       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_regression_plan_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_test_executions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_test_results           ENABLE ROW LEVEL SECURITY;
-- mobile_regression_suites / mobile_regression_suite_items / mobile_regression_runs
-- mirror the upstream features/regression-testing.sql which doesn't enable
-- RLS on those tables — keep parity. If RLS gets added to the originals
-- later, mirror it here in the same migration.

DO $$
BEGIN
  -- mobile_regression_plans policies
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_regression_plans'
      AND policyname = 'Users can view own mobile regression plans'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own mobile regression plans" ON mobile_regression_plans FOR SELECT USING (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_regression_plans'
      AND policyname = 'Users can insert own mobile regression plans'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own mobile regression plans" ON mobile_regression_plans FOR INSERT WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_regression_plans'
      AND policyname = 'Users can update own mobile regression plans'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own mobile regression plans" ON mobile_regression_plans FOR UPDATE USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_regression_plans'
      AND policyname = 'Users can delete own mobile regression plans'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own mobile regression plans" ON mobile_regression_plans FOR DELETE USING (user_id = auth.uid()::text)';
  END IF;

  -- mobile_regression_plan_items policies (gated through plan ownership)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_regression_plan_items'
      AND policyname = 'Users can view own mobile plan items'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own mobile plan items" ON mobile_regression_plan_items FOR SELECT USING (EXISTS (SELECT 1 FROM mobile_regression_plans rp WHERE rp.id = mobile_regression_plan_items.plan_id AND rp.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_regression_plan_items'
      AND policyname = 'Users can insert own mobile plan items'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own mobile plan items" ON mobile_regression_plan_items FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM mobile_regression_plans rp WHERE rp.id = mobile_regression_plan_items.plan_id AND rp.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_regression_plan_items'
      AND policyname = 'Users can update own mobile plan items'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own mobile plan items" ON mobile_regression_plan_items FOR UPDATE USING (EXISTS (SELECT 1 FROM mobile_regression_plans rp WHERE rp.id = mobile_regression_plan_items.plan_id AND rp.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_regression_plan_items'
      AND policyname = 'Users can delete own mobile plan items'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own mobile plan items" ON mobile_regression_plan_items FOR DELETE USING (EXISTS (SELECT 1 FROM mobile_regression_plans rp WHERE rp.id = mobile_regression_plan_items.plan_id AND rp.user_id = auth.uid()::text))';
  END IF;

  -- mobile_test_executions policies (gated through run ownership)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_test_executions'
      AND policyname = 'Users can view own mobile test executions'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own mobile test executions" ON mobile_test_executions FOR SELECT USING (EXISTS (SELECT 1 FROM mobile_regression_runs rr WHERE rr.id = mobile_test_executions.run_id AND rr.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_test_executions'
      AND policyname = 'Users can insert own mobile test executions'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own mobile test executions" ON mobile_test_executions FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM mobile_regression_runs rr WHERE rr.id = mobile_test_executions.run_id AND rr.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_test_executions'
      AND policyname = 'Users can update own mobile test executions'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own mobile test executions" ON mobile_test_executions FOR UPDATE USING (EXISTS (SELECT 1 FROM mobile_regression_runs rr WHERE rr.id = mobile_test_executions.run_id AND rr.user_id = auth.uid()::text))';
  END IF;

  -- mobile_test_results policies (mirror of test_results: gated through
  -- tests.project_id → projects.user_id chain). NOTE: `projects.user_id`
  -- is TEXT in the live schema (the recreate-all-tables-with-text-user-id
  -- migration changed it to support both UUID and IP-based anonymous
  -- users), but `auth.uid()` returns UUID. Cast to ::text — matches the
  -- pattern used by the other policies in this migration. The upstream
  -- test_results policy uses the unqualified form and would fail on the
  -- live schema too; mirroring it verbatim is wrong.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_test_results'
      AND policyname = 'Users can view own mobile test results'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own mobile test results" ON mobile_test_results FOR SELECT USING (EXISTS (SELECT 1 FROM tests JOIN projects ON projects.id = tests.project_id WHERE tests.id = mobile_test_results.test_id AND projects.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_test_results'
      AND policyname = 'Users can create own mobile test results'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can create own mobile test results" ON mobile_test_results FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM tests JOIN projects ON projects.id = tests.project_id WHERE tests.id = mobile_test_results.test_id AND projects.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mobile_test_results'
      AND policyname = 'Users can update own mobile test results'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own mobile test results" ON mobile_test_results FOR UPDATE USING (EXISTS (SELECT 1 FROM tests JOIN projects ON projects.id = tests.project_id WHERE tests.id = mobile_test_results.test_id AND projects.user_id = auth.uid()::text))';
  END IF;
END $$;

-- ============================================================================
-- HELPER FUNCTIONS — mobile twins of the regression analytics helpers
-- ============================================================================
-- Mirror get_execution_stats / get_module_execution_stats / get_suite_with_cases
-- so the existing query patterns work against the mobile orchestration tables.

CREATE OR REPLACE FUNCTION get_mobile_execution_stats(p_run_id UUID)
RETURNS TABLE (
  total INTEGER,
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  pending INTEGER,
  running INTEGER,
  cancelled INTEGER,
  pass_rate NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::INTEGER as total,
    COUNT(*) FILTER (WHERE status = 'passed')::INTEGER as passed,
    COUNT(*) FILTER (WHERE status = 'failed')::INTEGER as failed,
    COUNT(*) FILTER (WHERE status = 'skipped')::INTEGER as skipped,
    COUNT(*) FILTER (WHERE status = 'pending')::INTEGER as pending,
    COUNT(*) FILTER (WHERE status = 'running')::INTEGER as running,
    COUNT(*) FILTER (WHERE status = 'cancelled')::INTEGER as cancelled,
    CASE
      WHEN COUNT(*) FILTER (WHERE status IN ('passed', 'failed')) > 0
      THEN ROUND(
        COUNT(*) FILTER (WHERE status = 'passed')::NUMERIC /
        COUNT(*) FILTER (WHERE status IN ('passed', 'failed'))::NUMERIC * 100,
        2
      )
      ELSE 0
    END as pass_rate
  FROM mobile_test_executions
  WHERE run_id = p_run_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_mobile_module_execution_stats(p_module_id UUID, p_days INTEGER DEFAULT 30)
RETURNS TABLE (
  total INTEGER,
  passed INTEGER,
  failed INTEGER,
  pass_rate NUMERIC,
  avg_duration_ms NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::INTEGER as total,
    COUNT(*) FILTER (WHERE status = 'passed')::INTEGER as passed,
    COUNT(*) FILTER (WHERE status = 'failed')::INTEGER as failed,
    CASE
      WHEN COUNT(*) FILTER (WHERE status IN ('passed', 'failed')) > 0
      THEN ROUND(
        COUNT(*) FILTER (WHERE status = 'passed')::NUMERIC /
        COUNT(*) FILTER (WHERE status IN ('passed', 'failed'))::NUMERIC * 100,
        2
      )
      ELSE 0
    END as pass_rate,
    ROUND(AVG(duration_ms)::NUMERIC, 2) as avg_duration_ms
  FROM mobile_test_executions
  WHERE module_id = p_module_id
    AND created_at > NOW() - (p_days || ' days')::INTERVAL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_mobile_suite_with_cases(suite_uuid UUID)
RETURNS TABLE (
  suite_id UUID,
  suite_name TEXT,
  suite_description TEXT,
  case_id UUID,
  case_name TEXT,
  case_order INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.description,
    c.id,
    c.name,
    i.order_index
  FROM mobile_regression_suites s
  LEFT JOIN mobile_regression_suite_items i ON s.id = i.suite_id
  LEFT JOIN saved_test_cases c ON i.saved_test_case_id = c.id
  WHERE s.id = suite_uuid
  ORDER BY
    CASE WHEN i.order_index IS NULL THEN 999999 ELSE i.order_index END,
    i.order_index NULLS LAST;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE mobile_regression_plans       IS 'Mobile twin of regression_plans. Same schema; isolation lets mobile-only constraints/columns evolve without touching the web schema.';
COMMENT ON TABLE mobile_regression_plan_items  IS 'Mobile twin of regression_plan_items. plan_id and suite_id point at mobile_*; module_id, flow_id, test_case_id stay shared.';
COMMENT ON TABLE mobile_regression_suites      IS 'Mobile twin of regression_suites. Same schema, isolated namespace.';
COMMENT ON TABLE mobile_regression_suite_items IS 'Mobile twin of regression_suite_items. suite_id forked, saved_test_case_id stays shared.';
COMMENT ON TABLE mobile_regression_runs        IS 'Mobile twin of regression_runs. Includes share_token from 20260225 for parity.';
COMMENT ON TABLE mobile_test_executions        IS 'Mobile twin of test_executions. run_id and suite_id forked; module_id and flow_id stay shared.';
COMMENT ON TABLE mobile_test_results           IS 'Mobile twin of test_results. Mirrors live test_results columns + mobile-only aggregate stats (duration, steps_*, pass_rate, metadata, user_id, workspace_id). Replaces draft 20260508_test_results_mobile_aggregate_columns.sql.';

COMMENT ON FUNCTION get_mobile_execution_stats(UUID)
  IS 'Aggregated execution stats for a mobile_regression_runs id. Mirror of get_execution_stats.';
COMMENT ON FUNCTION get_mobile_module_execution_stats(UUID, INTEGER)
  IS 'Module-level mobile execution stats over N days. Mirror of get_module_execution_stats.';
COMMENT ON FUNCTION get_mobile_suite_with_cases(UUID)
  IS 'Returns mobile suite with all cases ordered by order_index. Mirror of get_suite_with_cases.';

-- ============================================================================
-- Forces PostgREST schema cache reload so REST queries against the new
-- tables don't return PGRST205 (no relation found) for several minutes.
-- ============================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
