-- Flow-level mobile variant override. A flow (test_flows) is what users create
-- in the "Create test" dialog and run; it groups intent_test_cases. Setting a
-- variant here makes every test case in the flow run against that variant lane.
--
-- Full resolution precedence for a mobile run's variant:
--   intent_test_cases.mobile_variant_label   (per-test override — power users)
--   > test_flows.mobile_variant_label         (the flow's choice — main UI)
--   > regression_plans.mobile_variant_label   (the plan's choice)
--   > projects.settings.mobileDefaultVariant  (project default, set-default)
--   > 'default'
--
-- NULL = inherit (no override at this level).

ALTER TABLE test_flows
  ADD COLUMN IF NOT EXISTS mobile_variant_label TEXT;

COMMENT ON COLUMN test_flows.mobile_variant_label IS
  'Mobile-only flow variant override. NULL = inherit (plan -> project default -> ''default''). Applies to every intent_test_case in the flow unless the case sets its own override.';

NOTIFY pgrst, 'reload schema';
