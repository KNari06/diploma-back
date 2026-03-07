-- ============================================================================
-- Performance composite indexes for slow API endpoints
-- ============================================================================
-- Targets:
--   GET /api/v1/regression-plans  (batchGetLatestRuns, batchGetPlanScopes)
--   GET /api/v1/platforms/tree    (getBaseModeTree)
-- ============================================================================

-- 1. regression_runs: composite for "latest run per plan" query
--    batchGetLatestRuns() does: .eq('plan_id', planId).order('started_at', desc).limit(1)
--    Existing idx_regression_runs_plan only indexes (plan_id) — no sort coverage
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_regression_runs_plan_started
  ON regression_runs(plan_id, started_at DESC)
  WHERE plan_id IS NOT NULL;

-- 2. test_flows: index on module_id for module→flow lookups
--    batchGetPlanScopes() and getScopeItems() join test_flows by module_id
--    Currently NO index exists on test_flows(module_id)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_test_flows_module
  ON test_flows(module_id)
  WHERE module_id IS NOT NULL;

-- 3. test_modules: composite for platform tree pagination
--    getBaseModeTree() does: .eq('platform_id').eq('user_id').order('created_at', desc).range()
--    Existing: idx_test_modules_platform (platform_id only), idx_test_modules_user (user_id only)
--    Neither covers the compound filter + sort pattern
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_test_modules_platform_user_created
  ON test_modules(platform_id, user_id, created_at DESC)
  WHERE platform_id IS NOT NULL;
