-- Remove pre-seeded "welcome" chat messages.
--
-- Backstory: chat sessions used to be seeded with an AI greeting at create
-- time (ChatService.insertWelcomeMessage). It was emitted on subscribe and
-- replayed on history load, which produced a phantom "first reply" on top
-- of the real LLM answer when the user said hi. The seed is gone from the
-- code path; this migration deletes the rows it left behind so the next
-- history load doesn't resurrect them.
--
-- Safe to re-run: idempotent.

DELETE FROM chat_messages
WHERE metadata ->> 'type' = 'welcome';
