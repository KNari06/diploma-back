-- ============================================================================
-- Add platform column to test_flows
-- ============================================================================
-- Purpose:
--  - Backend FlowService expects a "platform" column on test_flows to store
--    per-flow platform information (e.g., "web", "mobile_android", "mobile_ios").
--  - Some environments may have been created before this column was added,
--    which leads to PostgREST errors like:
--      "Could not find the 'platform' column of 'test_flows' in the schema cache".
--
-- This migration is safe to run multiple times thanks to IF NOT EXISTS.
-- ============================================================================

ALTER TABLE test_flows
  ADD COLUMN IF NOT EXISTS platform TEXT;

-- Optional: simple index for filtering by platform (non-unique, nullable)
CREATE INDEX IF NOT EXISTS idx_test_flows_platform
  ON test_flows(platform)
  WHERE platform IS NOT NULL;

