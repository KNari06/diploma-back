-- Link a discovered test case back to the exploration run that produced it.
--
-- WHY: `intent_test_cases` records only `source='exploration'` — there is no
-- reference to WHICH run created the row. `getExplorationTestCases` therefore
-- filters on project + source and returns every exploration case the project
-- has ever accumulated. Measured on prod (2026-08-03): one project has 516
-- such rows from 8 runs, another 341 from 16. So opening the results of a run
-- that discovered ~20 tests lists hundreds, including cases from entirely
-- different entry URLs — and any bulk action taken there (add-to-regression)
-- operates on that wrong set.
--
-- TEXT, not a FK to exploration_runs(id): the id used everywhere in the code
-- is `exploration_runs.exploration_id` (an application-generated string like
-- `exp-…`), which is what the API routes and the job carry. Referencing the
-- surrogate uuid would force every writer to look the row up first.
--
-- NULLABLE with no backfill. Existing rows genuinely do not know their run —
-- inventing an association would be worse than admitting the gap, and the
-- reader is written to fall back to the old project-wide behaviour when the
-- column is null, so nothing breaks for historic explorations.

ALTER TABLE public.intent_test_cases
  ADD COLUMN IF NOT EXISTS exploration_id TEXT;

-- The only lookup: "the test cases this run produced", always project-scoped
-- because that is how the reader authorizes.
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_exploration
  ON public.intent_test_cases(project_id, exploration_id)
  WHERE exploration_id IS NOT NULL;

COMMENT ON COLUMN public.intent_test_cases.exploration_id IS
  'exploration_runs.exploration_id of the run that discovered this case. NULL for cases created before this column existed, and for every non-exploration source.';

-- ── entry_point_id ──────────────────────────────────────────────────────────
-- Which DISCOVERED FLOW inside that run this row came from.
--
-- The results screen lists flows by `entryPointId` (from the run summary) while
-- persistence produced uuid-keyed rows, so the two could only be matched on
-- NAME — and name is not a key: 42 names collide within a single run on prod,
-- worst case 5 rows sharing one. Selecting one flow would have added all five.
--
-- Nullable, no backfill: a pre-existing row cannot know its entry point, and
-- the reader treats a null as "not matchable" rather than guessing.
ALTER TABLE public.intent_test_cases
  ADD COLUMN IF NOT EXISTS entry_point_id TEXT;

COMMENT ON COLUMN public.intent_test_cases.entry_point_id IS
  'DiscoveredTestCase.id (the exploration entry-point id) this row came from. Lets the results screen map a listed flow to its persisted case exactly, instead of matching on name.';
