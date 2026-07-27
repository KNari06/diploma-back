-- Remove the `scenario_setup` resource kind from the two `kind` CHECK
-- constraints (test_resources + workspace_resource_defaults).
--
-- Why: the scenario_setup ("Scenarios") feature is being fully removed — a
-- stale, unused, mobile-only mechanism (0 resources, 0 bindings, 0 telemetry
-- in every environment) that overlapped in purpose with the actively-developed
-- `depends_on` dependencies feature. Its adapter, runtime, `use_setup` step
-- type, and UI are deleted; this migration closes the DB so no NEW row of the
-- kind can be inserted. The TS `ResourceKind` union dropped it in the same PR.
--
-- Non-destructive: no columns dropped, no rows touched. The three Phase-2
-- mobile-telemetry columns that measured the scenario prologue
-- (test_executions.scenario_steps_ms / scenario_step_count,
-- regression_runs.total_scenario_ms) are intentionally LEFT in place; their
-- teardown is deferred to its own migration once confirmed dead in prod for a
-- release cycle (mirrors the workspace_credits schema-drop deferral).
--
-- Guard: a stray `scenario_setup` row would make the ADD CONSTRAINT fail with a
-- generic check-violation. We RAISE first so the failure is self-explanatory
-- and points the operator at the row(s) to clean up before re-running.

DO $$
DECLARE
  n_resources   integer;
  n_defaults    integer;
BEGIN
  SELECT count(*) INTO n_resources
    FROM public.test_resources WHERE kind = 'scenario_setup';
  SELECT count(*) INTO n_defaults
    FROM public.workspace_resource_defaults WHERE kind = 'scenario_setup';

  IF n_resources > 0 OR n_defaults > 0 THEN
    RAISE EXCEPTION
      'Cannot drop scenario_setup kind: % test_resources row(s) and % workspace_resource_defaults row(s) still use it. Delete or migrate them first.',
      n_resources, n_defaults;
  END IF;
END $$;

ALTER TABLE public.test_resources
  DROP CONSTRAINT IF EXISTS test_resources_kind_check;

ALTER TABLE public.test_resources
  ADD CONSTRAINT test_resources_kind_check
  CHECK (kind IN (
    'auth', 'environment', 'secret', 'data_fixture', 'device',
    'network', 'file', 'oauth_token', 'variables'
  ));

ALTER TABLE public.workspace_resource_defaults
  DROP CONSTRAINT IF EXISTS workspace_resource_defaults_kind_check;

ALTER TABLE public.workspace_resource_defaults
  ADD CONSTRAINT workspace_resource_defaults_kind_check
  CHECK (kind IN (
    'auth', 'environment', 'secret', 'data_fixture', 'device',
    'network', 'file', 'oauth_token', 'variables'
  ));

COMMENT ON TABLE public.test_resources IS
  'Polymorphic reusable resources shared across test cases. Kind selects adapter (auth/environment/secret/data_fixture/device/network/file/oauth_token/variables).';
