-- Per-test-case mobile variant override + (no schema needed for) the
-- project default-variant pointer, which lives in projects.settings JSONB.
--
-- Resolution precedence for a mobile run's variant lane:
--   intent_test_cases.mobile_variant_label   (this test's override)
--   > regression_plans.mobile_variant_label  (the plan's choice)
--   > projects.settings.mobileDefaultVariant (the project default, set-default)
--   > 'default'                              (the literal default lane)
--
-- NULL = "inherit" (no override at this level), so existing rows are
-- unaffected and keep resolving exactly as before.

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS mobile_variant_label TEXT;

COMMENT ON COLUMN intent_test_cases.mobile_variant_label IS
  'Mobile-only per-test variant override. NULL = inherit (plan -> project default -> ''default''). When set, this test always runs against the named variant lane regardless of the plan.';

NOTIFY pgrst, 'reload schema';
