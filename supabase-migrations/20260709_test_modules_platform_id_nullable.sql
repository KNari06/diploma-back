-- Make test_modules.platform_id nullable (folders are platform-agnostic).
--
-- Platform now lives on the test (flow), not the folder — a folder may hold
-- web, mobile and api tests together. An earlier migration
-- (features/test-platforms-migration.sql) set platform_id NOT NULL back when a
-- module belonged to exactly one platform; that no longer holds.
--
-- New folders are created with platform_id = NULL. Existing rows keep their
-- platform_id (ignored for grouping). The partial index
-- idx_test_modules_platform ... WHERE platform_id IS NOT NULL already tolerates
-- NULLs, so no index change is needed.

ALTER TABLE test_modules
  ALTER COLUMN platform_id DROP NOT NULL;
