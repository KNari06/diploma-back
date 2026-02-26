-- Drop the test_plans table.
--
-- Context: The Pro mode approval flow was removed — tests now run immediately
-- via Lite mode. No code path writes to or reads from test_plans anymore.
-- Existing rows are orphaned (pending plans expired via expires_at TTL).
--
-- Dependencies checked:
--   - No incoming foreign keys (no other table references test_plans)
--   - Outgoing FK: exploration_id → exploration_cache(id) ON DELETE SET NULL
--     (dropped automatically with the table)
--   - All application code references removed in the same release

-- 1. Drop RLS policies first (required before DROP TABLE)
DROP POLICY IF EXISTS "Users can view their own test plans" ON test_plans;
DROP POLICY IF EXISTS "Users can insert their own test plans" ON test_plans;
DROP POLICY IF EXISTS "Users can update their own test plans" ON test_plans;

-- 2. Drop indexes (optional — CASCADE would handle it, but explicit is clearer)
DROP INDEX IF EXISTS idx_test_plans_user;
DROP INDEX IF EXISTS idx_test_plans_status;
DROP INDEX IF EXISTS idx_test_plans_expires;

-- 3. Drop the table
DROP TABLE IF EXISTS test_plans;
