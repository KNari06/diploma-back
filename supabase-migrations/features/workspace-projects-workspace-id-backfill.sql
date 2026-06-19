-- Migration: Backfill projects.workspace_id for any rows still missing it.
--
-- Idempotent re-run of the workspaces.sql backfill. The original backfill ran
-- once when the workspaces feature shipped, but projects.workspace_id is still
-- NULLABLE (the NOT NULL was deliberately deferred). This re-asserts the
-- invariant "every project belongs to a workspace" so the follow-up
-- workspace-projects-workspace-id-notnull.sql migration can SET NOT NULL safely.
--
-- Deploy ORDER (do not merge into the NOT NULL migration — that risks the
-- backfill not committing before the constraint is checked):
--   1. This migration (backfill) + the code that stops persisting '' as a
--      workspaceId for mobile jobs.
--   2. NEXT deploy: workspace-projects-workspace-id-notnull.sql.
--
-- Safe to run multiple times: every UPDATE is guarded by `workspace_id IS NULL`
-- and workspace creation uses ON CONFLICT DO NOTHING / NOT EXISTS guards.

DO $$
DECLARE
    user_record RECORD;
    default_workspace_id UUID;
    system_user_id UUID := '00000000-0000-0000-0000-000000000000';
    system_workspace_id UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
    -- System/anonymous workspace (idempotent).
    INSERT INTO workspaces (id, name, user_id, platforms, api_testing, dev_base_url, settings)
    VALUES (
        system_workspace_id,
        'Default Workspace (Anonymous)',
        system_user_id,
        ARRAY['web(chrome, safari, firefox)'],
        false,
        NULL,
        '{}'::jsonb
    )
    ON CONFLICT (id) DO NOTHING;

    -- System projects → system workspace.
    UPDATE projects
    SET workspace_id = system_workspace_id
    WHERE user_id = system_user_id
      AND workspace_id IS NULL;

    -- Every real user that owns a project but has no workspace yet gets one,
    -- then all their workspace-less projects point at it.
    FOR user_record IN
        SELECT DISTINCT p.user_id
        FROM projects p
        WHERE p.user_id != system_user_id
          AND p.workspace_id IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM workspaces w WHERE w.user_id = p.user_id
          )
    LOOP
        INSERT INTO workspaces (id, name, user_id, platforms, api_testing, dev_base_url, settings)
        VALUES (
            gen_random_uuid(),
            'Default Workspace',
            user_record.user_id,
            ARRAY['web(chrome, safari, firefox)'],
            false,
            NULL,
            '{}'::jsonb
        )
        RETURNING id INTO default_workspace_id;

        UPDATE projects
        SET workspace_id = default_workspace_id
        WHERE user_id = user_record.user_id
          AND workspace_id IS NULL;
    END LOOP;

    -- Catch-all: a user who already HAS a workspace but somehow still owns a
    -- workspace-less project (the original backfill's FOR loop skipped users
    -- who had any workspace). Attach those orphans to that user's oldest
    -- workspace so none are left behind before the NOT NULL migration.
    FOR user_record IN
        SELECT DISTINCT p.user_id
        FROM projects p
        WHERE p.user_id != system_user_id
          AND p.workspace_id IS NULL
    LOOP
        SELECT id INTO default_workspace_id
        FROM workspaces
        WHERE user_id = user_record.user_id
        ORDER BY created_at ASC
        LIMIT 1;

        IF default_workspace_id IS NOT NULL THEN
            UPDATE projects
            SET workspace_id = default_workspace_id
            WHERE user_id = user_record.user_id
              AND workspace_id IS NULL;
        END IF;
    END LOOP;
END $$;

-- Verification (informational): should report 0 before applying NOT NULL.
DO $$
DECLARE
    remaining INT;
BEGIN
    SELECT COUNT(*) INTO remaining FROM projects WHERE workspace_id IS NULL;
    IF remaining > 0 THEN
        RAISE WARNING 'projects.workspace_id still NULL for % row(s) after backfill — investigate before running the NOT NULL migration', remaining;
    ELSE
        RAISE NOTICE 'Backfill complete: all projects have a workspace_id.';
    END IF;
END $$;
