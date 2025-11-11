-- =====================================================
-- Create Default User & Project for Anonymous Users
-- =====================================================

-- This is used when anonymous users (without valid UUID)
-- run tests through the chat interface

-- 1. Create default system user
INSERT INTO users (id, email, name, credits)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'system@qai-backend.local',
  'System (Anonymous Users)',
  999999 -- Unlimited credits for system
)
ON CONFLICT (id) DO NOTHING;

-- 2. Create default system project
INSERT INTO projects (id, name, description, user_id, settings)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'Default Project (Anonymous)',
  'Default project for anonymous test users and development testing',
  '00000000-0000-0000-0000-000000000000', -- References system user
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- 3. Verify creation
SELECT
  'User' as type,
  id,
  email as name,
  credits
FROM users
WHERE id = '00000000-0000-0000-0000-000000000000'

UNION ALL

SELECT
  'Project' as type,
  id,
  name,
  NULL as credits
FROM projects
WHERE id = '00000000-0000-0000-0000-000000000000';

-- =====================================================
-- Note: These are system resources
-- - Default User: 00000000-0000-0000-0000-000000000000
-- - Default Project: 00000000-0000-0000-0000-000000000000
-- All anonymous tests will be linked to this project
-- =====================================================
