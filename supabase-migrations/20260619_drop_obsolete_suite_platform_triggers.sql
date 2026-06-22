-- 20260619_drop_obsolete_suite_platform_triggers.sql
--
-- Remove the obsolete platform <-> suite_type enforcement triggers/functions.
--
-- Background:
--   features/test-platforms-enforcement.sql introduced two trigger functions
--   that enforced "web_ui => suite_type='ui', api => suite_type='api'":
--     - enforce_suite_type_matches_platform()  (trigger on regression_suites)
--     - enforce_module_platform_change()        (trigger on test_modules,
--                                                 BEFORE UPDATE OF platform_id)
--
--   features/remove-suite-layer.sql later DROPPED the regression_suites table
--   (the whole suite layer was collapsed into modules) but never cleaned up
--   these two functions. The result is dead, broken validation:
--     1. enforce_module_platform_change() only knows 'web_ui' and 'api' and
--        RAISEs 'Unknown platform_key: %' for 'mobile' — so a module can never
--        be moved under the mobile platform tree node. This silently blocks
--        mobile imports and any web->mobile reclassification.
--     2. Both functions query regression_suites, which no longer exists, so the
--        check could not run correctly even for web/api modules.
--
-- Since the suite layer is gone, there is nothing left to enforce: suite_type
-- consistency is meaningless without suites. Drop both triggers and functions.
--
-- Idempotent and safe to run on any environment.

-- Trigger on test_modules (the one blocking mobile module placement).
DROP TRIGGER IF EXISTS trg_enforce_module_platform_change ON public.test_modules;
DROP FUNCTION IF EXISTS public.enforce_module_platform_change();

-- Companion trigger function. Its trigger (trg_enforce_suite_platform) was
-- dropped together with regression_suites; the function is left orphaned.
DROP FUNCTION IF EXISTS public.enforce_suite_type_matches_platform();
