-- Allow 'mobile' as a platform_key in test_platforms
-- Previously only 'web_ui' and 'api' were allowed

ALTER TABLE test_platforms
  DROP CONSTRAINT IF EXISTS test_platforms_platform_key_check;

ALTER TABLE test_platforms
  ADD CONSTRAINT test_platforms_platform_key_check
  CHECK (platform_key IN ('web_ui', 'api', 'mobile'));
