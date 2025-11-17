-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║              COMPLETE ANONYMOUS TO AUTHENTICATED MIGRATION               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- This migration function handles ALL user data when anonymous user
-- registers or logs in. It ensures no data is lost during the transition.

SET search_path TO public;

-- NOTE: If you get "function name is not unique" error,
-- run cleanup-old-migration-functions.sql FIRST!

-- Complete migration function that handles ALL tables
CREATE OR REPLACE FUNCTION public.migrate_anonymous_to_authenticated_complete(
  p_anonymous_id TEXT,  -- IP address (e.g., "192.168.1.100")
  p_user_id UUID       -- New authenticated user UUID
)
RETURNS JSONB AS $$
DECLARE
  v_migrated_workspaces INTEGER := 0;
  v_migrated_projects INTEGER := 0;
  v_migrated_tests INTEGER := 0;
  v_migrated_chat_sessions INTEGER := 0;
  v_migrated_chat_messages INTEGER := 0;
  v_migrated_api_environments INTEGER := 0;
  v_migrated_api_endpoints INTEGER := 0;
  v_migrated_credits INTEGER := 0;
  v_migrated_transactions INTEGER := 0;
  v_regular_sessions INTEGER := 0;
  v_result JSONB;
BEGIN
  -- Start migration process
  RAISE NOTICE 'Starting complete migration: % → %', p_anonymous_id, p_user_id;

  -- ═══════════════════════════════════════════════════════════════════════
    -- 1. MIGRATE WORKSPACES (Core: user owns workspaces)
    -- ═══════════════════════════════════════════════════════════════════════

    UPDATE public.workspaces
    SET user_id = p_user_id::TEXT
    WHERE user_id = p_anonymous_id
    AND user_id != p_user_id::TEXT; -- Avoid unnecessary updates

    GET DIAGNOSTICS v_migrated_workspaces = ROW_COUNT;
    RAISE NOTICE 'Migrated workspaces: %', v_migrated_workspaces;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 2. MIGRATE PROJECTS (Core: user owns projects within workspaces)
    -- ═══════════════════════════════════════════════════════════════════════

    UPDATE public.projects
    SET user_id = p_user_id::TEXT
    WHERE user_id = p_anonymous_id
    AND user_id != p_user_id::TEXT; -- Avoid unnecessary updates

    GET DIAGNOSTICS v_migrated_projects = ROW_COUNT;
    RAISE NOTICE 'Migrated projects: %', v_migrated_projects;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 3. MIGRATE TESTS (Tests belong to projects, user_id can be null)
    -- ═══════════════════════════════════════════════════════════════════════

    -- Update tests that belong to migrated projects
    -- Tests may have user_id = null for anonymous, but project_id links them
    UPDATE public.tests
    SET user_id = p_user_id
    WHERE project_id IN (
      SELECT id FROM public.projects WHERE user_id = p_user_id::TEXT
    )
    AND (user_id IS NULL OR user_id != p_user_id);

    GET DIAGNOSTICS v_migrated_tests = ROW_COUNT;
    RAISE NOTICE 'Migrated tests: %', v_migrated_tests;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 4. MIGRATE CHAT SESSIONS (Anonymous chat sessions)
    -- ═══════════════════════════════════════════════════════════════════════

    -- For anonymous_chat_sessions table (if exists)
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'anonymous_chat_sessions') THEN
      UPDATE public.anonymous_chat_sessions
      SET anonymous_id = CONCAT(anonymous_id, '_migrated_to_', p_user_id)
      WHERE anonymous_id = p_anonymous_id
      AND NOT anonymous_id LIKE '%_migrated_to_%';

      GET DIAGNOSTICS v_migrated_chat_sessions = ROW_COUNT;

      -- Count migrated messages
      SELECT COUNT(*) INTO v_migrated_chat_messages
      FROM public.anonymous_chat_messages acm
      JOIN public.anonymous_chat_sessions acs ON acm.session_id = acs.id
      WHERE acs.anonymous_id = CONCAT(p_anonymous_id, '_migrated_to_', p_user_id);
    END IF;

    -- For regular chat_sessions table (if exists)
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'chat_sessions') THEN
      UPDATE public.chat_sessions
      SET user_id = p_user_id::TEXT
      WHERE user_id = p_anonymous_id
      AND user_id != p_user_id::TEXT;

      GET DIAGNOSTICS v_regular_sessions = ROW_COUNT;
      v_migrated_chat_sessions := v_migrated_chat_sessions + v_regular_sessions;

      -- Count messages in regular chat_messages (use session count as proxy)
      v_migrated_chat_messages := v_regular_sessions;
    END IF;

    RAISE NOTICE 'Migrated chat sessions: %, messages: %', v_migrated_chat_sessions, v_migrated_chat_messages;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 5. MIGRATE API ENVIRONMENTS & ENDPOINTS
    -- ═══════════════════════════════════════════════════════════════════════

    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'api_environments') THEN
      UPDATE public.api_environments
      SET user_id = p_user_id::TEXT
      WHERE user_id = p_anonymous_id
      AND NOT EXISTS (
        -- Avoid duplicates if user already has environment with same base_url
        SELECT 1 FROM public.api_environments ae2
        WHERE ae2.user_id = p_user_id::TEXT
        AND ae2.base_url = api_environments.base_url
      );

      GET DIAGNOSTICS v_migrated_api_environments = ROW_COUNT;

      -- Count migrated endpoints
      IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'api_endpoints') THEN
        -- Count endpoints (use environment count as proxy)
        v_migrated_api_endpoints := v_migrated_api_environments;
      END IF;
    END IF;

    RAISE NOTICE 'Migrated API environments: %, endpoints: %', v_migrated_api_environments, v_migrated_api_endpoints;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 6. MIGRATE USER CREDITS & TRANSACTIONS
    -- ═══════════════════════════════════════════════════════════════════════

    -- Migrate user credits (if anonymous user had credits)
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_credits') THEN
      -- Check if anonymous user has credits
      IF EXISTS (SELECT 1 FROM public.user_credits WHERE user_id = p_anonymous_id) THEN
        -- Get or create authenticated user credits
        INSERT INTO public.user_credits (
          user_id,
          credits_balance,
          total_purchased,
          total_used,
          subscription_plan,
          subscription_status
        )
        VALUES (p_user_id::TEXT, 0, 0, 0, 'free', 'inactive')
        ON CONFLICT (user_id) DO NOTHING;

        -- Transfer credits from anonymous to authenticated
        WITH anon_credits AS (
          SELECT
            COALESCE(credits_balance, 0) as balance,
            COALESCE(total_purchased, 0) as purchased,
            COALESCE(total_used, 0) as used
          FROM public.user_credits
          WHERE user_id = p_anonymous_id
        )
        UPDATE public.user_credits
        SET
          credits_balance = credits_balance + (SELECT balance FROM anon_credits),
          total_purchased = total_purchased + (SELECT purchased FROM anon_credits),
          total_used = total_used + (SELECT used FROM anon_credits)
        WHERE user_id = p_user_id::TEXT;

        -- Delete anonymous credits record
        DELETE FROM public.user_credits WHERE user_id = p_anonymous_id;

        v_migrated_credits := 1;
      END IF;

      -- Migrate credit transactions
      IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'credit_transactions') THEN
        UPDATE public.credit_transactions
        SET user_id = p_user_id::TEXT
        WHERE user_id = p_anonymous_id;

        GET DIAGNOSTICS v_migrated_transactions = ROW_COUNT;
      END IF;
    END IF;

    RAISE NOTICE 'Migrated credits: %, transactions: %', v_migrated_credits, v_migrated_transactions;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 7. CLEANUP ANONYMOUS DATA
    -- ═══════════════════════════════════════════════════════════════════════

    -- Delete anonymous usage limits (reset rate limit)
    DELETE FROM public.anonymous_usage_limits
    WHERE anonymous_id = p_anonymous_id;

    RAISE NOTICE 'Cleaned up anonymous usage limits for: %', p_anonymous_id;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 8. BUILD RESULT
    -- ═══════════════════════════════════════════════════════════════════════

    v_result := jsonb_build_object(
      'success', true,
      'anonymous_id', p_anonymous_id,
      'user_id', p_user_id,
      'migrated', jsonb_build_object(
        'workspaces', v_migrated_workspaces,
        'projects', v_migrated_projects,
        'tests', v_migrated_tests,
        'chat_sessions', v_migrated_chat_sessions,
        'chat_messages', v_migrated_chat_messages,
        'api_environments', v_migrated_api_environments,
        'api_endpoints', v_migrated_api_endpoints,
        'credits', v_migrated_credits,
        'transactions', v_migrated_transactions
      ),
      'migrated_at', NOW()
    );

    RAISE NOTICE 'Migration completed successfully: %', v_result;
    RETURN v_result;

EXCEPTION
  WHEN OTHERS THEN
    -- Rollback on error
    RAISE EXCEPTION 'Complete migration failed for % → %: %', p_anonymous_id, p_user_id, SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════
-- COMPLETE CHECK FUNCTION FOR ANONYMOUS DATA
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_anonymous_data_complete(
  p_anonymous_id TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_workspace_count INTEGER := 0;
  v_project_count INTEGER := 0;
  v_test_count INTEGER := 0;
  v_session_count INTEGER := 0;
  v_message_count INTEGER := 0;
  v_environment_count INTEGER := 0;
  v_has_data BOOLEAN := false;
BEGIN
  -- Check workspaces
  SELECT COUNT(*) INTO v_workspace_count
  FROM public.workspaces
  WHERE user_id = p_anonymous_id;

  -- Check projects
  SELECT COUNT(*) INTO v_project_count
  FROM public.projects
  WHERE user_id = p_anonymous_id;

  -- Check tests (via projects)
  SELECT COUNT(*) INTO v_test_count
  FROM public.tests
  WHERE project_id IN (SELECT id FROM public.projects WHERE user_id = p_anonymous_id);

  -- Check chat sessions (anonymous_chat_sessions)
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'anonymous_chat_sessions') THEN
    SELECT COUNT(*) INTO v_session_count
    FROM public.anonymous_chat_sessions
    WHERE anonymous_id = p_anonymous_id
    AND NOT anonymous_id LIKE '%_migrated_to_%';
  END IF;

  -- Check regular chat sessions
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'chat_sessions') THEN
    SELECT COUNT(*) INTO v_session_count
    FROM public.chat_sessions
    WHERE user_id = p_anonymous_id;
  END IF;

  -- Count messages
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'anonymous_chat_messages') THEN
    SELECT COUNT(*) INTO v_message_count
    FROM public.anonymous_chat_messages acm
    JOIN public.anonymous_chat_sessions acs ON acm.session_id = acs.id
    WHERE acs.anonymous_id = p_anonymous_id
    AND NOT acs.anonymous_id LIKE '%_migrated_to_%';
  END IF;

  -- Check API environments
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'api_environments') THEN
    SELECT COUNT(*) INTO v_environment_count
    FROM public.api_environments
    WHERE user_id = p_anonymous_id;
  END IF;

  -- Determine if there's any data
  v_has_data := (v_workspace_count > 0 OR v_project_count > 0 OR v_test_count > 0 OR
                 v_session_count > 0 OR v_message_count > 0 OR v_environment_count > 0);

  RETURN jsonb_build_object(
    'has_data', v_has_data,
    'counts', jsonb_build_object(
      'workspaces', v_workspace_count,
      'projects', v_project_count,
      'tests', v_test_count,
      'sessions', v_session_count,
      'messages', v_message_count,
      'environments', v_environment_count
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════
-- REPLACE OLD FUNCTION WITH NEW ONE
-- ═══════════════════════════════════════════════════════════════════════════

-- Create wrapper function that maintains backward compatibility
CREATE OR REPLACE FUNCTION public.migrate_anonymous_to_authenticated(
  p_anonymous_id TEXT,
  p_user_id UUID
)
RETURNS JSONB AS $$
BEGIN
  -- Call the complete migration function
  RETURN migrate_anonymous_to_authenticated_complete(p_anonymous_id, p_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create wrapper for check function
CREATE OR REPLACE FUNCTION public.check_anonymous_data(
  p_anonymous_id TEXT
)
RETURNS JSONB AS $$
BEGIN
  -- Call the complete check function
  RETURN check_anonymous_data_complete(p_anonymous_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════
-- COMMENTS & PERMISSIONS
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON FUNCTION public.migrate_anonymous_to_authenticated_complete IS
  'Complete migration of ALL anonymous user data to authenticated user account. Handles workspaces, projects, tests, chat sessions, API configs, and credits.';

COMMENT ON FUNCTION public.migrate_anonymous_to_authenticated IS
  'Backward-compatible wrapper for complete anonymous data migration';

COMMENT ON FUNCTION public.check_anonymous_data_complete IS
  'Complete check for ALL anonymous user data including workspaces, projects, tests, chat sessions, API configs, and credits.';

COMMENT ON FUNCTION public.check_anonymous_data IS
  'Backward-compatible wrapper for complete anonymous data check';

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.migrate_anonymous_to_authenticated_complete TO authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_anonymous_to_authenticated TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_anonymous_data_complete TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_anonymous_data TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (for testing)
-- ═══════════════════════════════════════════════════════════════════════════

/*
-- Test the migration (DO NOT RUN IN PRODUCTION without backup!)

-- 1. Check what data exists for anonymous user
SELECT 'workspaces' as table_name, COUNT(*) as count FROM workspaces WHERE user_id = '192.168.1.100'
UNION ALL
SELECT 'projects', COUNT(*) FROM projects WHERE user_id = '192.168.1.100'
UNION ALL
SELECT 'tests', COUNT(*) FROM tests WHERE project_id IN (SELECT id FROM projects WHERE user_id = '192.168.1.100')
UNION ALL
SELECT 'chat_sessions', COUNT(*) FROM chat_sessions WHERE user_id = '192.168.1.100';

-- 2. Run migration
SELECT migrate_anonymous_to_authenticated('192.168.1.100', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::UUID);

-- 3. Verify migration
SELECT 'workspaces' as table_name, COUNT(*) as count FROM workspaces WHERE user_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
UNION ALL
SELECT 'projects', COUNT(*) FROM projects WHERE user_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
UNION ALL
SELECT 'tests', COUNT(*) FROM tests WHERE user_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
*/
