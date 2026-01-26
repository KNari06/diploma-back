-- ============================================================================
-- TESTS: EXECUTED STEPS (batched after completion)
-- ============================================================================
-- Stores executed step/progress history for a test AFTER it finishes.
-- This is used to restore completed steps in UI after page reload.
-- ============================================================================

ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS executed_steps JSONB;

