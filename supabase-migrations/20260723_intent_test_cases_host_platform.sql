-- Per-test-case Flutter host override + (no schema needed for) the
-- project default-host pointer, which lives in projects.settings JSONB.
--
-- A `mobile_flutter` test keeps ONE platform key (ADR-0019: host lane, not a
-- platform key); which OS actually hosts a non-editor run resolves as:
--   intent_test_cases.host_platform          (this test's override)
--   > projects.settings.flutterDefaultHost   (the project default, editor toggle)
--   > 'android'                              (back-compat default)
--
-- NULL = "inherit" (no override at this level), so existing rows are
-- unaffected and keep resolving exactly as before. Meaningless for
-- non-flutter platforms (mobile_android / mobile_ios already encode the OS).

ALTER TABLE intent_test_cases
  ADD COLUMN IF NOT EXISTS host_platform TEXT
  CHECK (host_platform IN ('android', 'ios'));

COMMENT ON COLUMN intent_test_cases.host_platform IS
  'Flutter-only per-test host override (android|ios). NULL = inherit (project flutterDefaultHost -> ''android''). When set, this test always runs on the named host regardless of the project default.';

NOTIFY pgrst, 'reload schema';
