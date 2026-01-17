-- =====================================================
-- Migration: trace_files.user_id UUID → TEXT alignment
-- =====================================================
-- Description: Ensure trace_files.user_id is TEXT (not UUID) to align with
--              the standardized "text user id" schema convention used in
--              recreate-all-tables-with-text-user-id.sql.
--
-- This is a forward-safe migration: if user_id is already TEXT, nothing changes.
-- If it's UUID, we cast existing values to TEXT.
-- RLS policies already use ::text casts so they remain valid.
--
-- Created: 2026-01-17

DO $$
DECLARE
  col_type text;
BEGIN
  -- Get current data type of user_id in trace_files
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'trace_files'
    AND column_name = 'user_id';

  IF col_type IS NULL THEN
    RAISE NOTICE 'trace_files.user_id column not found (table may not exist). Skipping.';
  ELSIF col_type = 'text' OR col_type = 'character varying' THEN
    RAISE NOTICE 'trace_files.user_id is already TEXT. No change needed.';
  ELSE
    -- Column exists and is not TEXT (likely uuid), alter it
    RAISE NOTICE 'Altering trace_files.user_id from % to TEXT...', col_type;

    ALTER TABLE public.trace_files
      ALTER COLUMN user_id TYPE TEXT USING user_id::text;

    RAISE NOTICE 'trace_files.user_id successfully converted to TEXT.';
  END IF;
END
$$;

-- Ensure NOT NULL constraint still present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'trace_files'
      AND column_name = 'user_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE public.trace_files
      ALTER COLUMN user_id SET NOT NULL;
    RAISE NOTICE 'Added NOT NULL constraint to trace_files.user_id.';
  END IF;
END
$$;

-- =====================================================
-- Verify RLS policies (no changes needed, they use ::text)
-- =====================================================
-- Example existing policy: USING (auth.uid()::text = user_id::text)
-- With user_id now TEXT, the cast user_id::text is no-op but still valid.

COMMENT ON COLUMN public.trace_files.user_id IS 'User ID who uploaded the trace (TEXT for broad compatibility)';
