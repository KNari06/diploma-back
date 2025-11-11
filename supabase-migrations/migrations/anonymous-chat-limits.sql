-- Anonymous Chat Limits & User Credits Migration
-- ✅ SUCCESSFULLY APPLIED TO SUPABASE
-- This file is kept for reference and future deployments

SET search_path TO public;

-- 1. Anonymous chat sessions
CREATE TABLE IF NOT EXISTS public.anonymous_chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anonymous_id TEXT NOT NULL,
  title TEXT,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Anonymous chat messages
CREATE TABLE IF NOT EXISTS public.anonymous_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.anonymous_chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'ai')),
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Anonymous usage limits
CREATE TABLE IF NOT EXISTS public.anonymous_usage_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anonymous_id TEXT NOT NULL UNIQUE,
  request_count INTEGER DEFAULT 0,
  last_request_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  first_request_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. User credits
CREATE TABLE IF NOT EXISTS public.user_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  credits_balance INTEGER NOT NULL DEFAULT 0,
  total_purchased INTEGER NOT NULL DEFAULT 0,
  total_used INTEGER NOT NULL DEFAULT 0,
  subscription_plan TEXT DEFAULT 'free',
  subscription_status TEXT DEFAULT 'inactive',
  subscription_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Credit transactions
CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_anon_chat_sessions_anonymous_id ON public.anonymous_chat_sessions(anonymous_id);
CREATE INDEX IF NOT EXISTS idx_anon_chat_sessions_created_at ON public.anonymous_chat_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anon_chat_messages_session_id ON public.anonymous_chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_anon_chat_messages_created_at ON public.anonymous_chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anon_usage_limits_anonymous_id ON public.anonymous_usage_limits(anonymous_id);
CREATE INDEX IF NOT EXISTS idx_anon_usage_limits_last_request ON public.anonymous_usage_limits(last_request_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_credits_user_id ON public.user_credits(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credits_subscription_status ON public.user_credits(subscription_status);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON public.credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at ON public.credit_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_type ON public.credit_transactions(transaction_type);

-- Cleanup function
CREATE OR REPLACE FUNCTION public.cleanup_old_anonymous_data()
RETURNS void AS $$
BEGIN
  DELETE FROM public.anonymous_chat_sessions WHERE created_at < NOW() - INTERVAL '7 days';
  DELETE FROM public.anonymous_usage_limits WHERE last_request_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Enable RLS
ALTER TABLE public.anonymous_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anonymous_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anonymous_usage_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

-- Development policies (permissive)
CREATE POLICY "Allow all on anonymous_chat_sessions" ON public.anonymous_chat_sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on anonymous_chat_messages" ON public.anonymous_chat_messages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on anonymous_usage_limits" ON public.anonymous_usage_limits FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on user_credits" ON public.user_credits FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on credit_transactions" ON public.credit_transactions FOR ALL USING (true) WITH CHECK (true);

-- Grant permissions
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.anonymous_chat_sessions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.anonymous_chat_messages TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.anonymous_usage_limits TO anon;

-- Comments
COMMENT ON TABLE public.anonymous_chat_sessions IS 'Chat sessions for anonymous users';
COMMENT ON TABLE public.anonymous_chat_messages IS 'Chat messages from anonymous sessions';
COMMENT ON TABLE public.anonymous_usage_limits IS 'Rate limiting for anonymous users (3 requests per session)';
COMMENT ON TABLE public.user_credits IS 'Credits and subscription info for authenticated users';
COMMENT ON TABLE public.credit_transactions IS 'History of all credit purchases and usage';
