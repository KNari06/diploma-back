-- Migration: Create message_feedback table
-- Purpose: Store user feedback (like/dislike) for AI chat messages to improve responses
-- Date: 2024-11-13

-- Create feedback_type enum
CREATE TYPE feedback_type AS ENUM ('like', 'dislike');

-- Create message_feedback table
CREATE TABLE IF NOT EXISTS message_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    feedback_type feedback_type NOT NULL,
    intent_type TEXT,  -- api_test, general_chat, ui_test, etc
    context JSONB DEFAULT '{}',  -- Additional context about feedback
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_message_feedback_message_id ON message_feedback(message_id);
CREATE INDEX IF NOT EXISTS idx_message_feedback_user_id ON message_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_message_feedback_session_id ON message_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_message_feedback_feedback_type ON message_feedback(feedback_type);
CREATE INDEX IF NOT EXISTS idx_message_feedback_intent_type ON message_feedback(intent_type);
CREATE INDEX IF NOT EXISTS idx_message_feedback_created_at ON message_feedback(created_at DESC);

-- Add unique constraint to prevent duplicate feedback for same message
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_feedback_unique
ON message_feedback(message_id, user_id);

-- Add RLS (Row Level Security) policies
ALTER TABLE message_feedback ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own feedback
CREATE POLICY "Users can view own feedback" ON message_feedback
    FOR SELECT USING (user_id = auth.uid());

-- Policy: Users can create feedback for their own messages
CREATE POLICY "Users can create own feedback" ON message_feedback
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Policy: Users can update their own feedback
CREATE POLICY "Users can update own feedback" ON message_feedback
    FOR UPDATE USING (user_id = auth.uid());

-- Policy: Users can delete their own feedback
CREATE POLICY "Users can delete own feedback" ON message_feedback
    FOR DELETE USING (user_id = auth.uid());

-- Add comments for documentation
COMMENT ON TABLE message_feedback IS 'Stores user feedback (like/dislike) for AI chat messages to improve response quality';
COMMENT ON COLUMN message_feedback.id IS 'Unique identifier for the feedback';
COMMENT ON COLUMN message_feedback.message_id IS 'ID of the chat message being rated';
COMMENT ON COLUMN message_feedback.user_id IS 'ID of the user providing feedback';
COMMENT ON COLUMN message_feedback.session_id IS 'ID of the chat session';
COMMENT ON COLUMN message_feedback.feedback_type IS 'Type of feedback: like or dislike';
COMMENT ON COLUMN message_feedback.intent_type IS 'Type of intent that was processed: api_test, general_chat, etc';
COMMENT ON COLUMN message_feedback.context IS 'Additional context about feedback (prompt length, response time, etc)';
COMMENT ON COLUMN message_feedback.created_at IS 'When the feedback was provided';

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON message_feedback TO authenticated;
GRANT USAGE ON TYPE feedback_type TO authenticated;

-- Create view for feedback analytics
CREATE OR REPLACE VIEW feedback_analytics AS
SELECT
    intent_type,
    feedback_type,
    COUNT(*) as count,
    DATE_TRUNC('day', created_at) as date
FROM message_feedback
WHERE intent_type IS NOT NULL
GROUP BY intent_type, feedback_type, DATE_TRUNC('day', created_at)
ORDER BY date DESC, intent_type, feedback_type;

-- Grant access to analytics view
GRANT SELECT ON feedback_analytics TO authenticated;

COMMENT ON VIEW feedback_analytics IS 'Aggregated feedback statistics by intent type and date';
