-- Migration: Create notifications table
-- Purpose: Store user notifications (personal, general, system) for in-app notifications
-- Date: 2024-11-26

-- Create notification_type enum (with existence check)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_type') THEN
        CREATE TYPE notification_type AS ENUM ('personal', 'general', 'system');
    END IF;
END $$;

-- Create notification_category enum (with existence check)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_category') THEN
        CREATE TYPE notification_category AS ENUM ('test', 'discount', 'billing', 'system', 'feature', 'announcement');
    END IF;
END $$;

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- NULL for general notifications (all users)
    type notification_type NOT NULL,
    category notification_category NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB DEFAULT '{}', -- Additional data (testId, discountCode, etc.)
    action_url TEXT, -- Optional URL for action button
    action_label TEXT, -- Optional label for action button
    is_read BOOLEAN DEFAULT false,
    read_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(category);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_general_unread ON notifications(type, is_read) WHERE user_id IS NULL AND is_read = false;

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_notifications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists (for idempotency)
DROP TRIGGER IF EXISTS update_notifications_updated_at ON notifications;

CREATE TRIGGER update_notifications_updated_at
    BEFORE UPDATE ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION update_notifications_updated_at();

-- Add RLS (Row Level Security) policies
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Drop policies if exist (for idempotency)
DROP POLICY IF EXISTS "Users can view own personal notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON notifications;

-- Policy: Users can view their own personal notifications
CREATE POLICY "Users can view own personal notifications" ON notifications
    FOR SELECT USING (
        (user_id = auth.uid() AND type = 'personal') OR
        (user_id IS NULL AND type IN ('general', 'system'))
    );

-- Policy: Users can update their own notifications (mark as read)
CREATE POLICY "Users can update own notifications" ON notifications
    FOR UPDATE USING (
        (user_id = auth.uid() AND type = 'personal') OR
        (user_id IS NULL AND type IN ('general', 'system'))
    );

-- Note: Insert/Delete policies are not needed for users
-- Only system/service role can create/delete notifications

-- Grant necessary permissions
GRANT SELECT, UPDATE ON notifications TO authenticated;
GRANT USAGE ON TYPE notification_type TO authenticated;
GRANT USAGE ON TYPE notification_category TO authenticated;

-- Add comment
COMMENT ON TABLE notifications IS 'User notifications for in-app notification system';
COMMENT ON COLUMN notifications.user_id IS 'User ID for personal notifications, NULL for general/system notifications';
COMMENT ON COLUMN notifications.metadata IS 'Additional data: testId, discountCode, transactionId, etc.';
COMMENT ON COLUMN notifications.action_url IS 'Optional URL for action button (e.g., link to test result)';
COMMENT ON COLUMN notifications.action_label IS 'Optional label for action button (e.g., "View Test", "Claim Discount")';
