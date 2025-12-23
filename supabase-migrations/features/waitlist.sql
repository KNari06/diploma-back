-- ═══════════════════════════════════════════════════════════════════════════
-- WAITLIST - Email collection for early access
-- ═══════════════════════════════════════════════════════════════════════════
-- Purpose: Collect emails and user info for waitlist signup
-- Changes:
--   1. Create waitlist_role enum type
--   2. Create waitlist table
--   3. Add indexes for performance
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Create waitlist_role enum type (with existence check)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'waitlist_role') THEN
        CREATE TYPE waitlist_role AS ENUM (
            'qa_engineer',
            'software_engineer',
            'founder_cto',
            'product_manager',
            'other'
        );
    END IF;
END $$;

-- 2. Create waitlist table
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  role waitlist_role NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create indexes for better performance
-- Note: idx_waitlist_email is not needed - UNIQUE constraint on email automatically creates an index
CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_waitlist_role ON waitlist(role);

-- 4. Create function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_waitlist_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. Create trigger to auto-update updated_at
DROP TRIGGER IF EXISTS waitlist_updated_at_trigger ON waitlist;
CREATE TRIGGER waitlist_updated_at_trigger
  BEFORE UPDATE ON waitlist
  FOR EACH ROW
  EXECUTE FUNCTION update_waitlist_updated_at();

-- 6. Add comments for documentation
COMMENT ON TABLE waitlist IS 'Waitlist signups for early access';
COMMENT ON COLUMN waitlist.email IS 'Unique email address (required)';
COMMENT ON COLUMN waitlist.name IS 'Full name (required)';
COMMENT ON COLUMN waitlist.role IS 'User role: qa_engineer, software_engineer, founder_cto, product_manager, other';
COMMENT ON COLUMN waitlist.created_at IS 'Timestamp when user joined waitlist';
