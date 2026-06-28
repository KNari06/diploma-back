-- QAIT Tasker — bot-message → task back-references.
--
-- WHY: a user often replies to one of the BOT's own messages (an ack like
-- "📌 [JP] Pointer — in progress", or a Q&A answer) and then says "reopen it" /
-- "done" / "by Friday". Until now only two reply targets resolved to a specific
-- task deterministically: the task's own source message, and the bot's "when?"
-- deadline question (awaiting_deadline_msg_id). A reply to any OTHER bot message
-- fell back to LLM guessing against the open-task list — ambiguous.
--
-- This table records which task(s) each bot message was ABOUT, so a reply to
-- that bot message resolves to exactly those task(s) — same deterministic
-- reply-chain link, generalized. A single bot message can reference several
-- tasks (e.g. a multi-close ack), hence one row per (bot_msg_id, task_id).
--
-- Lifetime: only recent rows matter (a user replies shortly after). Pruned by
-- the sweep alongside telegram_messages.
--
-- Idempotent: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS telegram_bot_msg_refs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id    BIGINT NOT NULL,
  bot_msg_id BIGINT NOT NULL,                 -- the bot's message id (reply target)
  task_id    UUID NOT NULL REFERENCES telegram_tasks(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Resolve "reply to bot message X in chat C" → the task(s) it was about.
CREATE INDEX IF NOT EXISTS idx_telegram_bot_msg_refs_lookup
  ON telegram_bot_msg_refs(chat_id, bot_msg_id);
-- Prune by age (sweep deletes rows older than the lookback horizon).
CREATE INDEX IF NOT EXISTS idx_telegram_bot_msg_refs_created
  ON telegram_bot_msg_refs(created_at);

-- RLS: deny-by-default, service-role only (same posture as telegram_tasks).
ALTER TABLE telegram_bot_msg_refs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE telegram_bot_msg_refs IS
  'QAIT Tasker: bot message id → task id(s) it was about, so a reply to a bot ack/answer resolves deterministically. service-role only.';
