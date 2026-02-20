-- Add metadata JSONB column to test_chat_mappings
-- Used to store resolver match type and trigger context for the Smart Test Case Resolver feedback loop
ALTER TABLE test_chat_mappings
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
