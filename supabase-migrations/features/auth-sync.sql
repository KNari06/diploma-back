-- Auth Sync Migration
-- This migration creates automatic synchronization between auth.users and public.users
--
-- ВАЖНО: Этот SQL нужно выполнить в Supabase Dashboard → SQL Editor
--
-- Prerequisites:
-- - users table must exist in public schema
-- - Supabase Auth must be enabled
-- - Execute with service_role permissions

-- Function to sync auth.users to public.users
CREATE OR REPLACE FUNCTION public.sync_user_to_public()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Insert or update user in public.users
  INSERT INTO public.users (
    id,
    email,
    name,
    role,
    credits,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    'user',
    0, -- No initial credits, must be purchased
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    name = COALESCE(EXCLUDED.name, public.users.name),
    updated_at = NOW();

  RETURN NEW;
END;
$$;

-- Trigger on auth.users for INSERT and UPDATE
-- Note: Requires service_role permissions to create triggers on auth schema
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_user_to_public();

-- Function to handle user deletion
CREATE OR REPLACE FUNCTION public.handle_auth_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete user from public.users when deleted from auth.users
  DELETE FROM public.users WHERE id = OLD.id;
  RETURN OLD;
END;
$$;

-- Trigger on auth.users for DELETE
DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;

CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_auth_user_delete();

-- Comment for documentation
COMMENT ON FUNCTION public.sync_user_to_public() IS 'Automatically syncs auth.users to public.users on INSERT/UPDATE';
COMMENT ON FUNCTION public.handle_auth_user_delete() IS 'Automatically deletes from public.users when auth user is deleted';
