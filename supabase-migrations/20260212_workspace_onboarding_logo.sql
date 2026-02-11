-- ============================================================================
-- WORKSPACE ONBOARDING ENHANCEMENTS AND LOGO SUPPORT
-- ============================================================================
-- Adds logo URL column to workspaces table for workspace branding
-- Supports workspace customization with logo uploads
-- Created: 2026-02-12
-- ============================================================================

-- Add logo_url column to workspaces table
ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Add comment for documentation
COMMENT ON COLUMN workspaces.logo_url IS 'URL to workspace logo image stored in Supabase Storage (workspace-logos bucket). Path structure: {userId}/{workspaceId}/logo_{timestamp}.{ext}';

-- Create index for logo_url queries (useful for filtering workspaces with/without logos)
CREATE INDEX IF NOT EXISTS idx_workspaces_logo_url
  ON workspaces(logo_url)
  WHERE logo_url IS NOT NULL;

-- ============================================================================
-- SUPABASE STORAGE BUCKET FOR WORKSPACE LOGOS
-- ============================================================================
-- IMPORTANT: This bucket must be created manually via Supabase Dashboard or API
--
-- Steps to create bucket:
-- 1. Go to Supabase Dashboard → Storage
-- 2. Click "Create a new bucket"
-- 3. Configuration:
--    - Bucket name: workspace-logos
--    - Public: false (private access only)
--    - File size limit: 2MB
--    - Allowed MIME types: image/png, image/jpeg, image/svg+xml, image/webp
--
-- Folder structure in bucket:
--   workspace-logos/
--     └── {userId}/
--         └── {workspaceId}/
--             └── logo_{timestamp}.{ext}
-- ============================================================================

-- ============================================================================
-- RLS POLICIES FOR STORAGE BUCKET (workspace-logos)
-- ============================================================================
-- These policies should be added in Supabase Dashboard:
-- Storage → workspace-logos → Policies
--
-- Policy 1: "Users can upload logos to their workspace"
-- Operation: INSERT
-- Target roles: authenticated
-- WITH CHECK expression:
--   bucket_id = 'workspace-logos'
--   AND (storage.foldername(name))[1] = auth.uid()::text
--
-- Policy 2: "Users can read their own workspace logos"
-- Operation: SELECT
-- Target roles: authenticated
-- USING expression:
--   bucket_id = 'workspace-logos'
--   AND (storage.foldername(name))[1] = auth.uid()::text
--
-- Policy 3: "Users can delete their own workspace logos"
-- Operation: DELETE
-- Target roles: authenticated
-- USING expression:
--   bucket_id = 'workspace-logos'
--   AND (storage.foldername(name))[1] = auth.uid()::text
--
-- Policy 4: "Users can update their own workspace logos"
-- Operation: UPDATE
-- Target roles: authenticated
-- USING expression:
--   bucket_id = 'workspace-logos'
--   AND (storage.foldername(name))[1] = auth.uid()::text
-- ============================================================================

-- ============================================================================
-- ONBOARDING FIELDS STRUCTURE (stored in settings JSONB)
-- ============================================================================
-- The onboarding flow now captures additional user profile information:
--
-- settings JSON structure:
-- {
--   "onboarding_completed": true,
--   "onboarding_completed_at": "2024-02-12T10:30:00Z",
--   "role": "qaEngineer",                    // NEW: user's role
--   "position": "Senior QA Engineer",        // NEW: user's position (optional)
--   "accountType": "company",                // NEW: company or individual
--   "companyName": "Acme Corp",              // NEW: company name (required when accountType=company)
--   "baseUrls": ["https://dev.example.com"],
--   "environments": {
--     "dev": "https://dev.example.com",
--     "prod": "https://prod.example.com"
--   },
--   "browserType": "chrome"
-- }
--
-- Valid values:
-- - role: 'qaEngineer' | 'developer' | 'productManager' | 'teamLead' | 'cto' | 'other'
-- - accountType: 'company' | 'individual'
-- - position: string (max 255 chars, optional)
-- - companyName: string (max 255 chars, required when accountType='company')
-- ============================================================================

-- ============================================================================
-- MIGRATION NOTES
-- ============================================================================
-- 1. This migration is idempotent (safe to run multiple times)
-- 2. The logo_url column is nullable (workspaces can exist without logos)
-- 3. Onboarding fields are stored in the existing settings JSONB column
-- 4. No data migration needed - new fields are optional
-- 5. The storage bucket and RLS policies must be created manually
-- 6. Backend handles logo upload/delete via Supabase Storage SDK
-- ============================================================================

-- Update table comment
COMMENT ON TABLE workspaces IS 'User workspaces with onboarding data, settings, and optional logo branding';
