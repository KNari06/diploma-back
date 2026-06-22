-- 20260622_test_modules_order_index.sql
--
-- Add manual ordering to test_modules so folders can be drag-reordered on the
-- Repository page (mirrors test_flows.order_index). Until now modules were
-- listed newest-first by created_at.
--
-- The platform tree (and ModuleService.listByProject) switch their sort to
-- order_index ASC. To keep every existing project's CURRENT visible order
-- intact after that switch, we backfill order_index per platform from the old
-- created_at-DESC order: the newest module (shown first today) gets index 0,
-- the next gets 1, etc. New modules created afterwards get max+1 (see
-- ModuleService.create).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + the backfill only touches the column
-- it just ensured. Safe to re-run.

ALTER TABLE test_modules ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 0;

-- Backfill: per platform, rank by created_at DESC (today's display order) so
-- the new order_index ASC sort reproduces what users already see.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY platform_id
      ORDER BY created_at DESC, id
    ) - 1 AS rn
  FROM test_modules
)
UPDATE test_modules m
SET order_index = ranked.rn
FROM ranked
WHERE ranked.id = m.id;

-- Lookup/sort index for the platform-scoped ordered read.
CREATE INDEX IF NOT EXISTS idx_test_modules_order
  ON test_modules(platform_id, order_index);

COMMENT ON COLUMN test_modules.order_index IS
  'Manual ordering within a platform (drag-and-drop). Lower = earlier. Set via POST /api/v1/modules/reorder.';
