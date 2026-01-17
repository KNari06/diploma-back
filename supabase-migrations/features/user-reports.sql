-- ═══════════════════════════════════════════════════════════════════════════
-- USER REPORTS - User issue reporting system
-- ═══════════════════════════════════════════════════════════════════════════
-- Purpose: Allow users to report issues (bugs, UI problems, feature requests)
-- Changes:
--   1. Create report_category enum type
--   2. Create report_status enum type
--   3. Create user_reports table
--   4. Add indexes for performance
--   5. Add updated_at trigger
--   6. Enable RLS policies
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Create report_category enum type (with existence check)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_category') THEN
        CREATE TYPE report_category AS ENUM (
            'bug',
            'ui',
            'feature',
            'other'
        );
    END IF;
END $$;

-- 2. Create report_status enum type (with existence check)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status') THEN
        CREATE TYPE report_status AS ENUM (
            'pending',
            'in_progress',
            'resolved',
            'closed'
        );
    END IF;
END $$;

-- 3. Create user_reports table
CREATE TABLE IF NOT EXISTS user_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    category report_category NOT NULL,
    details VARCHAR(500) NOT NULL,
    workspace_name VARCHAR(255),
    view VARCHAR(255),
    status report_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_user_reports_user_id ON user_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_user_reports_status ON user_reports(status);
CREATE INDEX IF NOT EXISTS idx_user_reports_created_at ON user_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_reports_user_status ON user_reports(user_id, status);

-- 5. Create function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_user_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. Create trigger to auto-update updated_at
DROP TRIGGER IF EXISTS user_reports_updated_at_trigger ON user_reports;
CREATE TRIGGER user_reports_updated_at_trigger
    BEFORE UPDATE ON user_reports
    FOR EACH ROW
    EXECUTE FUNCTION update_user_reports_updated_at();

-- 7. Enable RLS
ALTER TABLE user_reports ENABLE ROW LEVEL SECURITY;

-- 8. Drop existing policies if they exist (for idempotency)
DROP POLICY IF EXISTS "Users can view own reports" ON user_reports;
DROP POLICY IF EXISTS "Users can create own reports" ON user_reports;
DROP POLICY IF EXISTS "Admins can view all reports" ON user_reports;

-- 9. Create RLS policies

-- Policy: Users can view their own reports
CREATE POLICY "Users can view own reports" ON user_reports
    FOR SELECT
    USING (auth.uid() = user_id);

-- Policy: Users can create their own reports
CREATE POLICY "Users can create own reports" ON user_reports
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Policy: Admins can view all reports
CREATE POLICY "Admins can view all reports" ON user_reports
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM users
            WHERE users.id = auth.uid()
            AND users.role = 'admin'
        )
    );

-- Note: Update/Delete operations are not allowed via RLS
-- They should be done through service role (backend) for audit purposes

-- 10. Grant necessary permissions
GRANT SELECT, INSERT ON user_reports TO authenticated;
GRANT USAGE ON TYPE report_category TO authenticated;
GRANT USAGE ON TYPE report_status TO authenticated;

-- 11. Add comments for documentation
COMMENT ON TABLE user_reports IS 'User issue reports (bugs, UI problems, feature requests)';
COMMENT ON COLUMN user_reports.user_id IS 'User who submitted the report';
COMMENT ON COLUMN user_reports.title IS 'Report title (max 200 characters)';
COMMENT ON COLUMN user_reports.category IS 'Report category: bug, ui, feature, other';
COMMENT ON COLUMN user_reports.details IS 'Detailed description (max 500 characters)';
COMMENT ON COLUMN user_reports.workspace_name IS 'Optional: workspace name for context';
COMMENT ON COLUMN user_reports.view IS 'Optional: view/screen where issue occurred (e.g., "QaitGPT", "Test results")';
COMMENT ON COLUMN user_reports.status IS 'Report status: pending, in_progress, resolved, closed';
COMMENT ON COLUMN user_reports.created_at IS 'When the report was created';
COMMENT ON COLUMN user_reports.updated_at IS 'When the report was last updated';
