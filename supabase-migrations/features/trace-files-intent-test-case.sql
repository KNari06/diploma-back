-- =====================================================
-- Migration: trace_files.intent_test_case_id column
-- =====================================================
-- Description: Adds a separate column on `trace_files` to link a trace to
--              the `intent_test_cases` row it came from. Previously, code
--              was placing an intent_test_cases.id into `trace_files.test_id`,
--              which has a FK on `tests(id)` — that always failed with
--              "violates foreign key constraint fk_trace_files_test_id"
--              for any preview_run / draft_run of an intent test case.
--
-- After this migration:
--   * `test_id`              → FK to tests(id)              (legacy runner)
--   * `intent_test_case_id`  → FK to intent_test_cases(id)  (preview/editor runner)
--
-- Both columns are nullable. Exactly one of them is expected to be set
-- per row (or both NULL for standalone/editor traces).
--
-- This migration is idempotent and safe to re-run.
--
-- Created: 2026-04-07

-- =====================================================
-- 1. Add the column (nullable)
-- =====================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'trace_files'
      AND column_name = 'intent_test_case_id'
  ) THEN
    ALTER TABLE public.trace_files
      ADD COLUMN intent_test_case_id UUID;
    RAISE NOTICE 'Added trace_files.intent_test_case_id column.';
  ELSE
    RAISE NOTICE 'trace_files.intent_test_case_id already exists. Skipping ADD COLUMN.';
  END IF;
END
$$;

-- =====================================================
-- 2. Add FK constraint → intent_test_cases(id)
-- =====================================================
-- Only add the FK if the intent_test_cases table exists AND the constraint
-- is not already present. ON DELETE SET NULL so deleting an intent test case
-- does not cascade-delete its historical trace files.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'intent_test_cases'
  ) THEN
    RAISE NOTICE 'intent_test_cases table does not exist. Skipping FK.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_trace_files_intent_test_case_id'
  ) THEN
    RAISE NOTICE 'fk_trace_files_intent_test_case_id already exists. Skipping.';
    RETURN;
  END IF;

  ALTER TABLE public.trace_files
    ADD CONSTRAINT fk_trace_files_intent_test_case_id
    FOREIGN KEY (intent_test_case_id)
    REFERENCES public.intent_test_cases(id)
    ON DELETE SET NULL;

  RAISE NOTICE 'Added fk_trace_files_intent_test_case_id constraint.';
END
$$;

-- =====================================================
-- 3. Index for lookups by intent_test_case_id
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_trace_files_intent_test_case_id
  ON public.trace_files(intent_test_case_id);

-- =====================================================
-- 4. Column documentation
-- =====================================================
COMMENT ON COLUMN public.trace_files.intent_test_case_id IS
  'Associated intent_test_cases row (nullable). Used for traces produced by preview/editor runs of intent test cases. FK to intent_test_cases(id) ON DELETE SET NULL.';
