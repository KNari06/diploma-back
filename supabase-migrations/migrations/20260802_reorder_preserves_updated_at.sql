-- Reordering a folder must not count as editing every test in it.
--
-- `trigger_update_test_flows_updated_at` stamped `NEW.updated_at = NOW()` on
-- every UPDATE. `FlowService.reorder` writes `order_index` for each flow in a
-- module, so one drag rewrote the timestamp of every row — measured on prod:
-- 16 of 22 modules with 5+ flows had all their `updated_at` values collapsed
-- into a single second, several with a spread of exactly 00:00:00.
--
-- Two consequences, both user-visible:
--   1. The repository list's "Updated" column reported when the folder was last
--      rearranged, not when the test changed.
--   2. It flattened the sort key, so date ordering degenerated into ties and
--      rows appeared in arbitrary order.
--
-- Fix: skip the stamp when `order_index` is the ONLY column that changed. Any
-- real edit (name, tags, platform, priority, …) still bumps `updated_at`.
--
-- Deliberately NOT backfilled. The original per-row timestamps were overwritten
-- and are unrecoverable; inventing values would be worse than leaving the
-- history as-is. The display side is handled separately — the repository list
-- now prefers the newest child `intent_test_cases.updated_at`, which was never
-- affected by this.

CREATE OR REPLACE FUNCTION update_test_flows_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  -- Compare the rows with order_index normalised away. When they are otherwise
  -- identical this UPDATE is a pure reorder, so leave updated_at untouched.
  -- Uses IS DISTINCT FROM so NULLs compare correctly.
  IF TG_OP = 'UPDATE'
     AND (NEW.order_index IS DISTINCT FROM OLD.order_index)
     AND to_jsonb(NEW) - 'order_index' - 'updated_at'
       = to_jsonb(OLD) - 'order_index' - 'updated_at'
  THEN
    NEW.updated_at = OLD.updated_at;
    RETURN NEW;
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
