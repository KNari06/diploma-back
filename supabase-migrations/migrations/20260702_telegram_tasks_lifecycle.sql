-- QAIT Tasker — unify status+progress into ONE lifecycle; normalize owner;
-- per-digest-line source anchor; message idempotency.
--
-- WHY (structural fixes from the data-model audit):
--  1) status (open|closed|expired) and progress (none|in_progress|blocked|
--     needs_investigation) were TWO orthogonal enums → impossible states existed
--     in prod (closed + in_progress). Replaced by a SINGLE `lifecycle` column:
--     open → in_progress → blocked → done → expired. A task is in exactly one
--     state. `needs_investigation` folds into `blocked`.
--  2) owner was free text (mixing "@ndarkhans", alias "Dara", bare "Serzhan").
--     Split into owner_handle (canonical, normalized on write) + owner_display
--     (the raw words, for show). Queries/@mentions use owner_handle.
--  3) a digest message creates MANY tasks all sharing ONE source_msg_id →
--     ambiguous reply resolution + useless per-line links. Add digest_line_index
--     so each task knows which line of its source message it came from.
--  4) Telegram retries a slow webhook → duplicate ingests. UNIQUE(chat_id,
--     tg_msg_id) makes message logging idempotent.
--
-- DUAL-WRITE WINDOW: the OLD status/progress columns are KEPT (not dropped) so a
-- briefly-overlapping old-code instance during deploy keeps working. A later
-- migration drops them once new code is fully rolled out.
--
-- Idempotent: IF NOT EXISTS throughout; backfill is safe to re-run.

-- ── new columns ──────────────────────────────────────────────────────────────
ALTER TABLE telegram_tasks ADD COLUMN IF NOT EXISTS lifecycle TEXT;
ALTER TABLE telegram_tasks ADD COLUMN IF NOT EXISTS owner_handle TEXT;   -- canonical @handle (normalized)
ALTER TABLE telegram_tasks ADD COLUMN IF NOT EXISTS owner_display TEXT;  -- raw owner words as written
ALTER TABLE telegram_tasks ADD COLUMN IF NOT EXISTS digest_line_index INTEGER; -- which line of source_msg created this task

-- ── backfill lifecycle from the old two-enum state (status wins over progress) ─
UPDATE telegram_tasks SET lifecycle = CASE
  WHEN status = 'expired'                         THEN 'expired'
  WHEN status = 'closed'                          THEN 'done'
  WHEN progress = 'in_progress'                   THEN 'in_progress'
  WHEN progress = 'blocked'                       THEN 'blocked'
  WHEN progress = 'needs_investigation'           THEN 'blocked'  -- folded in
  ELSE 'open'
END
WHERE lifecycle IS NULL;

-- ── backfill owner split. owner_display = the raw value; owner_handle = it only
--    when it already looks like a @handle (bare names like "Serzhan" stay NULL in
--    owner_handle — they have no canonical handle to @mention). ──────────────────
UPDATE telegram_tasks SET owner_display = owner WHERE owner_display IS NULL AND owner IS NOT NULL;
UPDATE telegram_tasks SET owner_handle  = owner
  WHERE owner_handle IS NULL AND owner LIKE '@%';

-- ── constraints + defaults now that data is populated ────────────────────────
ALTER TABLE telegram_tasks ALTER COLUMN lifecycle SET DEFAULT 'open';
UPDATE telegram_tasks SET lifecycle = 'open' WHERE lifecycle IS NULL;
ALTER TABLE telegram_tasks ALTER COLUMN lifecycle SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE telegram_tasks ADD CONSTRAINT telegram_tasks_lifecycle_chk
    CHECK (lifecycle IN ('open','in_progress','blocked','done','expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_telegram_tasks_chat_thread_lifecycle
  ON telegram_tasks(chat_id, thread_id, lifecycle);

-- ── message idempotency ──────────────────────────────────────────────────────
-- Dedup any existing duplicate (chat_id, tg_msg_id) rows first (keep the lowest
-- id), else the unique index creation fails. tg_msg_id NULL rows are exempt.
DELETE FROM telegram_messages a USING telegram_messages b
  WHERE a.id > b.id AND a.chat_id = b.chat_id AND a.tg_msg_id = b.tg_msg_id
    AND a.tg_msg_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_messages_chat_msg
  ON telegram_messages(chat_id, tg_msg_id) WHERE tg_msg_id IS NOT NULL;
