-- QAIT Tasker — deadline tracking.
--
-- WHY: when someone claims a task without a deadline, the bot asks "when will it
-- be ready?" and records the answer against that task. We store both a parsed
-- timestamp (for future due-date reminders / sorting) and the user's original
-- words (audit + when parsing is fuzzy, e.g. "к концу недели").
--
-- `awaiting_deadline_msg_id` is the bot's question message id: a user reply to
-- THAT message deterministically resolves the deadline answer back to this task
-- (reply-chain link), independent of LLM matching.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout.

ALTER TABLE telegram_tasks ADD COLUMN IF NOT EXISTS due_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE telegram_tasks ADD COLUMN IF NOT EXISTS due_text TEXT;                  -- user's original words, e.g. "к пятнице"
ALTER TABLE telegram_tasks ADD COLUMN IF NOT EXISTS awaiting_deadline_msg_id BIGINT; -- the bot's "when?" question msg id (reply target)

-- Find a task waiting on a deadline reply by the bot's question message id.
CREATE INDEX IF NOT EXISTS idx_telegram_tasks_awaiting_deadline
  ON telegram_tasks(chat_id, awaiting_deadline_msg_id)
  WHERE awaiting_deadline_msg_id IS NOT NULL;
