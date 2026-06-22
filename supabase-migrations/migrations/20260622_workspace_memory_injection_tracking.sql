-- Skill / memory usage tracking: count when a memory is INJECTED into the agent
-- context (the primary path), separate from access_count which only tracks
-- explicit search/read tool calls. See docs/SKILL_USAGE_TRACKING.md.

-- 1. New columns (separate from access_count so context ranking is unaffected)
ALTER TABLE workspace_memory
  ADD COLUMN IF NOT EXISTS injection_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE workspace_memory
  ADD COLUMN IF NOT EXISTS last_injected_at TIMESTAMP WITH TIME ZONE;

-- 2. Atomic increment RPC (batch). Mirrors increment_memory_access_count but for
--    injection, and accepts an array of ids so one call covers a whole run's
--    injected set.
CREATE OR REPLACE FUNCTION increment_memory_injection_count(p_memory_ids UUID[])
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE workspace_memory
  SET injection_count = injection_count + 1,
      last_injected_at = NOW()
  WHERE id = ANY(p_memory_ids::UUID[]);
$$;

-- 3. Atomic increment RPC for the EXISTING access path (read/search tools).
--    The service has always called this RPC at updateAccessTracking(), but the
--    function was never shipped in a migration — so every read silently fell
--    into a non-atomic read-then-write fallback that loses updates under
--    concurrency. Ship it here so the atomic path actually exists in prod.
CREATE OR REPLACE FUNCTION increment_memory_access_count(p_memory_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE workspace_memory
  SET access_count = access_count + 1,
      last_accessed_at = NOW()
  WHERE id = p_memory_id;
$$;
