-- ─────────────────────────────────────────────────────────────────────────────
-- Allure Import Tracking Table
--
-- Stores one record per Allure ZIP import run.
-- Used by:
--   - AllureImportService: creates record on start, updates on complete/fail
--   - AllureImportController: GET /allure-import/status/:importId
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.allure_imports (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id       TEXT        NOT NULL,
  workspace_id  UUID        NOT NULL,

  -- Import lifecycle
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processing', 'completed', 'failed')),

  -- Optional file metadata (populated from the upload controller)
  file_name     TEXT,
  file_size     INTEGER,    -- bytes

  -- Final import statistics (JSON snapshot of AllureImportStats)
  stats         JSONB       DEFAULT '{}'::jsonb,

  -- Non-null only on 'failed' status
  error_message TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_allure_imports_project
  ON public.allure_imports (project_id);

CREATE INDEX IF NOT EXISTS idx_allure_imports_user
  ON public.allure_imports (user_id);

CREATE INDEX IF NOT EXISTS idx_allure_imports_status
  ON public.allure_imports (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.allure_imports ENABLE ROW LEVEL SECURITY;

-- Users can only see their own import records
CREATE POLICY "allure_imports_user_select"
  ON public.allure_imports
  FOR SELECT
  USING (user_id = auth.uid()::text);

-- Users can only insert their own records
CREATE POLICY "allure_imports_user_insert"
  ON public.allure_imports
  FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

-- Users can only update their own records
CREATE POLICY "allure_imports_user_update"
  ON public.allure_imports
  FOR UPDATE
  USING (user_id = auth.uid()::text);

-- Service role (used by supabaseAdmin in the backend) bypasses RLS automatically
