-- ============================================================================
-- REGRESSION PLANS TABLES
-- ============================================================================
-- Reusable custom test sets (mix of modules/suites/flows/cases)
-- Used for flexible regression testing configurations
-- ============================================================================

-- Regression Plans Table
CREATE TABLE IF NOT EXISTS regression_plans (
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

-- ============================================================================
-- INDEXES for regression_plans
-- ============================================================================

-- Unique default plan per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_regression_plans_default
  ON regression_plans(project_id) WHERE is_default = true;

CREATE INDEX IF NOT EXISTS idx_regression_plans_project
  ON regression_plans(project_id);

CREATE INDEX IF NOT EXISTS idx_regression_plans_user
  ON regression_plans(user_id);

CREATE INDEX IF NOT EXISTS idx_regression_plans_tags
  ON regression_plans USING GIN(tags);

-- ============================================================================
-- REGRESSION PLAN ITEMS TABLE
-- ============================================================================
-- What's included in the plan (modules, suites, flows, or individual test cases)

CREATE TABLE IF NOT EXISTS regression_plan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent reference
  plan_id UUID NOT NULL REFERENCES regression_plans(id) ON DELETE CASCADE,

  -- Target reference (one of these is set based on item_type)
  module_id UUID REFERENCES test_modules(id) ON DELETE CASCADE,
  suite_id UUID REFERENCES regression_suites(id) ON DELETE CASCADE,
  flow_id UUID REFERENCES test_flows(id) ON DELETE CASCADE,
  test_case_id UUID,  -- saved_test_cases.id or api_test_configs.id
  test_case_type TEXT CHECK (test_case_type IN ('ui', 'api')),

  -- Item classification
  item_type TEXT NOT NULL CHECK (item_type IN ('module', 'suite', 'flow', 'test_case')),

  -- Ordering
  order_index INTEGER DEFAULT 0,

  -- Override parameters for this item
  parameters_override JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraint: ensure correct reference based on item_type
  CONSTRAINT check_item_target CHECK (
    (item_type = 'module' AND module_id IS NOT NULL AND suite_id IS NULL AND flow_id IS NULL AND test_case_id IS NULL) OR
    (item_type = 'suite' AND suite_id IS NOT NULL AND module_id IS NULL AND flow_id IS NULL AND test_case_id IS NULL) OR
    (item_type = 'flow' AND flow_id IS NOT NULL AND module_id IS NULL AND suite_id IS NULL AND test_case_id IS NULL) OR
    (item_type = 'test_case' AND test_case_id IS NOT NULL AND test_case_type IS NOT NULL AND module_id IS NULL AND suite_id IS NULL AND flow_id IS NULL)
  )
);

-- ============================================================================
-- INDEXES for regression_plan_items
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_regression_plan_items_plan
  ON regression_plan_items(plan_id, order_index);

CREATE INDEX IF NOT EXISTS idx_regression_plan_items_module
  ON regression_plan_items(module_id) WHERE module_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_regression_plan_items_suite
  ON regression_plan_items(suite_id) WHERE suite_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_regression_plan_items_flow
  ON regression_plan_items(flow_id) WHERE flow_id IS NOT NULL;

-- ============================================================================
-- TRIGGER: Auto-update updated_at for regression_plans
-- ============================================================================

CREATE OR REPLACE FUNCTION update_regression_plans_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_regression_plans_updated_at ON regression_plans;
CREATE TRIGGER trigger_update_regression_plans_updated_at
  BEFORE UPDATE ON regression_plans
  FOR EACH ROW
  EXECUTE FUNCTION update_regression_plans_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE regression_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE regression_plan_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- regression_plans policies
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'regression_plans'
      AND policyname = 'Users can view own regression plans'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own regression plans" ON regression_plans FOR SELECT USING (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'regression_plans'
      AND policyname = 'Users can insert own regression plans'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own regression plans" ON regression_plans FOR INSERT WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'regression_plans'
      AND policyname = 'Users can update own regression plans'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own regression plans" ON regression_plans FOR UPDATE USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'regression_plans'
      AND policyname = 'Users can delete own regression plans'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own regression plans" ON regression_plans FOR DELETE USING (user_id = auth.uid()::text)';
  END IF;

  -- regression_plan_items policies (via plan ownership)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'regression_plan_items'
      AND policyname = 'Users can view own plan items'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can view own plan items" ON regression_plan_items FOR SELECT USING (EXISTS (SELECT 1 FROM regression_plans rp WHERE rp.id = regression_plan_items.plan_id AND rp.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'regression_plan_items'
      AND policyname = 'Users can insert own plan items'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can insert own plan items" ON regression_plan_items FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM regression_plans rp WHERE rp.id = regression_plan_items.plan_id AND rp.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'regression_plan_items'
      AND policyname = 'Users can update own plan items'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can update own plan items" ON regression_plan_items FOR UPDATE USING (EXISTS (SELECT 1 FROM regression_plans rp WHERE rp.id = regression_plan_items.plan_id AND rp.user_id = auth.uid()::text))';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'regression_plan_items'
      AND policyname = 'Users can delete own plan items'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own plan items" ON regression_plan_items FOR DELETE USING (EXISTS (SELECT 1 FROM regression_plans rp WHERE rp.id = regression_plan_items.plan_id AND rp.user_id = auth.uid()::text))';
  END IF;
END $$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE regression_plans IS 'Reusable custom test sets for regression testing';
COMMENT ON TABLE regression_plan_items IS 'Items included in a regression plan';
COMMENT ON COLUMN regression_plans.is_default IS 'If true, this is the default plan for the project';
COMMENT ON COLUMN regression_plan_items.item_type IS 'Type of item: module, suite, flow, or test_case';
COMMENT ON COLUMN regression_plan_items.test_case_type IS 'For test_case items: ui or api';
COMMENT ON COLUMN regression_plan_items.parameters_override IS 'Override default parameters for this item';
