-- Migration: Add video, trace, and test reports support
-- Description: Adds columns for video/trace URLs to test_results and creates test_reports table for comprehensive reports

-- ============================================================================
-- 1. Add video & trace support to test_results table
-- ============================================================================

ALTER TABLE public.test_results
ADD COLUMN IF NOT EXISTS video_url TEXT,
ADD COLUMN IF NOT EXISTS trace_url TEXT;

COMMENT ON COLUMN public.test_results.video_url IS 'Supabase Storage URL for test video recording';
COMMENT ON COLUMN public.test_results.trace_url IS 'Supabase Storage URL for Playwright trace file';

-- ============================================================================
-- 2. Create test_reports table for comprehensive reports with generated code
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.test_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  test_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timeout')),
  executed_at TIMESTAMPTZ NOT NULL,
  duration INTEGER NOT NULL, -- Duration in milliseconds

  -- Generated Playwright code
  generated_code JSONB NOT NULL, -- { language, framework, code, steps, commands }

  -- Test artifacts
  artifacts JSONB NOT NULL, -- { video, trace, screenshots[], dom, logs[], networkLogs[] }

  -- AI Analysis
  analysis JSONB NOT NULL, -- { bugs[], severity, recommendations[], confidence }

  -- Summary statistics
  summary JSONB NOT NULL, -- { totalSteps, passedSteps, failedSteps, bugsFound, criticalBugs }

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_test_reports_test_id ON public.test_reports(test_id);
CREATE INDEX IF NOT EXISTS idx_test_reports_executed_at ON public.test_reports(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_reports_status ON public.test_reports(status);

COMMENT ON TABLE public.test_reports IS 'Comprehensive test reports with generated code and artifacts';
COMMENT ON COLUMN public.test_reports.generated_code IS 'Generated Playwright test code (language, framework, code, steps, commands)';
COMMENT ON COLUMN public.test_reports.artifacts IS 'Test artifacts (video, trace, screenshots, DOM, logs)';
COMMENT ON COLUMN public.test_reports.analysis IS 'AI analysis results (bugs, severity, recommendations, confidence)';
COMMENT ON COLUMN public.test_reports.summary IS 'Summary statistics (total/passed/failed steps, bugs found)';

-- ============================================================================
-- 3. Create test_jira_issues table to track Jira integration
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.test_jira_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  jira_issue_key TEXT NOT NULL, -- e.g., "PROJ-123"
  jira_issue_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_test_jira_issues_test_id ON public.test_jira_issues(test_id);
CREATE INDEX IF NOT EXISTS idx_test_jira_issues_jira_key ON public.test_jira_issues(jira_issue_key);

COMMENT ON TABLE public.test_jira_issues IS 'Links between test reports and Jira issues';
COMMENT ON COLUMN public.test_jira_issues.jira_issue_key IS 'Jira issue key (e.g., PROJ-123)';
COMMENT ON COLUMN public.test_jira_issues.jira_issue_url IS 'Direct URL to the Jira issue';

-- ============================================================================
-- 4. Create Supabase Storage bucket for test artifacts (if not exists)
-- ============================================================================

-- Note: This requires Supabase admin/dashboard access
-- Create bucket manually or via Supabase API:
--
-- Bucket name: test-artifacts
-- Public: true (for easy access to videos/traces)
-- File size limit: 100MB
-- Allowed MIME types: video/webm, application/zip, image/png, image/jpeg
--
-- Folder structure:
-- - test-artifacts/{userId}/videos/
-- - test-artifacts/{userId}/traces/
-- - test-artifacts/{userId}/screenshots/

-- ============================================================================
-- 5. Row Level Security (RLS) Policies
-- ============================================================================

-- Enable RLS
ALTER TABLE public.test_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_jira_issues ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own test reports
CREATE POLICY test_reports_select_policy ON public.test_reports
  FOR SELECT
  USING (
    test_id IN (
      SELECT id FROM public.tests WHERE user_id = auth.uid()
    )
  );

-- Policy: System can insert test reports
CREATE POLICY test_reports_insert_policy ON public.test_reports
  FOR INSERT
  WITH CHECK (true); -- Allow inserts from service role

-- Policy: Users can read their own Jira issues
CREATE POLICY test_jira_issues_select_policy ON public.test_jira_issues
  FOR SELECT
  USING (
    test_id IN (
      SELECT id FROM public.tests WHERE user_id = auth.uid()
    )
  );

-- Policy: System can insert Jira issues
CREATE POLICY test_jira_issues_insert_policy ON public.test_jira_issues
  FOR INSERT
  WITH CHECK (true); -- Allow inserts from service role

-- ============================================================================
-- 6. Trigger to update updated_at timestamp
-- ============================================================================

CREATE OR REPLACE FUNCTION update_test_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_reports_updated_at_trigger
  BEFORE UPDATE ON public.test_reports
  FOR EACH ROW
  EXECUTE FUNCTION update_test_reports_updated_at();

-- ============================================================================
-- 7. Grant permissions
-- ============================================================================

-- Grant access to authenticated users
GRANT SELECT ON public.test_reports TO authenticated;
GRANT SELECT ON public.test_jira_issues TO authenticated;

-- Grant full access to service role (backend)
GRANT ALL ON public.test_reports TO service_role;
GRANT ALL ON public.test_jira_issues TO service_role;

-- Grant usage on sequences if any
-- (none in this case, using gen_random_uuid())

-- ============================================================================
-- Migration complete
-- ============================================================================

-- Verify tables exist
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name = 'test_reports'
  ) THEN
    RAISE NOTICE '✅ test_reports table created successfully';
  END IF;

  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name = 'test_jira_issues'
  ) THEN
    RAISE NOTICE '✅ test_jira_issues table created successfully';
  END IF;

  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'test_results'
    AND column_name = 'video_url'
  ) THEN
    RAISE NOTICE '✅ video_url column added to test_results';
  END IF;

  IF EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'test_results'
    AND column_name = 'trace_url'
  ) THEN
    RAISE NOTICE '✅ trace_url column added to test_results';
  END IF;
END $$;
