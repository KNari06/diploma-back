-- Add share_token column to regression_runs for public share links.
-- UNIQUE allows multiple NULLs in Postgres, so only rows with a token are constrained.
-- The unique constraint also creates an implicit index for fast lookups by share_token.
ALTER TABLE regression_runs ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE;
