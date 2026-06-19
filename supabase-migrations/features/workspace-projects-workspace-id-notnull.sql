-- Migration: Enforce projects.workspace_id NOT NULL.
--
-- PREREQUISITE: run workspace-projects-workspace-id-backfill.sql FIRST, in an
-- EARLIER deploy, and confirm it reported 0 remaining NULLs. Splitting the two
-- across deploys avoids a race where the constraint is validated before the
-- backfill has committed.
--
-- This completes the deferral noted in workspaces.sql:
--   "-- ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;"
-- Every project must belong to a workspace — workspace_id keys access control,
-- billing, telemetry, and dedicated-emulator routing.
--
-- Guarded: if any NULL remains, the explicit check below raises BEFORE the
-- ALTER, so the migration fails with a clear message instead of Postgres'
-- generic "column contains null values".

DO $$
DECLARE
    remaining INT;
BEGIN
    SELECT COUNT(*) INTO remaining FROM projects WHERE workspace_id IS NULL;
    IF remaining > 0 THEN
        RAISE EXCEPTION
            'Cannot set projects.workspace_id NOT NULL: % row(s) still NULL. Run workspace-projects-workspace-id-backfill.sql first.',
            remaining;
    END IF;
END $$;

ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;
