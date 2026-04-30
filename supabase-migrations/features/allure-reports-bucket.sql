-- =====================================================
-- Migration: allure_reports Storage Bucket + RLS Policies
-- =====================================================
-- Description: Provisions the Supabase Storage bucket used by the Allure
--              import pipeline. The API pod uploads the user's file here;
--              the BullMQ worker pod downloads it from here. Without this,
--              the API and worker can't share the file (different /tmp dirs)
--              and every import fails with ENOENT.
--
-- Bucket: allure_reports (private)
-- Paths: allure/<userId>/<importId>.{zip|csv|pdf}
--
-- Created: 2026-04-26

-- =====================================================
-- 1. Bucket creation (MANUAL — Supabase Dashboard)
-- =====================================================
-- Storage buckets require owner privileges; create via Dashboard:
--   1. Storage → New bucket
--   2. Name: allure_reports
--   3. Public: No (private)
--   4. File size limit: 100 MB (104857600 bytes) — matches multer cap
--   5. Allowed MIME types:
--      - application/zip
--      - application/x-zip-compressed
--      - text/csv
--      - application/pdf
--
-- After creating the bucket, run this file in the SQL editor to install
-- the RLS policies below.

-- =====================================================
-- 2. RLS Policies for storage.objects
-- =====================================================
-- The backend always reaches storage via supabaseAdmin (service_role), which
-- bypasses RLS. These policies exist defensively in case a non-admin client
-- ever touches the bucket from the browser.
--
-- Path layout: allure/<userId>/<importId>.<ext>
--   split_part(name, '/', 1) = 'allure'
--   split_part(name, '/', 2) = userId

DROP POLICY IF EXISTS "Users can upload own allure imports" ON storage.objects;
CREATE POLICY "Users can upload own allure imports"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'allure_reports'
    AND split_part(name, '/', 1) = 'allure'
    AND split_part(name, '/', 2) = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can read own allure imports" ON storage.objects;
CREATE POLICY "Users can read own allure imports"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'allure_reports'
    AND split_part(name, '/', 1) = 'allure'
    AND split_part(name, '/', 2) = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can delete own allure imports" ON storage.objects;
CREATE POLICY "Users can delete own allure imports"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'allure_reports'
    AND split_part(name, '/', 1) = 'allure'
    AND split_part(name, '/', 2) = auth.uid()::text
  );

-- =====================================================
-- 3. Migration Complete
-- =====================================================
-- RLS policies installed for `allure_reports`.
-- Application code reaches storage via supabaseAdmin (service_role) and
-- cleans up the object after the import job finishes.
