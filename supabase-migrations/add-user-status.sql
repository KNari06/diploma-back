-- ═══════════════════════════════════════════════════════════════════════════
-- ADD USER STATUS FOR ACCESS APPROVAL SYSTEM
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds a `status` column to users table to gate access.
-- New users default to 'pending_approval', admins approve via API.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Add status column with constraint
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending_approval'
  CHECK (status IN ('pending_approval', 'approved', 'rejected'));

-- 2. Auto-approve all existing users
UPDATE users SET status = 'approved' WHERE status = 'pending_approval';

-- 3. Index for admin queries (list pending users)
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
