-- Migration: workspace_dedicated_device — pin a workspace to a specific
-- mobile runner device (redroid container) for fully-dedicated emulator access.
--
-- One row per workspace (UNIQUE workspace_id). The backend reads this map at
-- mobile-session acquisition: if a workspace has an active row, its runs are
-- pinned to runner_serial and never touch the shared pool.
--
-- Mirrors workspace_credits (features/workspace-org-members.sql) for structure,
-- index, RLS-via-check_workspace_membership, and the updated_at trigger.
--
-- Populated MANUALLY by ops on day 1 (no auto-provisioning). runner_serial is
-- internal infra (host:port of a redroid container), so SELECT is OWNER-ONLY —
-- it must not leak to non-owner members or client JWTs via PostgREST. The
-- backend itself reads through supabaseAdmin (service role, bypasses RLS).

CREATE TABLE IF NOT EXISTS workspace_dedicated_device (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    runner_serial TEXT NOT NULL,            -- e.g. '10.0.0.5:5606' (host:port of the dedicated container)
    runner_url TEXT,                        -- nullable; reserved for future per-workspace runner (Model B)
    is_active BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,                             -- ops note: who/when provisioned
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance index (lookup is always by workspace_id)
CREATE INDEX IF NOT EXISTS idx_workspace_dedicated_device_workspace_id
    ON workspace_dedicated_device(workspace_id);

-- RLS: owner-only for both read and write. runner_serial is internal infra;
-- non-owner members have no business seeing it. Uses check_workspace_membership
-- (SECURITY DEFINER) — the same helper workspace_credits uses — to avoid RLS
-- recursion and the cross-tenant leak class of bug.
ALTER TABLE workspace_dedicated_device ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view workspace dedicated device" ON workspace_dedicated_device
    FOR SELECT USING (
        public.check_workspace_membership(workspace_id, ARRAY['owner'])
    );

CREATE POLICY "Owners can manage workspace dedicated device" ON workspace_dedicated_device
    FOR ALL USING (
        public.check_workspace_membership(workspace_id, ARRAY['owner'])
    );

-- updated_at trigger (guarded — only if the shared helper exists; mirrors
-- workspace_credits).
DROP TRIGGER IF EXISTS update_workspace_dedicated_device_updated_at ON workspace_dedicated_device;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'update_updated_at_column'
    ) THEN
        CREATE TRIGGER update_workspace_dedicated_device_updated_at
            BEFORE UPDATE ON workspace_dedicated_device
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

COMMENT ON TABLE workspace_dedicated_device IS
    'Maps a workspace to a dedicated mobile runner device (redroid container) for fully-dedicated emulator routing. One row per workspace; populated manually by ops.';
