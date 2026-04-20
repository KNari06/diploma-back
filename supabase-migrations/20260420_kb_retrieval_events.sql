-- ============================================================================
-- KB Retrieval Telemetry
-- ============================================================================
--
-- Records every production call to searchKB so we can:
--   1. See what users actually ask (vs. the 56-query synthetic eval set)
--   2. Find chunks that get retrieved but never help (dead chunks → prune)
--   3. Join with message_feedback to measure real answer quality
--
-- Design notes:
-- - No reaction column: we join to message_feedback by message_id instead.
-- - Both chunk_ids AND source_files stored. Chunk IDs change on every rebuild;
--   file paths are stable, so dead-chunk analysis survives rebuilds.
-- - Partial indexes favour the two dominant queries: recent events (for UI)
--   and per-project/per-user scope.
-- - No foreign keys to chat_messages or chat_sessions: retrieval can happen
--   outside of chat (jobs, orchestrators) and we don't want logging to fail
--   just because a referenced message gets deleted later.
-- ============================================================================

CREATE TABLE IF NOT EXISTS kb_retrieval_events (
  event_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  user_id        UUID        NULL,     -- set when an authenticated request drives retrieval
  session_id     UUID        NULL,     -- chat session, when applicable
  message_id     UUID        NULL,     -- assistant message produced with these chunks (set late)
  project_id     UUID        NULL,

  query          TEXT        NOT NULL, -- truncated at insert time to 500 chars
  call_site      TEXT        NOT NULL, -- logical origin: 'chat', 'kb-skill', 'jira-qa', ...

  chunk_ids      TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  source_files   TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],

  global_count   INT         NOT NULL DEFAULT 0 CHECK (global_count  >= 0),
  project_count  INT         NOT NULL DEFAULT 0 CHECK (project_count >= 0),

  latency_ms     INT         NOT NULL DEFAULT 0 CHECK (latency_ms    >= 0)
);

-- Primary scan patterns
CREATE INDEX IF NOT EXISTS idx_kb_retrieval_events_created_at
  ON kb_retrieval_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_events_session_id
  ON kb_retrieval_events (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_events_message_id
  ON kb_retrieval_events (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_events_project_id
  ON kb_retrieval_events (project_id)
  WHERE project_id IS NOT NULL;

-- GIN index on source_files so dead-chunk analysis ("find events that cited file X")
-- is fast even on millions of rows.
CREATE INDEX IF NOT EXISTS idx_kb_retrieval_events_source_files
  ON kb_retrieval_events USING GIN (source_files);

-- ============================================================================
-- RLS: telemetry is admin-only read; service role writes it
-- ============================================================================

ALTER TABLE kb_retrieval_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read kb_retrieval_events"   ON kb_retrieval_events;
DROP POLICY IF EXISTS "Service role can write retrieval events" ON kb_retrieval_events;

CREATE POLICY "Admins can read kb_retrieval_events" ON kb_retrieval_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin'));

-- Service role (used by backend) bypasses RLS via JWT, so no explicit INSERT policy
-- is required for it. We do NOT allow arbitrary authenticated writes — telemetry
-- is backend-only.

-- ============================================================================
-- RPC: dead-chunk analysis
-- ============================================================================
--
-- A "dead chunk" is one that's been retrieved at least `p_min_retrievals` times
-- in the last `p_days` days, has zero 👍 attribution, and has a 👎/total ratio
-- of at least `p_dislike_ratio` (0 means "any negative signal counts").
--
-- We attribute feedback at the SOURCE_FILE level, not chunk_id, because chunk
-- IDs rebuild-churn. This means the analysis answers: "is this MARKDOWN FILE
-- retrieved a lot but correlated with bad answers?" — exactly the signal you
-- need when deciding whether to rewrite or delete a file.
-- ============================================================================

CREATE OR REPLACE FUNCTION kb_dead_files(
  p_days           INT     DEFAULT 30,
  p_min_retrievals INT     DEFAULT 10,
  p_dislike_ratio  NUMERIC DEFAULT 0.25
)
RETURNS TABLE (
  source_file       TEXT,
  retrievals        BIGINT,
  messages_with_fb  BIGINT,
  likes             BIGINT,
  dislikes          BIGINT,
  dislike_ratio     NUMERIC
)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only admins may call
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin') THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  RETURN QUERY
  WITH exploded AS (
    SELECT
      e.event_id,
      e.message_id,
      unnest(e.source_files) AS source_file
    FROM kb_retrieval_events e
    WHERE e.created_at >= NOW() - (p_days || ' days')::INTERVAL
  ),
  -- Per-file retrieval counts (unique events, to avoid double-counting when a
  -- file's chunk appears twice in the same top-K list)
  retrievals_per_file AS (
    SELECT source_file, COUNT(DISTINCT event_id) AS retrievals
    FROM exploded
    GROUP BY source_file
  ),
  -- Feedback attribution: count likes/dislikes for messages that were produced
  -- with each file in context
  fb_per_file AS (
    SELECT
      x.source_file,
      COUNT(DISTINCT f.id) FILTER (WHERE f.feedback_type = 'like')    AS likes,
      COUNT(DISTINCT f.id) FILTER (WHERE f.feedback_type = 'dislike') AS dislikes,
      COUNT(DISTINCT f.id)                                            AS msgs_with_fb
    FROM exploded x
    JOIN message_feedback f ON f.message_id = x.message_id
    GROUP BY x.source_file
  )
  SELECT
    r.source_file,
    r.retrievals,
    COALESCE(f.msgs_with_fb, 0) AS messages_with_fb,
    COALESCE(f.likes,        0) AS likes,
    COALESCE(f.dislikes,     0) AS dislikes,
    CASE
      WHEN COALESCE(f.msgs_with_fb, 0) = 0 THEN 0::NUMERIC
      ELSE ROUND(f.dislikes::NUMERIC / f.msgs_with_fb::NUMERIC, 4)
    END AS dislike_ratio
  FROM retrievals_per_file r
  LEFT JOIN fb_per_file f USING (source_file)
  WHERE r.retrievals >= p_min_retrievals
    AND (
      -- "dead": dislike ratio exceeds threshold, OR file has retrievals but
      -- zero positive feedback in the window
      CASE WHEN COALESCE(f.msgs_with_fb, 0) = 0 THEN 0::NUMERIC
           ELSE f.dislikes::NUMERIC / f.msgs_with_fb::NUMERIC END >= p_dislike_ratio
      OR (COALESCE(f.likes, 0) = 0 AND r.retrievals >= p_min_retrievals * 2)
    )
  ORDER BY r.retrievals DESC, dislikes DESC;
END;
$$;

-- ============================================================================
-- RPC: retrieval stats (overview for admin dashboard)
-- ============================================================================

CREATE OR REPLACE FUNCTION kb_retrieval_stats(p_days INT DEFAULT 7)
RETURNS JSON
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin') THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  RETURN (SELECT json_build_object(
    'total_retrievals',     (SELECT COUNT(*) FROM kb_retrieval_events
                             WHERE created_at >= NOW() - (p_days || ' days')::INTERVAL),
    'unique_sessions',      (SELECT COUNT(DISTINCT session_id) FROM kb_retrieval_events
                             WHERE created_at >= NOW() - (p_days || ' days')::INTERVAL
                               AND session_id IS NOT NULL),
    'avg_latency_ms',       (SELECT COALESCE(ROUND(AVG(latency_ms)::NUMERIC, 1), 0) FROM kb_retrieval_events
                             WHERE created_at >= NOW() - (p_days || ' days')::INTERVAL),
    'top_queries',          (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
                               SELECT query, COUNT(*) AS count
                               FROM kb_retrieval_events
                               WHERE created_at >= NOW() - (p_days || ' days')::INTERVAL
                               GROUP BY query
                               ORDER BY COUNT(*) DESC
                               LIMIT 20
                             ) t),
    'top_files',            (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
                               SELECT source_file, COUNT(*) AS retrievals
                               FROM kb_retrieval_events e, unnest(e.source_files) AS source_file
                               WHERE e.created_at >= NOW() - (p_days || ' days')::INTERVAL
                               GROUP BY source_file
                               ORDER BY COUNT(*) DESC
                               LIMIT 20
                             ) t),
    'by_call_site',         (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
                               SELECT call_site, COUNT(*) AS count
                               FROM kb_retrieval_events
                               WHERE created_at >= NOW() - (p_days || ' days')::INTERVAL
                               GROUP BY call_site
                               ORDER BY COUNT(*) DESC
                             ) t)
  ));
END;
$$;

-- ============================================================================
-- Permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION kb_dead_files(INT, INT, NUMERIC)   TO authenticated;
GRANT EXECUTE ON FUNCTION kb_dead_files(INT, INT, NUMERIC)   TO service_role;
GRANT EXECUTE ON FUNCTION kb_retrieval_stats(INT)            TO authenticated;
GRANT EXECUTE ON FUNCTION kb_retrieval_stats(INT)            TO service_role;
