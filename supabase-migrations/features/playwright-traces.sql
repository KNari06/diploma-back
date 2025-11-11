-- =====================================================
-- Playwright Traces Storage Migration
-- =====================================================
-- Description: Tables and storage for Playwright trace files
-- Created: 2024-11-02

-- =====================================================
-- 1. Create trace_files table
-- =====================================================

CREATE TABLE IF NOT EXISTS trace_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  test_id UUID,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  file_size BIGINT,
  browser TEXT,
  status TEXT DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'parsing', 'parsed', 'failed')),
  parsed_data JSONB,
  public_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  parsed_at TIMESTAMP
);

-- Add foreign key constraint to tests table if it exists
-- This is optional and will only work if tests table is already created
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tests') THEN
    ALTER TABLE trace_files
    ADD CONSTRAINT fk_trace_files_test_id
    FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE;

    RAISE NOTICE 'Foreign key constraint to tests table added successfully';
  ELSE
    RAISE NOTICE 'Tests table does not exist yet. Skipping foreign key constraint.';
  END IF;
END $$;

-- =====================================================
-- 2. Create indexes
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_trace_files_user_id ON trace_files(user_id);
CREATE INDEX IF NOT EXISTS idx_trace_files_test_id ON trace_files(test_id);
CREATE INDEX IF NOT EXISTS idx_trace_files_status ON trace_files(status);
CREATE INDEX IF NOT EXISTS idx_trace_files_created_at ON trace_files(created_at DESC);

-- =====================================================
-- 3. Create updated_at trigger
-- =====================================================

CREATE OR REPLACE FUNCTION update_trace_files_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trace_files_updated_at ON trace_files;
CREATE TRIGGER trace_files_updated_at
  BEFORE UPDATE ON trace_files
  FOR EACH ROW
  EXECUTE FUNCTION update_trace_files_updated_at();

-- =====================================================
-- 4. Create RLS policies
-- =====================================================

ALTER TABLE trace_files ENABLE ROW LEVEL SECURITY;

-- Users can view their own traces
CREATE POLICY "Users can view own traces"
  ON trace_files
  FOR SELECT
  USING (auth.uid()::text = user_id::text);

-- Users can insert their own traces
CREATE POLICY "Users can insert own traces"
  ON trace_files
  FOR INSERT
  WITH CHECK (auth.uid()::text = user_id::text);

-- Users can update their own traces
CREATE POLICY "Users can update own traces"
  ON trace_files
  FOR UPDATE
  USING (auth.uid()::text = user_id::text);

-- Users can delete their own traces
CREATE POLICY "Users can delete own traces"
  ON trace_files
  FOR DELETE
  USING (auth.uid()::text = user_id::text);

-- =====================================================
-- 5. Grant permissions
-- =====================================================

GRANT ALL ON trace_files TO authenticated;
GRANT SELECT ON trace_files TO anon;

-- =====================================================
-- 6. Create storage bucket (manual step in Supabase UI or via SQL if available)
-- =====================================================

-- Note: Storage buckets are typically created via Supabase Dashboard:
-- 1. Go to Storage in Supabase Dashboard
-- 2. Create new bucket named 'traces'
-- 3. Set as private (only authenticated users can access)
-- 4. Configure policies:
--    - Allow authenticated users to upload to their own folder
--    - Allow authenticated users to read their own files

-- Alternatively, if using Supabase CLI:
-- INSERT INTO storage.buckets (id, name, public) VALUES ('traces', 'traces', false);

-- =====================================================
-- 7. Comments for documentation
-- =====================================================

COMMENT ON TABLE trace_files IS 'Stores metadata for Playwright trace files uploaded to Supabase Storage';
COMMENT ON COLUMN trace_files.id IS 'Unique identifier for trace file record';
COMMENT ON COLUMN trace_files.user_id IS 'User who uploaded the trace';
COMMENT ON COLUMN trace_files.test_id IS 'Associated test ID (nullable for standalone traces, optional FK to tests table)';
COMMENT ON COLUMN trace_files.file_name IS 'Original filename';
COMMENT ON COLUMN trace_files.storage_path IS 'Path in Supabase Storage bucket';
COMMENT ON COLUMN trace_files.file_size IS 'File size in bytes';
COMMENT ON COLUMN trace_files.browser IS 'Browser used for test (chrome, firefox, etc.)';
COMMENT ON COLUMN trace_files.status IS 'Processing status (uploaded, parsing, parsed, failed)';
COMMENT ON COLUMN trace_files.parsed_data IS 'Parsed trace data (JSON)';
COMMENT ON COLUMN trace_files.public_url IS 'Public or signed URL for file access';

-- =====================================================
-- Note: Foreign key constraint to tests table
-- =====================================================
-- The migration will attempt to add a foreign key constraint to the tests table
-- if it exists. If tests table doesn't exist yet, traces can still be created
-- with test_id as a regular UUID field. You can manually add the constraint later:
--
-- ALTER TABLE trace_files
-- ADD CONSTRAINT fk_trace_files_test_id
-- FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE;
