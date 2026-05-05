-- ─────────────────────────────────────────────────────────────────────────────
-- Allure Imports: persist hierarchy snapshot
--
-- The import worker computes a Module → Flow → TestCase tree (used by the
-- frontend popup) and emits it on the WebSocket `allure:import:completed`
-- event. Previously it was NEVER stored — if the WS event was missed (network
-- blip, dialog closed mid-completion, polling fallback) the tree could not be
-- recovered. Now we snapshot it next to `stats` so the REST status endpoint
-- can return it on demand.
--
-- The column is nullable because:
--   - Old import records (pre-migration) don't have one
--   - Failed imports skip the tree-build step
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.allure_imports
  ADD COLUMN IF NOT EXISTS hierarchy JSONB;

COMMENT ON COLUMN public.allure_imports.hierarchy IS
  'AllureImportResultHierarchy snapshot — { modules: [...], unassigned: [...] }. '
  'Populated only for completed imports.';
