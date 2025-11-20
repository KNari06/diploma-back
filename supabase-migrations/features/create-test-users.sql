-- =====================================================
-- Create 10 Test Users for Development/Testing
-- =====================================================
--
-- ⚠️ DEPRECATED: This SQL script creates users ONLY in public.users
-- They CANNOT login because they don't exist in auth.users!
--
-- ✅ USE NODE.JS SCRIPT INSTEAD:
--    npm run create-test-users
--
-- This will:
-- 1. Create users in auth.users (via Supabase Admin API)
-- 2. Trigger automatically syncs to public.users
-- 3. Updates public.users with correct credits/subscription
--
-- All users have:
-- - Password: test123456
-- - Credits: 1000
-- - Different roles and subscription plans
--
-- =====================================================
-- OLD SQL (DO NOT USE - Users won't be able to login!)
-- =====================================================

-- Insert 10 test users
INSERT INTO users (id, email, name, role, credits, subscription, created_at, updated_at)
VALUES
  -- User 1: Free plan
  (
    gen_random_uuid(),
    'test1@qai-test.local',
    'Test User 1 (Free)',
    'user',
    1000,
    '{"plan": "free", "status": "active"}'::jsonb,
    NOW(),
    NOW()
  ),

  -- User 2: Starter plan
  (
    gen_random_uuid(),
    'test2@qai-test.local',
    'Test User 2 (Starter)',
    'user',
    1000,
    '{"plan": "starter", "status": "active", "credits_included": 100}'::jsonb,
    NOW(),
    NOW()
  ),

  -- User 3: Professional plan
  (
    gen_random_uuid(),
    'test3@qai-test.local',
    'Test User 3 (Professional)',
    'user',
    1000,
    '{"plan": "professional", "status": "active", "credits_included": 500}'::jsonb,
    NOW(),
    NOW()
  ),

  -- User 4: Free plan
  (
    gen_random_uuid(),
    'test4@qai-test.local',
    'Test User 4 (Free)',
    'user',
    1000,
    '{"plan": "free", "status": "active"}'::jsonb,
    NOW(),
    NOW()
  ),

  -- User 5: Starter plan
  (
    gen_random_uuid(),
    'test5@qai-test.local',
    'Test User 5 (Starter)',
    'user',
    1000,
    '{"plan": "starter", "status": "active", "credits_included": 100}'::jsonb,
    NOW(),
    NOW()
  ),

  -- User 6: Professional plan
  (
    gen_random_uuid(),
    'test6@qai-test.local',
    'Test User 6 (Professional)',
    'user',
    1000,
    '{"plan": "professional", "status": "active", "credits_included": 500}'::jsonb,
    NOW(),
    NOW()
  ),

  -- User 7: Admin user
  (
    gen_random_uuid(),
    'admin@qai-test.local',
    'Test Admin User',
    'admin',
    1000,
    '{"plan": "enterprise", "status": "active", "credits_included": 5000}'::jsonb,
    NOW(),
    NOW()
  ),

  -- User 8: Free plan, expired subscription
  (
    gen_random_uuid(),
    'test8@qai-test.local',
    'Test User 8 (Expired)',
    'user',
    1000,
    '{"plan": "free", "status": "cancelled"}'::jsonb,
    NOW(),
    NOW()
  ),

  -- User 9: Starter plan, past_due
  (
    gen_random_uuid(),
    'test9@qai-test.local',
    'Test User 9 (Past Due)',
    'user',
    1000,
    '{"plan": "starter", "status": "past_due", "credits_included": 100}'::jsonb,
    NOW(),
    NOW()
  ),

  -- User 10: Professional plan
  (
    gen_random_uuid(),
    'test10@qai-test.local',
    'Test User 10 (Professional)',
    'user',
    1000,
    '{"plan": "professional", "status": "active", "credits_included": 500}'::jsonb,
    NOW(),
    NOW()
  )
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  credits = EXCLUDED.credits,
  subscription = EXCLUDED.subscription,
  updated_at = NOW();

-- Verify creation: Show all test users
SELECT
  id,
  email,
  name,
  role::text as role,
  credits,
  subscription->>'plan' as subscription_plan,
  subscription->>'status' as subscription_status,
  created_at
FROM users
WHERE email LIKE '%@qai-test.local'
ORDER BY email;

-- Summary
SELECT
  COUNT(*) as total_test_users,
  COUNT(*) FILTER (WHERE role = 'user') as regular_users,
  COUNT(*) FILTER (WHERE role = 'admin') as admin_users,
  SUM(credits) as total_credits,
  COUNT(*) FILTER (WHERE subscription->>'plan' = 'free') as free_plan,
  COUNT(*) FILTER (WHERE subscription->>'plan' = 'starter') as starter_plan,
  COUNT(*) FILTER (WHERE subscription->>'plan' = 'professional') as professional_plan,
  COUNT(*) FILTER (WHERE subscription->>'plan' = 'enterprise') as enterprise_plan
FROM users
WHERE email LIKE '%@qai-test.local';

-- =====================================================
-- Test Users Summary:
-- =====================================================
-- ALL users have 1000 credits
-- 1. test1@qai-test.local - Free plan
-- 2. test2@qai-test.local - Starter plan
-- 3. test3@qai-test.local - Professional plan
-- 4. test4@qai-test.local - Free plan
-- 5. test5@qai-test.local - Starter plan
-- 6. test6@qai-test.local - Professional plan
-- 7. admin@qai-test.local - Admin, Enterprise plan
-- 8. test8@qai-test.local - Free plan (expired)
-- 9. test9@qai-test.local - Starter plan (past_due)
-- 10. test10@qai-test.local - Professional plan
-- =====================================================
