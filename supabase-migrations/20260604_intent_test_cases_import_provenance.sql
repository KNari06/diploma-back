-- Import provenance for intent_test_cases
--
-- Adds a durable link from an imported test case back to the import that
-- created it, plus the two facts the import knows at creation time but which
-- were previously lost once the completion popup closed:
--   - source_status  : the Allure run verdict (passed/failed/broken/skipped).
--                       intent_test_cases.status is our lifecycle ('draft'),
--                       NOT the source run result — they are different axes.
--   - steps_degraded : true when AI step conversion fell back to all-'click'
--                       (step types unreliable; needs manual review).
--
-- import_id replaces the fragile created_at-window join used by
-- GET /allure-import/status/:id/details, which could pull in a teammate's or
-- the user's own non-import test cases created during the same window. It also
-- unblocks future re-import/sync (update existing rows instead of duplicating).
--
-- Follows the existing source_* column pattern (source_test_id,
-- source_intelligent_session_id) already on this table.

ALTER TABLE public.intent_test_cases
  ADD COLUMN IF NOT EXISTS import_id UUID REFERENCES public.allure_imports(id) ON DELETE SET NULL;

ALTER TABLE public.intent_test_cases
  ADD COLUMN IF NOT EXISTS source_status TEXT;

ALTER TABLE public.intent_test_cases
  ADD COLUMN IF NOT EXISTS steps_degraded BOOLEAN NOT NULL DEFAULT false;

-- /details filters by import_id; index it for the lookup.
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_import
  ON public.intent_test_cases (import_id);

COMMENT ON COLUMN public.intent_test_cases.import_id IS
  'The allure_imports row that created this test case (NULL for manually-created tests). Set ON DELETE SET NULL so deleting an import record does not delete its tests.';
COMMENT ON COLUMN public.intent_test_cases.source_status IS
  'Source run verdict at import time (Allure: passed/failed/broken/skipped). Distinct from the lifecycle `status` column. NULL for non-import / design-time sources.';
COMMENT ON COLUMN public.intent_test_cases.steps_degraded IS
  'True when AI step conversion failed and steps fell back to all-click during import — step action types are unreliable and need review.';
