-- Anonymous to Authenticated User Migration
-- Seamlessly migrate anonymous user data when they register/login

SET search_path TO public;

-- Function to migrate all anonymous data to authenticated user
CREATE OR REPLACE FUNCTION public.migrate_anonymous_to_authenticated(
  p_anonymous_id TEXT,
  p_user_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_migrated_sessions INTEGER := 0;
  v_migrated_messages INTEGER := 0;
  v_migrated_environments INTEGER := 0;
  v_migrated_endpoints INTEGER := 0;
  v_result JSONB;
BEGIN
  -- Start transaction
  BEGIN
    -- 1. Migrate anonymous chat sessions
    -- Update anonymous_id to link with user_id (keep for reference)
    UPDATE public.anonymous_chat_sessions
    SET
      anonymous_id = CONCAT(anonymous_id, '_migrated_to_', p_user_id),
      updated_at = NOW()
    WHERE anonymous_id = p_anonymous_id
    AND NOT anonymous_id LIKE '%_migrated_to_%';

    GET DIAGNOSTICS v_migrated_sessions = ROW_COUNT;

    -- 2. Messages are linked via session_id, so they automatically migrate
    SELECT COUNT(*) INTO v_migrated_messages
    FROM public.anonymous_chat_messages acm
    JOIN public.anonymous_chat_sessions acs ON acm.session_id = acs.id
    WHERE acs.anonymous_id = CONCAT(p_anonymous_id, '_migrated_to_', p_user_id);

    -- 3. Migrate API environments (if table exists)
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'api_environments') THEN
      UPDATE public.api_environments
      SET
        user_id = p_user_id,
        updated_at = NOW()
      WHERE user_id::TEXT = p_anonymous_id
      AND NOT EXISTS (
        -- Avoid duplicates if user already has environment with same base_url
        SELECT 1 FROM public.api_environments ae2
        WHERE ae2.user_id = p_user_id
        AND ae2.base_url = api_environments.base_url
      );

      GET DIAGNOSTICS v_migrated_environments = ROW_COUNT;

      -- 4. Migrate API endpoints (linked via environment_id)
      IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'api_endpoints') THEN
        SELECT COUNT(*) INTO v_migrated_endpoints
        FROM public.api_endpoints ep
        JOIN public.api_environments env ON ep.environment_id = env.id
        WHERE env.user_id = p_user_id
        AND env.updated_at >= NOW() - INTERVAL '1 minute'; -- Just migrated
      END IF;
    END IF;

    -- 5. Delete anonymous usage limits (reset rate limit)
    DELETE FROM public.anonymous_usage_limits
    WHERE anonymous_id = p_anonymous_id;

    -- Build result JSON
    v_result := jsonb_build_object(
      'success', true,
      'anonymous_id', p_anonymous_id,
      'user_id', p_user_id,
      'migrated', jsonb_build_object(
        'chat_sessions', v_migrated_sessions,
        'chat_messages', v_migrated_messages,
        'api_environments', v_migrated_environments,
        'api_endpoints', v_migrated_endpoints
      ),
      'migrated_at', NOW()
    );

    RETURN v_result;

  EXCEPTION
    WHEN OTHERS THEN
      -- Rollback on error
      RAISE EXCEPTION 'Migration failed: %', SQLERRM;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if anonymous user has any data to migrate
CREATE OR REPLACE FUNCTION public.check_anonymous_data(
  p_anonymous_id TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_has_sessions BOOLEAN;
  v_has_environments BOOLEAN;
  v_session_count INTEGER;
  v_message_count INTEGER;
  v_environment_count INTEGER;
BEGIN
  -- Check for chat sessions
  SELECT
    COUNT(*) > 0,
    COUNT(*)
  INTO v_has_sessions, v_session_count
  FROM public.anonymous_chat_sessions
  WHERE anonymous_id = p_anonymous_id
  AND NOT anonymous_id LIKE '%_migrated_to_%';

  -- Count messages
  SELECT COUNT(*) INTO v_message_count
  FROM public.anonymous_chat_messages acm
  JOIN public.anonymous_chat_sessions acs ON acm.session_id = acs.id
  WHERE acs.anonymous_id = p_anonymous_id
  AND NOT acs.anonymous_id LIKE '%_migrated_to_%';

  -- Check for API environments (if table exists)
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'api_environments') THEN
    SELECT
      COUNT(*) > 0,
      COUNT(*)
    INTO v_has_environments, v_environment_count
    FROM public.api_environments
    WHERE user_id::TEXT = p_anonymous_id;
  ELSE
    v_has_environments := false;
    v_environment_count := 0;
  END IF;

  RETURN jsonb_build_object(
    'has_data', (v_has_sessions OR v_has_environments),
    'counts', jsonb_build_object(
      'sessions', v_session_count,
      'messages', v_message_count,
      'environments', v_environment_count
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create index for faster migration queries
CREATE INDEX IF NOT EXISTS idx_anon_sessions_anonymous_id_not_migrated
  ON public.anonymous_chat_sessions(anonymous_id)
  WHERE NOT anonymous_id LIKE '%_migrated_to_%';

-- Comments
COMMENT ON FUNCTION public.migrate_anonymous_to_authenticated IS
  'Migrates all anonymous user data (chat sessions, messages, API configs) to authenticated user';

COMMENT ON FUNCTION public.check_anonymous_data IS
  'Checks if anonymous user has any data that can be migrated';

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.migrate_anonymous_to_authenticated TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_anonymous_data TO authenticated;
