-- =====================================================
-- Migration: Create lite-trace-logs Storage Bucket + Policies
-- =====================================================
-- Description: Provision the Supabase Storage bucket used by LiteTraceWriter
--              for uploading JSONL trace logs (test_logs/<testId>.jsonl).
--
-- Bucket: lite-trace-logs (private)
-- Paths:
--   - trace-logs/<userId>/<fileName>.jsonl  (normal runs)
--   - trace-logs/anonymous/<fileName>.jsonl (anonymous / non-UUID test runs)
--
-- IMPORTANT: If bucket creation fails with "must be owner" error:
--   1. Create bucket manually via Supabase Dashboard:
--      - Go to Storage → Create bucket
--      - Name: lite-trace-logs
--      - Public: No (private)
--      - File size limit: 100MB
--      - Allowed MIME types: application/x-ndjson, application/jsonlines, application/json, text/plain
--   2. Then re-run this migration (RLS policies will be created)
--
-- Created: 2026-01-17

-- =====================================================
-- 1. Create bucket (MANUAL STEP REQUIRED)
-- =====================================================
-- NOTE: Creating storage buckets via SQL requires owner/administrator privileges
--       which are typically not available in Supabase SQL Editor.
--
-- ACTION REQUIRED: Create bucket manually via Supabase Dashboard:
--   1. Go to Storage → Create bucket
--   2. Name: lite-trace-logs
--   3. Public: No (private bucket)
--   4. File size limit: 100MB (104857600 bytes)
--   5. Allowed MIME types:
--      - application/x-ndjson
--      - application/jsonlines
--      - application/json
--      - text/plain
--
-- After creating the bucket, continue with step 2 below (RLS policies will be created).

-- =====================================================
-- 2. RLS Policies for storage.objects
-- =====================================================

-- Policy: Authenticated users can upload to their own folder
-- Path pattern: trace-logs/<userId>/<fileName>.jsonl
-- NOTE: split_part(name, '/', 1) = 'trace-logs', split_part(name, '/', 2) = userId
DROP POLICY IF EXISTS "Users can upload own lite trace logs" ON storage.objects;
CREATE POLICY "Users can upload own lite trace logs"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'lite-trace-logs'
    AND split_part(name, '/', 1) = 'trace-logs'
    AND split_part(name, '/', 2) = auth.uid()::text
  );

-- Policy: Authenticated users can read their own trace logs
DROP POLICY IF EXISTS "Users can read own lite trace logs" ON storage.objects;
CREATE POLICY "Users can read own lite trace logs"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'lite-trace-logs'
    AND split_part(name, '/', 1) = 'trace-logs'
    AND split_part(name, '/', 2) = auth.uid()::text
  );

-- Policy: Authenticated users can delete their own trace logs
DROP POLICY IF EXISTS "Users can delete own lite trace logs" ON storage.objects;
CREATE POLICY "Users can delete own lite trace logs"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'lite-trace-logs'
    AND split_part(name, '/', 1) = 'trace-logs'
    AND split_part(name, '/', 2) = auth.uid()::text
  );

-- Policy: Service role / backend can upload to anonymous folder
-- NOTE: This is for non-UUID test runs where userId is not a valid UUID.
--       Backend uses supabaseAdmin (service_role) for these uploads.
--       No user-facing policy needed; service_role bypasses RLS.

-- =====================================================
-- 3. Migration Complete
-- =====================================================
-- RLS policies have been created for the lite-trace-logs bucket.
-- Ensure the bucket exists (see step 1) before using the storage.
