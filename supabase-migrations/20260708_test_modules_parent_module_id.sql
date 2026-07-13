-- 20260708_test_modules_parent_module_id.sql
--
-- Nested folders on the Repository page: let a module (folder) live inside
-- another module. Until now modules were strictly flat within a platform
-- (platform -> module -> flow -> test case). This adds a self-referential
-- parent so folders can nest, with test cases (flows) and sub-folders shown
-- side-by-side.
--
-- parent_module_id NULL  = top-level folder (current behaviour for every
--                          existing module — no data migration needed).
-- parent_module_id SET   = sub-folder of that module.
--
-- ON DELETE CASCADE: deleting a folder removes its whole subtree; each folder's
-- flows already cascade via test_flows.module_id, so a subtree delete also
-- takes the flows/test cases under it.
--
-- Depth (max 3 levels) and cycle prevention are enforced in the service layer
-- (ModuleService), not here — consistent with how the codebase validates
-- elsewhere and keeps it unit-testable.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. Safe to
-- re-run.

ALTER TABLE test_modules
  ADD COLUMN IF NOT EXISTS parent_module_id UUID
  REFERENCES test_modules(id) ON DELETE CASCADE;

-- Lookup index for "children of module X" reads (tree assembly + subtree walks).
CREATE INDEX IF NOT EXISTS idx_test_modules_parent
  ON test_modules(parent_module_id) WHERE parent_module_id IS NOT NULL;

COMMENT ON COLUMN test_modules.parent_module_id IS
  'Parent folder (self-reference). NULL = top-level. Nesting capped at 3 levels and cycle-checked in ModuleService. ON DELETE CASCADE removes the subtree.';
