-- Soft-delete marker for intent test cases orphaned by a flow/module delete.
--
-- Background: `intent_test_cases.flow_id` is ON DELETE SET NULL, while
-- `test_flows.module_id` and `test_modules.parent_module_id` are ON DELETE
-- CASCADE. Deleting a flow or a folder therefore left its test cases behind
-- with a NULL flow_id. Those rows vanish from the repository tree (built
-- modules -> flows -> test cases) but kept surfacing in project-wide reads,
-- so the "Add dependency" picker went on offering test cases the user had
-- already deleted.
--
-- Rather than hard-deleting them (which would break 137 rows still referenced
-- by regression plans, run history, traces and Jira links), the services mark
-- them with `deleted_at`. The data survives and stays restorable; reads filter
-- it out.

ALTER TABLE public.intent_test_cases
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.intent_test_cases.deleted_at IS
  'Soft-delete marker. Set when the owning flow/module is deleted; NULL means live. Reads must filter on deleted_at IS NULL.';

-- Partial index: every product read filters `deleted_at IS NULL`, so only live
-- rows need to be indexed. Keeps the index small as tombstones accumulate.
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_live_by_project
  ON public.intent_test_cases (project_id)
  WHERE deleted_at IS NULL;

-- Backfill: the 1533 rows already orphaned by this bug. They are invisible in
-- the UI today and cannot be reached or edited, so marking them changes no
-- behaviour beyond removing them from the dependency picker — which is the
-- point. Nothing is deleted; drop the marker to restore a row.
UPDATE public.intent_test_cases
SET deleted_at = NOW()
WHERE flow_id IS NULL
  AND deleted_at IS NULL;
