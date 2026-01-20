-- Migration: Ensure test_results has artifact URL columns
-- Why: Worker writes `video_url` / `trace_url` into `public.test_results`, but some DBs
--      may not have these columns (or have not applied feature migrations).
-- Safe: Uses IF NOT EXISTS so it is idempotent across environments.

ALTER TABLE public.test_results
ADD COLUMN IF NOT EXISTS video_url TEXT,
ADD COLUMN IF NOT EXISTS trace_url TEXT;

COMMENT ON COLUMN public.test_results.video_url IS 'Supabase Storage public URL for test video recording';
COMMENT ON COLUMN public.test_results.trace_url IS 'Supabase Storage public URL for Playwright trace archive';
