-- Public B2C "Ask Me Anything" chat — conversation persistence.
--
-- The public widget (POST /api/v1/chat/public/ask) is unauthenticated, so these
-- conversations are ANONYMOUS: no user_id, no FK to users. We keep only what an
-- admin needs to review leads + privacy-safe context (a salted IP HASH, not the
-- raw IP; coarse country + user-agent). Writes are best-effort from the backend
-- and must never block or fail a chat reply.

-- ── Conversations ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public_chat_conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-generated session id (groups messages from one widget session).
  session_id       TEXT NOT NULL,
  lang             TEXT,                         -- UI language at send time (en/ru/kk)
  ip_hash          TEXT,                         -- salted SHA-256 of the IP (NOT the raw IP)
  country          TEXT,                         -- coarse geo if available
  user_agent       TEXT,                         -- raw UA string (truncated by backend)
  -- Optional contact if a lead leaves it (future-friendly; nullable today).
  contact_email    TEXT,
  contact_name     TEXT,
  message_count    INTEGER NOT NULL DEFAULT 0,
  last_message     TEXT,                         -- denormalized preview of the latest message
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_chat_conversations_session
  ON public_chat_conversations (session_id);
CREATE INDEX IF NOT EXISTS idx_public_chat_conversations_last_msg_at
  ON public_chat_conversations (last_message_at DESC);

-- ── Messages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public_chat_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES public_chat_conversations (id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_chat_messages_conversation
  ON public_chat_messages (conversation_id, created_at);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Lock down by default. The backend writes with the service-role key (bypasses
-- RLS), and the admin panel reads with the service-role key too. No anon/auth
-- policy is granted, so RLS-enforced clients see nothing.
ALTER TABLE public_chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_chat_messages ENABLE ROW LEVEL SECURITY;
