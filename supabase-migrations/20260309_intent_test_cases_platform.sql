-- Add platform column to intent_test_cases
-- Distinguishes web tests from mobile tests (Android/iOS)
-- Default: 'web' (backward compatible — all existing tests are web)

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'web'
    CHECK (platform IN ('web', 'mobile_android', 'mobile_ios'));

-- Index for filtering by platform
CREATE INDEX IF NOT EXISTS idx_intent_test_cases_platform
  ON intent_test_cases (project_id, platform)
  WHERE platform != 'web';

COMMENT ON COLUMN intent_test_cases.platform IS 'Testing platform: web (default), mobile_android, or mobile_ios';
