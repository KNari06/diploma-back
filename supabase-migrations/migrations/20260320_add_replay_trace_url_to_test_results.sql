-- Add replay_trace_url column to test_results
-- Stores Supabase Storage URL to the JSONL replay trace file
-- Contains step-by-step execution details: element resolution, readiness checks,
-- retry attempts, LLM diagnosis — for debugging test failures in production.
ALTER TABLE test_results ADD COLUMN IF NOT EXISTS replay_trace_url TEXT;
