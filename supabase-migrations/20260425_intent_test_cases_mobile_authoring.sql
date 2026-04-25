-- ═════════════════════════════════════════════════════════════════════
-- Phase 6 — Mobile authoring support for intent_test_cases
-- ═════════════════════════════════════════════════════════════════════
--
-- Two CHECK constraints on intent_test_cases need to grow before mobile_agent
-- can persist authored test cases:
--
-- 1) `replay_strategy` — currently restricted to ('commands', 'graph_extract').
--    The `RegressionSaveService` already writes 'mobile_steps' (when saving a
--    mobile recording) and 'steps_editor' (when saving a web step-editor
--    draft); both branches exist in code (regression-save.service.ts:275-277)
--    but would fail the CHECK at insert time. This migration makes the schema
--    catch up with the service.
--
-- 2) `platform` — currently allows ('web', 'mobile_android', 'mobile_ios')
--    but mobile_agent supports Flutter and (via the runner's React-Native
--    sessions) any RN-on-Android/iOS host. We add 'mobile_flutter' so Flutter
--    drafts can save without violating the constraint.
--
-- Both ALTERs use DROP+ADD because PostgreSQL doesn't support modifying a
-- named CHECK in place. They are idempotent: the new constraint is only
-- added if it doesn't already exist (we re-run safely).
--
-- Backwards compatibility: every value that was valid before is still valid.
-- Existing rows with 'commands' / 'graph_extract' / 'web' / 'mobile_android'
-- continue to satisfy the new constraints unchanged.
--
-- Atomicity: both ALTERs are wrapped in a single transaction so a partial
-- apply can't leave us with replay_strategy fixed but platform stuck on
-- the old enum (or vice versa). DDL is transactional in Postgres.
-- ═════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Expand replay_strategy CHECK
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Drop the old constraint by name. Name was assigned implicitly by the
  -- 20260201_001_intent_test_cases_unify migration (PG uses `<table>_<col>_check`).
  IF EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'intent_test_cases_replay_strategy_check'
  ) THEN
    ALTER TABLE intent_test_cases
      DROP CONSTRAINT intent_test_cases_replay_strategy_check;
  END IF;
END$$;

ALTER TABLE intent_test_cases
  ADD CONSTRAINT intent_test_cases_replay_strategy_check
  CHECK (replay_strategy IN (
    'commands',       -- compiled Playwright commands (web, completed test)
    'graph_extract',  -- legacy: extract from graph_data at run time
    'steps_editor',   -- web step-editor authoring (steps_json source of truth)
    'mobile_steps'    -- mobile authoring (steps_json with MobileIntentStep[])
  ));

COMMENT ON COLUMN intent_test_cases.replay_strategy IS
  'How replay reads the test: commands (compiled web), graph_extract (legacy), '
  'steps_editor (web step-editor authoring), mobile_steps (mobile authoring).';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Expand platform CHECK to include mobile_flutter
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'intent_test_cases_platform_check'
  ) THEN
    ALTER TABLE intent_test_cases
      DROP CONSTRAINT intent_test_cases_platform_check;
  END IF;
END$$;

ALTER TABLE intent_test_cases
  ADD CONSTRAINT intent_test_cases_platform_check
  CHECK (platform IN ('web', 'mobile_android', 'mobile_ios', 'mobile_flutter'));

COMMENT ON COLUMN intent_test_cases.platform IS
  'Testing platform: web (default), mobile_android, mobile_ios, or mobile_flutter. '
  'Mobile platforms route through dispatchMobileTest at replay time.';

COMMIT;
