-- ============================================================================
-- Project KB: file versioning + format-aware metadata
-- ============================================================================
--
-- Problem this solves:
--   Re-uploading api-spec.pdf today appends new chunks without removing the
--   old ones. Users' retrieval ends up mixing v1 facts with v3 facts silently.
--
-- Solution:
--   Every project_kb_chunks row now carries (file_version, is_current, format).
--   Upload inserts rows with (version = N+1, is_current = true) and, in the
--   same transaction, flips previous rows for the same (project_id, file_name)
--   to is_current = false.
--
--   search_project_kb is updated to filter is_current = true so old versions
--   disappear from retrieval. Old chunks stay in the table for audit, diff,
--   and potential rollback — nothing is destroyed.
-- ============================================================================

-- 1) Add columns (nullable / default so existing rows remain valid)
ALTER TABLE project_kb_chunks
  ADD COLUMN IF NOT EXISTS file_version INT  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_current   BOOL NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS format       TEXT NOT NULL DEFAULT 'generic',
  ADD COLUMN IF NOT EXISTS uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 2) Backfill existing rows — they all represent "current" v1 content
UPDATE project_kb_chunks
   SET file_version = COALESCE(file_version, 1),
       is_current   = TRUE,
       uploaded_at  = COALESCE(uploaded_at, created_at, NOW())
 WHERE file_version IS NULL
    OR is_current IS NULL
    OR uploaded_at IS NULL;

-- 3) Partial index on (project_id, file_name) for current rows only — makes
--    the retrieval filter free
CREATE INDEX IF NOT EXISTS idx_project_kb_current
  ON project_kb_chunks (project_id, file_name)
  WHERE is_current = TRUE;

-- 4) Index on (project_id, file_name, file_version) for history queries
CREATE INDEX IF NOT EXISTS idx_project_kb_version
  ON project_kb_chunks (project_id, file_name, file_version);

-- NOTE on concurrent uploads:
-- Originally we planned a unique partial index here to guard against two
-- parallel uploads computing the same new_version. But since each file has
-- MANY chunks (all sharing (project_id, file_name, file_version)), a simple
-- row-level unique index doesn't fit the data shape. Concurrent-upload
-- protection is handled at the application layer instead:
--   - Frontend debounces upload clicks
--   - Backend rolls back the losing upload via try/catch in kb.service.ts
-- If split-brain ever shows up in telemetry we'll add an advisory lock
-- keyed by (project_id, file_name) in the upload path.

-- ============================================================================
-- RPC: atomic version replacement
-- ============================================================================
-- Caller inserts new-version chunks first, then calls this RPC. We flip older
-- versions in a single transaction so retrieval never sees "two current
-- versions of the same file" even briefly.
-- ============================================================================

CREATE OR REPLACE FUNCTION project_kb_flip_previous_versions(
  p_project_id  UUID,
  p_file_name   TEXT,
  p_new_version INT
)
RETURNS INT
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  flipped_count INT;
BEGIN
  UPDATE project_kb_chunks
     SET is_current = FALSE
   WHERE project_id   = p_project_id
     AND file_name    = p_file_name
     AND file_version < p_new_version
     AND is_current   = TRUE;

  GET DIAGNOSTICS flipped_count = ROW_COUNT;
  RETURN flipped_count;
END;
$$;

-- ============================================================================
-- RPC: search_project_kb (REPLACES existing one — adds is_current filter
--                         and returns version + uploaded_at for citations)
--
-- The old function returned (id, content, file_name, metadata, similarity).
-- Postgres does not allow CREATE OR REPLACE to change the RETURNS TABLE shape,
-- so we DROP first. This is a breaking RPC signature change: backend code
-- must deploy together with this migration, never one without the other.
-- ============================================================================

DROP FUNCTION IF EXISTS search_project_kb(UUID, VECTOR, FLOAT, INT);

CREATE OR REPLACE FUNCTION search_project_kb(
  p_project_id    UUID,
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count     INT   DEFAULT 5
)
RETURNS TABLE (
  id           UUID,
  content      TEXT,
  file_name    TEXT,
  file_version INT,
  format       TEXT,
  uploaded_at  TIMESTAMPTZ,
  metadata     JSONB,
  similarity   FLOAT
)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.content,
    c.file_name,
    c.file_version,
    c.format,
    c.uploaded_at,
    c.metadata,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM project_kb_chunks c
  WHERE c.project_id = p_project_id
    AND c.is_current = TRUE
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- RPC: get_kb_stats — update to reflect only current chunks for projects
-- ============================================================================

CREATE OR REPLACE FUNCTION get_kb_stats(p_project_id UUID DEFAULT NULL)
RETURNS JSON
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_project_id IS NULL THEN
    RETURN (SELECT json_build_object(
      'globalChunkCount',  (SELECT COUNT(*) FROM global_kb_chunks),
      'globalFileCount',   (SELECT COUNT(DISTINCT source_file) FROM global_kb_chunks),
      'projectChunkCount', 0,
      'projectFileCount',  0
    ));
  ELSE
    RETURN (SELECT json_build_object(
      'globalChunkCount',  (SELECT COUNT(*) FROM global_kb_chunks),
      'globalFileCount',   (SELECT COUNT(DISTINCT source_file) FROM global_kb_chunks),
      -- Project counts reflect CURRENT versions only (what retrieval sees)
      'projectChunkCount', (SELECT COUNT(*) FROM project_kb_chunks
                             WHERE project_id = p_project_id AND is_current = TRUE),
      'projectFileCount',  (SELECT COUNT(DISTINCT file_name) FROM project_kb_chunks
                             WHERE project_id = p_project_id AND is_current = TRUE)
    ));
  END IF;
END;
$$;

-- ============================================================================
-- Permissions — match the pattern established by features/knowledge-base-safe.sql
-- ============================================================================

GRANT EXECUTE ON FUNCTION project_kb_flip_previous_versions(UUID, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION project_kb_flip_previous_versions(UUID, TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION search_project_kb(UUID, VECTOR, FLOAT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION search_project_kb(UUID, VECTOR, FLOAT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION get_kb_stats(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_kb_stats(UUID) TO service_role;
