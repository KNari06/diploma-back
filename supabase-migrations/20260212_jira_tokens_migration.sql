-- Migration: Copy existing Jira tokens from jira_tokens to integration_tokens
-- This migration provides a zero-downtime path for migrating Jira OAuth tokens
-- to the unified integration_tokens table.
--
-- Run this AFTER deploying the code changes that support dual-read from both tables.
-- The unique constraint (user_id, provider, external_id) handles conflicts gracefully.

DO $$
DECLARE
  migrated_count INTEGER;
  conflict_count INTEGER;
BEGIN
  -- Insert existing jira_tokens into integration_tokens
  WITH inserted AS (
    INSERT INTO integration_tokens (
      id,
      user_id,
      workspace_id,
      provider,
      access_token,
      refresh_token,
      expires_at,
      scope,
      token_type,
      external_id,
      external_url,
      metadata,
      enabled,
      created_at,
      updated_at
    )
    SELECT
      id,
      user_id::UUID,           -- Cast TEXT to UUID
      NULL,                    -- workspace_id (no workspace scoping in legacy system)
      'jira'::VARCHAR(50),     -- provider
      access_token,
      refresh_token,
      expires_at,
      scope,
      token_type,
      cloud_id,                -- cloud_id → external_id
      site_url,                -- site_url → external_url
      '{}'::JSONB,             -- metadata (empty for migrated tokens)
      TRUE,                    -- enabled (all existing tokens are enabled)
      created_at,
      updated_at
    FROM jira_tokens
    ON CONFLICT (user_id, provider, external_id) DO UPDATE SET
      -- If conflict, update with latest data from jira_tokens
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at,
      scope = EXCLUDED.scope,
      token_type = EXCLUDED.token_type,
      external_url = EXCLUDED.external_url,
      updated_at = NOW()
    RETURNING id
  )
  SELECT COUNT(*) INTO migrated_count FROM inserted;

  -- Count existing conflicts (tokens that were already in integration_tokens)
  SELECT COUNT(*)
  INTO conflict_count
  FROM jira_tokens jt
  JOIN integration_tokens it ON
    it.user_id::TEXT = jt.user_id::TEXT
    AND it.provider = 'jira'
    AND it.external_id = jt.cloud_id;

  -- Log migration results
  RAISE NOTICE 'Jira tokens migration completed:';
  RAISE NOTICE '  - Migrated % new tokens', migrated_count;
  RAISE NOTICE '  - Updated % existing tokens (conflicts)', conflict_count;
  RAISE NOTICE '  - Total jira_tokens processed: %', (SELECT COUNT(*) FROM jira_tokens);
END $$;

-- Verify migration
DO $$
DECLARE
  jira_tokens_count INTEGER;
  integration_jira_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO jira_tokens_count FROM jira_tokens;
  SELECT COUNT(*) INTO integration_jira_count FROM integration_tokens WHERE provider = 'jira';

  RAISE NOTICE '';
  RAISE NOTICE 'Migration verification:';
  RAISE NOTICE '  - jira_tokens table: % records', jira_tokens_count;
  RAISE NOTICE '  - integration_tokens (jira): % records', integration_jira_count;

  IF integration_jira_count < jira_tokens_count THEN
    RAISE WARNING 'Some jira_tokens may not have been migrated. Expected at least % Jira tokens in integration_tokens.', jira_tokens_count;
  ELSE
    RAISE NOTICE '  ✓ Migration successful - all Jira tokens present in integration_tokens';
  END IF;
END $$;

-- IMPORTANT NOTES:
-- 1. The jira_tokens table is NOT dropped by this migration
-- 2. The dual-read fallback in jira.service.ts ensures backward compatibility
-- 3. After successful migration and monitoring period:
--    - Remove fallback logic from getJiraToken()
--    - Drop jira_tokens table in a future migration
-- 4. New Jira OAuth connections will save directly to integration_tokens
