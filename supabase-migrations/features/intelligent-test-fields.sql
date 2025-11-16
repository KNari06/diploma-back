-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: Add Intelligent Test Fields
-- Description: Add support for AI-driven intelligent testing
-- ═══════════════════════════════════════════════════════════════════════════

-- Add fields to tests table for intelligent testing
ALTER TABLE public.tests
ADD COLUMN IF NOT EXISTS intelligent_mode BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS test_goal TEXT,
ADD COLUMN IF NOT EXISTS commands JSONB DEFAULT '[]'::jsonb;

-- Add AI metadata to test_results table
ALTER TABLE public.test_results
ADD COLUMN IF NOT EXISTS ai_metadata JSONB;

-- Create index for intelligent mode queries
CREATE INDEX IF NOT EXISTS idx_tests_intelligent_mode
ON public.tests(intelligent_mode)
WHERE intelligent_mode = true;

-- Add comments for documentation
COMMENT ON COLUMN public.tests.intelligent_mode IS 'Flag indicating if this is an AI-driven intelligent test';
COMMENT ON COLUMN public.tests.test_goal IS 'High-level testing goal for intelligent mode (e.g., "Test entire website")';
COMMENT ON COLUMN public.tests.commands IS 'Playwright commands to execute (for both standard and intelligent tests)';
COMMENT ON COLUMN public.test_results.ai_metadata IS 'Metadata from AI exploration: pages visited, devices tested, issues found, etc.';

-- Example ai_metadata structure:
-- {
--   "intelligentMode": true,
--   "pagesVisited": 15,
--   "totalActions": 47,
--   "explorationTime": "3m 42s",
--   "devicesTested": ["desktop", "mobile"],
--   "issuesFound": 3,
--   "explorationComplete": true,
--   "continuationAvailable": false
-- }
