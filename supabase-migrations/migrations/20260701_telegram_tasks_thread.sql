-- QAIT Tasker — forum Topic (thread) scoping.
--
-- WHY: the team group runs in Telegram "Topics" (forum) mode, so one chat_id
-- carries several independent topic threads. Until now everything keyed on
-- chat_id only, flattening all topics into one pool — a "done" in the Design
-- topic could fuzzy-match a task from the Backend topic. We add the Telegram
-- `message_thread_id` so the fuzzy context (recent messages, the open-task list
-- the model reasons against, and the morning batch) is scoped PER TOPIC.
--
-- NULL thread_id = the group's "General" topic (messages with no
-- message_thread_id). Deterministic reply links (source_msg_id / bot_msg_id /
-- awaiting_deadline_msg_id) are unaffected — they already pin an exact task
-- regardless of topic; thread_id only narrows the fuzzy matching.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout. Existing rows get NULL
-- (treated as General) — correct for any pre-topic data.

ALTER TABLE telegram_messages ADD COLUMN IF NOT EXISTS thread_id BIGINT; -- Telegram message_thread_id (NULL = General)
ALTER TABLE telegram_tasks    ADD COLUMN IF NOT EXISTS thread_id BIGINT; -- topic the task lives in (NULL = General)

-- Topic-scoped access paths. NULLS NOT DISTINCT is not needed — queries use
-- `.is('thread_id', null)` for General and `.eq` otherwise.
CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat_thread
  ON telegram_messages(chat_id, thread_id, id);
CREATE INDEX IF NOT EXISTS idx_telegram_tasks_chat_thread_status
  ON telegram_tasks(chat_id, thread_id, status);
