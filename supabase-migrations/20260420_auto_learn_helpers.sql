-- ============================================================================
-- Phase 5: Auto-learn RPC helpers
--
-- Depends on: 20260420_project_kb_versioning.sql (for file_version, is_current,
-- format, uploaded_at columns on project_kb_chunks).
--
-- Two RPCs:
--   1. project_kb_auto_learn_refresh — bump last_confirmed_at + refresh_count
--      on an existing auto:trace chunk. Called when the same fact
--      (fingerprint) is observed in another successful run.
--   2. project_kb_auto_learn_retire — mark auto:trace chunks older than a
--      cutoff as is_current=false. Scheduled job invokes this nightly.
--
-- Design choices:
--   - is_current=false (not DELETE): keeps history auditable. Retrieval
--     already filters is_current=true so retired facts stop being served.
--   - Only touches rows where format='auto:trace': manual uploads are
--     lifecycle-managed by Phase 4 versioning, not by TTL.
-- ============================================================================

CREATE OR REPLACE FUNCTION project_kb_auto_learn_refresh(
  p_chunk_id     UUID,
  p_confirmed_at TIMESTAMPTZ
)
RETURNS VOID
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE project_kb_chunks
     SET metadata = jsonb_set(
           jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{last_confirmed_at}',
             to_jsonb(p_confirmed_at),
             TRUE
           ),
           '{refresh_count}',
           to_jsonb(COALESCE((metadata->>'refresh_count')::int, 0) + 1),
           TRUE
         ),
         uploaded_at = p_confirmed_at
   WHERE id = p_chunk_id
     AND format = 'auto:trace';
END;
$$;

CREATE OR REPLACE FUNCTION project_kb_auto_learn_retire(
  p_cutoff TIMESTAMPTZ
)
RETURNS INT
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  retired_count INT;
BEGIN
  UPDATE project_kb_chunks
     SET is_current = FALSE
   WHERE format = 'auto:trace'
     AND is_current = TRUE
     AND COALESCE((metadata->>'last_confirmed_at')::timestamptz, uploaded_at) < p_cutoff;

  GET DIAGNOSTICS retired_count = ROW_COUNT;
  RETURN retired_count;
END;
$$;

GRANT EXECUTE ON FUNCTION project_kb_auto_learn_refresh(UUID, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION project_kb_auto_learn_refresh(UUID, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION project_kb_auto_learn_retire(TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION project_kb_auto_learn_retire(TIMESTAMPTZ) TO service_role;

-- Indexes that help the two access patterns in this phase:
--   1. "find fingerprint for this project" (refresh path — dedup lookup)
--   2. "find all auto:trace chunks older than cutoff" (retire path)

-- Functional index on fingerprint inside metadata — cheap equality lookup.
CREATE INDEX IF NOT EXISTS idx_project_kb_auto_trace_fingerprint
  ON project_kb_chunks ((metadata->>'fingerprint'))
  WHERE format = 'auto:trace' AND is_current = TRUE;

-- Index supporting the retire sweep.
CREATE INDEX IF NOT EXISTS idx_project_kb_auto_trace_confirmed
  ON project_kb_chunks (uploaded_at)
  WHERE format = 'auto:trace' AND is_current = TRUE;
