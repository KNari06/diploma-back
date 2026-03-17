-- ============================================================================
-- Migration: Move bug_pattern records from workspace_memory to intelligent_test_findings
-- Date: 2026-03-17
-- Description:
--   Bug patterns were incorrectly stored in workspace_memory (Skills tab).
--   They should live in intelligent_test_findings (Patterns tab).
--   This migration:
--   1. Inserts existing bug_pattern records into intelligent_test_findings
--      (linked to a session via testId stored in metadata)
--   2. Deletes bug_pattern records from workspace_memory
-- ============================================================================

-- Step 1: Migrate bug_pattern records that have a valid session link
INSERT INTO intelligent_test_findings (
  session_id,
  finding_type,
  severity,
  title,
  description,
  ai_confidence,
  status
)
SELECT
  its.id AS session_id,
  'bug' AS finding_type,
  COALESCE(wm.metadata->>'severity', 'medium') AS severity,
  wm.key AS title,
  wm.content AS description,
  COALESCE(wm.confidence, 0.7) AS ai_confidence,
  'new' AS status
FROM workspace_memory wm
JOIN intelligent_test_sessions its
  ON its.test_id = (wm.metadata->>'testId')::uuid
WHERE wm.category = 'bug_pattern'
  AND wm.metadata->>'testId' IS NOT NULL
  -- Avoid duplicates: only insert if no finding with same title+session exists
  AND NOT EXISTS (
    SELECT 1 FROM intelligent_test_findings itf
    WHERE itf.session_id = its.id
      AND itf.title = wm.key
  );

-- Step 2: Delete ALL bug_pattern records from workspace_memory
DELETE FROM workspace_memory
WHERE category = 'bug_pattern';
