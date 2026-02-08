-- ============================================================================
-- WORKSPACE ORGANIZATION MEMBERS & INVITES MIGRATION
-- ============================================================================
-- Adds B2B-style organization layer on top of workspaces:
-- - workspace_members: membership with roles (owner, full_access, view)
-- - workspace_invites: email invitations with status tracking
-- - workspace_credits: org-level credit pool
-- - workspace_credit_transactions: credit usage/purchase history per org
-- - workspace_audit_log: enterprise-ready audit trail
--
-- Compatible with workspaces.user_id as UUID or TEXT (schema may use TEXT for
-- anonymous/IP). Only rows where user_id matches UUID format get owner
-- membership and credits migration; IP/non-UUID values are skipped (no cast).
-- ============================================================================

-- ============================================================================
-- 1. WORKSPACE MEMBERS TABLE
-- ============================================================================
-- Tracks who belongs to which workspace and with what role

CREATE TABLE IF NOT EXISTS workspace_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'full_access', 'view')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Each user can only be a member once per workspace
    CONSTRAINT unique_workspace_member UNIQUE (workspace_id, user_id)
);

-- Enforce exactly 1 active owner per workspace
-- This partial unique index ensures only one row can have role='owner' AND status='active' per workspace
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_single_owner 
    ON workspace_members (workspace_id) 
    WHERE role = 'owner' AND status = 'active';

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_status ON workspace_members(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_workspace_members_role ON workspace_members(role);

-- ============================================================================
-- 2. WORKSPACE INVITES TABLE
-- ============================================================================
-- Tracks pending/accepted/revoked invitations by email

CREATE TABLE IF NOT EXISTS workspace_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('full_access', 'view')), -- owner role cannot be invited, must be transferred
    status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'accepted', 'revoked', 'expired')),
    invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    accepted_at TIMESTAMP WITH TIME ZONE,
    accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    supabase_invite_user_id UUID, -- optional: trace Supabase auth invite ID
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace_id ON workspace_invites(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_email ON workspace_invites(email);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_status ON workspace_invites(status);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace_email ON workspace_invites(workspace_id, email);

-- ============================================================================
-- 3. WORKSPACE CREDITS TABLE (org-level pool)
-- ============================================================================
-- Mirrors user_credits but at workspace/org level

CREATE TABLE IF NOT EXISTS workspace_credits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
    credits_balance NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_purchased NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_used NUMERIC(10,2) NOT NULL DEFAULT 0,
    subscription_plan TEXT DEFAULT 'free' CHECK (subscription_plan IN ('free', 'basic', 'pro', 'enterprise')),
    subscription_status TEXT DEFAULT 'inactive' CHECK (subscription_status IN ('active', 'inactive', 'expired')),
    subscription_expires_at TIMESTAMP WITH TIME ZONE,
    last_credit_usage TIMESTAMP WITH TIME ZONE,
    credits_purchased_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance index
CREATE INDEX IF NOT EXISTS idx_workspace_credits_workspace_id ON workspace_credits(workspace_id);

-- ============================================================================
-- 4. WORKSPACE CREDIT TRANSACTIONS TABLE
-- ============================================================================
-- Records all credit changes at org level

CREATE TABLE IF NOT EXISTS workspace_credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- who triggered the transaction
    amount NUMERIC(10,2) NOT NULL,
    balance_after NUMERIC(10,2) NOT NULL,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('purchase', 'usage', 'refund', 'bonus', 'migration')),
    description TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    tokens_used INTEGER,
    cost_usd NUMERIC(10,6),
    credits_calculated NUMERIC(10,2),
    test_type TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_workspace_credit_transactions_workspace_id ON workspace_credit_transactions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_credit_transactions_user_id ON workspace_credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_credit_transactions_type ON workspace_credit_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_workspace_credit_transactions_created_at ON workspace_credit_transactions(created_at DESC);

-- ============================================================================
-- 5. WORKSPACE AUDIT LOG TABLE (enterprise-ready)
-- ============================================================================
-- Records all important org-level actions for compliance and debugging

CREATE TABLE IF NOT EXISTS workspace_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL, -- e.g., 'invite.created', 'member.removed', 'owner.transferred', 'credits.used'
    target_type TEXT, -- 'user', 'invite', 'resource', etc.
    target_id TEXT, -- UUID or email depending on target_type
    success BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB DEFAULT '{}',
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_workspace_audit_log_workspace_id ON workspace_audit_log(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_audit_log_actor_user_id ON workspace_audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_audit_log_event_type ON workspace_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_workspace_audit_log_created_at ON workspace_audit_log(created_at DESC);

-- ============================================================================
-- 6. TRIGGERS FOR updated_at
-- ============================================================================

-- workspace_members
DROP TRIGGER IF EXISTS update_workspace_members_updated_at ON workspace_members;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'update_updated_at_column'
    ) THEN
        CREATE TRIGGER update_workspace_members_updated_at 
            BEFORE UPDATE ON workspace_members
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- workspace_invites
DROP TRIGGER IF EXISTS update_workspace_invites_updated_at ON workspace_invites;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'update_updated_at_column'
    ) THEN
        CREATE TRIGGER update_workspace_invites_updated_at 
            BEFORE UPDATE ON workspace_invites
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- workspace_credits
DROP TRIGGER IF EXISTS update_workspace_credits_updated_at ON workspace_credits;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = 'update_updated_at_column'
    ) THEN
        CREATE TRIGGER update_workspace_credits_updated_at 
            BEFORE UPDATE ON workspace_credits
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- ============================================================================
-- 7. HELPER FUNCTIONS FOR RLS (SECURITY DEFINER to avoid recursion)
-- ============================================================================
-- These functions bypass RLS internally to prevent infinite recursion
-- when workspace_members policies reference workspace_members itself.
-- They always use auth.uid() internally so callers cannot impersonate.

-- Returns workspace IDs where the current user is an active member
CREATE OR REPLACE FUNCTION public.get_my_workspace_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT workspace_id FROM workspace_members
    WHERE user_id = auth.uid() AND status = 'active';
$$;

-- Checks if the current user is a member of a workspace, optionally with specific roles
CREATE OR REPLACE FUNCTION public.check_workspace_membership(p_workspace_id uuid, p_roles text[] DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM workspace_members
        WHERE workspace_id = p_workspace_id
        AND user_id = auth.uid()
        AND status = 'active'
        AND (p_roles IS NULL OR role = ANY(p_roles))
    );
$$;

-- ============================================================================
-- 8. RLS POLICIES
-- ============================================================================

-- Enable RLS on all new tables
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_audit_log ENABLE ROW LEVEL SECURITY;

-- workspace_members: members can see their own workspace's members
-- Uses get_my_workspace_ids() (SECURITY DEFINER) to avoid infinite recursion
CREATE POLICY "Members can view workspace members" ON workspace_members
    FOR SELECT USING (
        workspace_id IN (SELECT public.get_my_workspace_ids())
    );

-- workspace_members: only owners can insert/update/delete
-- Uses check_workspace_membership() (SECURITY DEFINER) to avoid infinite recursion
CREATE POLICY "Owners can manage workspace members" ON workspace_members
    FOR ALL USING (
        public.check_workspace_membership(workspace_id, ARRAY['owner'])
    );

-- workspace_invites: owners can view invites
CREATE POLICY "Owners can view workspace invites" ON workspace_invites
    FOR SELECT USING (
        public.check_workspace_membership(workspace_id, ARRAY['owner'])
    );

CREATE POLICY "Owners can manage workspace invites" ON workspace_invites
    FOR ALL USING (
        public.check_workspace_membership(workspace_id, ARRAY['owner'])
    );

-- workspace_credits: members can view, only owner can modify
CREATE POLICY "Members can view workspace credits" ON workspace_credits
    FOR SELECT USING (
        public.check_workspace_membership(workspace_id)
    );

CREATE POLICY "Owners can manage workspace credits" ON workspace_credits
    FOR ALL USING (
        public.check_workspace_membership(workspace_id, ARRAY['owner'])
    );

-- workspace_credit_transactions: members can view
CREATE POLICY "Members can view workspace credit transactions" ON workspace_credit_transactions
    FOR SELECT USING (
        public.check_workspace_membership(workspace_id)
    );

-- workspace_audit_log: only owners can view
CREATE POLICY "Owners can view workspace audit log" ON workspace_audit_log
    FOR SELECT USING (
        public.check_workspace_membership(workspace_id, ARRAY['owner'])
    );

-- ============================================================================
-- 9. SEED OWNER MEMBERSHIP FOR EXISTING WORKSPACES
-- ============================================================================
-- For each existing workspace, create an owner membership for workspaces.user_id
-- Only workspaces whose user_id is a valid UUID (authenticated users); skip IP/anonymous ids.

DO $$
DECLARE
    ws_record RECORD;
    uuid_pattern TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
    -- Loop through all existing workspaces that don't have an owner member yet,
    -- have UUID user_id, AND whose user actually exists in the users table
    FOR ws_record IN
        SELECT w.id AS workspace_id, w.user_id
        FROM workspaces w
        WHERE NOT EXISTS (
            SELECT 1 FROM workspace_members wm
            WHERE wm.workspace_id = w.id
            AND wm.role = 'owner'
            AND wm.status = 'active'
        )
        AND w.user_id IS NOT NULL
        AND w.user_id::text ~ uuid_pattern
        AND EXISTS (
            SELECT 1 FROM users u WHERE u.id = w.user_id::uuid
        )
    LOOP
        -- Insert owner membership (user_id is already validated as UUID format)
        INSERT INTO workspace_members (workspace_id, user_id, role, status)
        VALUES (ws_record.workspace_id, ws_record.user_id::uuid, 'owner', 'active')
        ON CONFLICT (workspace_id, user_id) DO UPDATE
        SET role = 'owner', status = 'active', updated_at = NOW();
        
        RAISE NOTICE 'Created owner membership for workspace % with user %', ws_record.workspace_id, ws_record.user_id;
    END LOOP;
END $$;

-- ============================================================================
-- 10. SEED WORKSPACE CREDITS FROM USER CREDITS
-- ============================================================================
-- Migrate credit balances from user_credits to workspace_credits for existing workspaces
-- Only workspaces whose user_id is a valid UUID; skip IP/anonymous ids.

DO $$
DECLARE
    ws_record RECORD;
    owner_credits RECORD;
    uuid_pattern TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
    -- Loop through workspaces that don't have workspace_credits yet,
    -- have UUID user_id, AND whose user actually exists in the users table
    FOR ws_record IN
        SELECT w.id AS workspace_id, w.user_id
        FROM workspaces w
        WHERE NOT EXISTS (
            SELECT 1 FROM workspace_credits wc
            WHERE wc.workspace_id = w.id
        )
        AND w.user_id IS NOT NULL
        AND w.user_id::text ~ uuid_pattern
        AND EXISTS (
            SELECT 1 FROM users u WHERE u.id = w.user_id::uuid
        )
    LOOP
        -- Get owner's user_credits
        SELECT * INTO owner_credits
        FROM user_credits uc
        WHERE uc.user_id = ws_record.user_id;
        
        IF owner_credits IS NOT NULL THEN
            -- Create workspace_credits from owner's credits
            INSERT INTO workspace_credits (
                workspace_id, 
                credits_balance, 
                total_purchased, 
                total_used,
                subscription_plan,
                subscription_status,
                subscription_expires_at,
                last_credit_usage,
                credits_purchased_at
            )
            VALUES (
                ws_record.workspace_id,
                COALESCE(owner_credits.credits_balance, 0),
                COALESCE(owner_credits.total_purchased, 0),
                COALESCE(owner_credits.total_used, 0),
                COALESCE(owner_credits.subscription_plan, 'free'),
                COALESCE(owner_credits.subscription_status, 'inactive'),
                owner_credits.subscription_expires_at,
                owner_credits.last_credit_usage,
                owner_credits.credits_purchased_at
            )
            ON CONFLICT (workspace_id) DO NOTHING;
            
            -- Record migration in audit log (cast user_id to UUID if TEXT)
            INSERT INTO workspace_audit_log (workspace_id, actor_user_id, event_type, target_type, metadata)
            VALUES (
                ws_record.workspace_id,
                ws_record.user_id::uuid,
                'credits.migrated',
                'workspace',
                jsonb_build_object(
                    'from', 'user_credits',
                    'credits_balance', owner_credits.credits_balance,
                    'total_purchased', owner_credits.total_purchased,
                    'total_used', owner_credits.total_used
                )
            );
            
            RAISE NOTICE 'Migrated credits for workspace % from user %', ws_record.workspace_id, ws_record.user_id;
        ELSE
            -- Create empty workspace_credits
            INSERT INTO workspace_credits (workspace_id, credits_balance)
            VALUES (ws_record.workspace_id, 0)
            ON CONFLICT (workspace_id) DO NOTHING;
            
            RAISE NOTICE 'Created empty credits for workspace %', ws_record.workspace_id;
        END IF;
    END LOOP;
END $$;

-- ============================================================================
-- 11. TRIGGER TO AUTO-CREATE OWNER MEMBERSHIP ON NEW WORKSPACE
-- ============================================================================

CREATE OR REPLACE FUNCTION create_workspace_owner_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Skip if no owner or user_id is not a UUID (e.g. IP for anonymous workspaces)
    IF NEW.user_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.user_id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RETURN NEW;
    END IF;

    -- Create owner membership for new workspace
    INSERT INTO workspace_members (workspace_id, user_id, role, status)
    VALUES (NEW.id, NEW.user_id::uuid, 'owner', 'active')
    ON CONFLICT (workspace_id, user_id) DO UPDATE
    SET role = 'owner', status = 'active', updated_at = NOW();

    -- Create workspace_credits with 0 balance
    INSERT INTO workspace_credits (workspace_id, credits_balance)
    VALUES (NEW.id, 0)
    ON CONFLICT (workspace_id) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_workspace_created_create_membership ON workspaces;
CREATE TRIGGER on_workspace_created_create_membership
    AFTER INSERT ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION create_workspace_owner_membership();

-- ============================================================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================================================

COMMENT ON TABLE workspace_members IS 'B2B organization membership: links users to workspaces with roles (owner, full_access, view)';
COMMENT ON TABLE workspace_invites IS 'Email invitations to join a workspace with a specific role';
COMMENT ON TABLE workspace_credits IS 'Org-level credit pool shared by all workspace members';
COMMENT ON TABLE workspace_credit_transactions IS 'Credit usage/purchase history at workspace level';
COMMENT ON TABLE workspace_audit_log IS 'Enterprise-ready audit log for org admin actions';

COMMENT ON COLUMN workspace_members.role IS 'Role: owner (full control), full_access (CRUD resources), view (read-only)';
COMMENT ON COLUMN workspace_members.status IS 'Status: active (has access) or removed (no access, kept for history)';
COMMENT ON COLUMN workspace_invites.status IS 'Invite status: invited (pending), accepted, revoked, expired';
