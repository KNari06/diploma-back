-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║              CLEANUP OLD MIGRATION FUNCTIONS                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Run this FIRST to remove all existing migration functions
-- before running complete-anonymous-migration.sql

SET search_path TO public;

-- Drop all possible versions of migration functions
-- Using CASCADE to remove dependencies

-- Drop check functions
DROP FUNCTION IF EXISTS public.check_anonymous_data(TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.check_anonymous_data(p_anonymous_id TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.check_anonymous_data_complete(TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.check_anonymous_data_complete(p_anonymous_id TEXT) CASCADE;

-- Drop migration functions with different signatures
DROP FUNCTION IF EXISTS public.migrate_anonymous_to_authenticated(TEXT, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.migrate_anonymous_to_authenticated(p_anonymous_id TEXT, p_user_id UUID) CASCADE;
DROP FUNCTION IF EXISTS public.migrate_anonymous_to_authenticated(TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.migrate_anonymous_to_authenticated_complete(TEXT, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.migrate_anonymous_to_authenticated_complete(p_anonymous_id TEXT, p_user_id UUID) CASCADE;

-- Success message
DO $$
BEGIN
  RAISE NOTICE '✅ All old migration functions dropped successfully';
  RAISE NOTICE '🚀 Now run complete-anonymous-migration.sql';
END $$;
