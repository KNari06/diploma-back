-- Migration: Create announcements system
-- Purpose: "What's New" feature announcements shown once per user (like Claude, ChatGPT, Notion)
-- Date: 2026-03-15

-- Create announcement_type enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'announcement_type') THEN
        CREATE TYPE announcement_type AS ENUM ('feature', 'maintenance', 'update', 'breaking_change');
    END IF;
END $$;

-- Create target_audience enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'target_audience') THEN
        CREATE TYPE target_audience AS ENUM ('all', 'free', 'pro', 'enterprise');
    END IF;
END $$;

-- Announcements table (admin-created content)
CREATE TABLE IF NOT EXISTS announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    content JSONB DEFAULT '{}',
    type announcement_type NOT NULL DEFAULT 'feature',
    target_audience target_audience NOT NULL DEFAULT 'all',
    cta_label TEXT,
    cta_url TEXT,
    is_active BOOLEAN DEFAULT true,
    starts_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Dismissals junction table (tracks per-user "Got it")
CREATE TABLE IF NOT EXISTS announcement_dismissals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dismissed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(announcement_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_announcements_is_active ON announcements(is_active);
CREATE INDEX IF NOT EXISTS idx_announcements_starts_at ON announcements(starts_at);
CREATE INDEX IF NOT EXISTS idx_announcements_expires_at ON announcements(expires_at);
CREATE INDEX IF NOT EXISTS idx_announcements_type ON announcements(type);
CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcement_dismissals_user ON announcement_dismissals(user_id);
CREATE INDEX IF NOT EXISTS idx_announcement_dismissals_announcement ON announcement_dismissals(announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_dismissals_compound ON announcement_dismissals(user_id, announcement_id);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_announcements_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_announcements_updated_at ON announcements;
CREATE TRIGGER update_announcements_updated_at
    BEFORE UPDATE ON announcements
    FOR EACH ROW
    EXECUTE FUNCTION update_announcements_updated_at();

-- RLS
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement_dismissals ENABLE ROW LEVEL SECURITY;

-- Policies: announcements
DROP POLICY IF EXISTS "Anyone can view active announcements" ON announcements;
CREATE POLICY "Anyone can view active announcements" ON announcements
    FOR SELECT USING (is_active = true);

-- Policies: dismissals
DROP POLICY IF EXISTS "Users can view own dismissals" ON announcement_dismissals;
CREATE POLICY "Users can view own dismissals" ON announcement_dismissals
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own dismissals" ON announcement_dismissals;
CREATE POLICY "Users can insert own dismissals" ON announcement_dismissals
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Grants
GRANT SELECT ON announcements TO authenticated;
GRANT SELECT, INSERT ON announcement_dismissals TO authenticated;
GRANT USAGE ON TYPE announcement_type TO authenticated;
GRANT USAGE ON TYPE target_audience TO authenticated;

-- Comments
COMMENT ON TABLE announcements IS 'Admin-created feature announcements shown as What''s New modal';
COMMENT ON TABLE announcement_dismissals IS 'Tracks which users have dismissed each announcement';
COMMENT ON COLUMN announcements.content IS 'Rich JSONB: { features: [{ icon?, title, description }] }';
