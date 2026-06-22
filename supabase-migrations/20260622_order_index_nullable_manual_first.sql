-- 20260622_order_index_nullable_manual_first.sql
--
-- Reworks flow/module ordering to: "newest-first by default, manual order wins
-- only for items the user actually dragged."
--
-- Previously order_index defaulted to 0 (modules NOT NULL) and an earlier
-- migration backfilled every module's order_index from created_at, which made
-- EVERY row look manually-ordered — so the tree showed oldest-first and never
-- fell back to newest-first.
--
-- New model: order_index is NULLABLE with NO default. NULL = "not manually
-- ordered" → the row sorts by created_at DESC. A non-NULL value = the user
-- dragged it; those sort first, ascending. Sort key everywhere becomes:
--   ORDER BY (order_index IS NULL), order_index ASC, created_at DESC
--
-- Reset existing values to NULL: the drag feature only just shipped, so no
-- intentional ordering exists yet — clearing restores newest-first for all.
-- Idempotent.

-- test_modules: drop NOT NULL + default, reset to NULL.
ALTER TABLE test_modules ALTER COLUMN order_index DROP DEFAULT;
ALTER TABLE test_modules ALTER COLUMN order_index DROP NOT NULL;
UPDATE test_modules SET order_index = NULL WHERE order_index IS NOT NULL;

-- test_flows: drop default, reset to NULL (already nullable).
ALTER TABLE test_flows ALTER COLUMN order_index DROP DEFAULT;
UPDATE test_flows SET order_index = NULL WHERE order_index IS NOT NULL;

COMMENT ON COLUMN test_modules.order_index IS
  'Manual drag order within a platform. NULL = not manually ordered (sorts by created_at DESC). Non-NULL sorts first, ascending.';
COMMENT ON COLUMN test_flows.order_index IS
  'Manual drag order within a module. NULL = not manually ordered (sorts by created_at DESC). Non-NULL sorts first, ascending.';
