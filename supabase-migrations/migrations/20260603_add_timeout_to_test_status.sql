-- Add 'timeout' to the test_status enum.
--
-- WHY: the codebase writes status='timeout' in several paths (stale-run reaper,
-- manual-test-run, mobile-test-run, test-execution-orchestrator, ai-selector,
-- regression-doctor). The canonical schema (supabase-schema.sql) already lists
-- 'timeout', but production was built from an older definition
-- (schema/recreate-all-tables-with-text-user-id.sql) that omitted it. Writing
-- 'timeout' there throws: 22P02 invalid input value for enum test_status.
-- Symptom: [STALE_RUN_REAPER] "Force-fail of stale tests failed" — stale test
-- rows stay stuck in 'running'.
--
-- IMPORTANT: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block on
-- PostgreSQL < 12, and some migration runners wrap each file in a transaction.
-- If this fails with "ALTER TYPE ... ADD VALUE cannot run inside a transaction
-- block", run this statement on its own, outside any transaction.
--
-- Idempotent: IF NOT EXISTS makes re-runs a no-op (and a no-op on DBs already
-- built from supabase-schema.sql, which has it).

ALTER TYPE test_status ADD VALUE IF NOT EXISTS 'timeout';
