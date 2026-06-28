-- QAIT Tasker — Telegram task tracking from a team group chat.
--
-- WHY: one manager posts free-form daily "Priorities" digests in a Telegram
-- group; the bot extracts tasks (project + owner + status) and chases owners the
-- next morning about anything with no closure/status signal. This replaces the
-- standalone SQLite bot — SQLite can't survive the api process's ephemeral,
-- multi-replica Cloud Run containers, so state lives here.
--
-- SCOPE (v1): chat_id-scoped, single-team. NOT multi-tenant — no workspace_id,
-- no end-user read path. Both tables are written ONLY by the service role
-- (supabaseAdmin, which bypasses RLS). RLS is enabled with NO policy =
-- deny-by-default for anon/auth clients (same posture as other internal-only
-- tables). Add workspace scoping + read policies if this becomes a product
-- feature.
--
-- Idempotent: IF NOT EXISTS throughout.

-- ── tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Telegram group this task belongs to (BIGINT: chat ids can exceed int32,
  -- supergroups are large negative numbers).
  chat_id          BIGINT NOT NULL,

  project          TEXT,                            -- "JP" / "Klara" / ... (nullable)
  title            TEXT NOT NULL,
  owner            TEXT,                            -- canonical "@username" (alias-resolved), nullable

  -- Lifecycle status. 'expired' = auto-archived after long inactivity (distinct
  -- from a genuine 'closed').
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'closed', 'expired')),

  -- Rich progress, orthogonal to status. A task can be open + in_progress.
  progress         TEXT NOT NULL DEFAULT 'none'
                     CHECK (progress IN ('none', 'in_progress', 'blocked', 'needs_investigation')),
  progress_note    TEXT,                            -- the owner's words, e.g. "turns out hard, 1-2 days"

  source_msg_id    BIGINT,                          -- Telegram message id that created the task

  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),  -- drives staleness (NOT created_at)
  last_batch_at    TIMESTAMP WITH TIME ZONE,                -- last overnight-batch analysis
  closed_at        TIMESTAMP WITH TIME ZONE,
  closed_reason    TEXT
);

-- Core access paths: "open tasks in this chat" + "task(s) a replied-to msg created".
CREATE INDEX IF NOT EXISTS idx_telegram_tasks_chat_status ON telegram_tasks(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_telegram_tasks_chat_source ON telegram_tasks(chat_id, source_msg_id);
CREATE INDEX IF NOT EXISTS idx_telegram_tasks_activity    ON telegram_tasks(status, last_activity_at);

-- ── message log ──────────────────────────────────────────────────────────────
-- Powers the recent-message context window + the overnight batch lookback.
-- Pruned by the sweep beyond the lookback horizon.
CREATE TABLE IF NOT EXISTS telegram_messages (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id    BIGINT NOT NULL,
  tg_msg_id  BIGINT,
  author     TEXT,                                  -- "@username" / display name
  text       TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat ON telegram_messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_created ON telegram_messages(created_at);

-- ── RLS: deny-by-default (service-role-only) ─────────────────────────────────
ALTER TABLE telegram_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_messages ENABLE ROW LEVEL SECURITY;
-- No policies: anon/authenticated clients get nothing. The app writes/reads via
-- the service role only, which bypasses RLS. (v1 has no end-user surface.)

COMMENT ON TABLE telegram_tasks IS
  'QAIT Tasker tasks extracted from a Telegram group digest. chat_id-scoped, service-role only (v1, no multi-tenant RLS).';
COMMENT ON TABLE telegram_messages IS
  'QAIT Tasker raw group message log; powers recent-context window + overnight batch. Pruned beyond the batch lookback.';
