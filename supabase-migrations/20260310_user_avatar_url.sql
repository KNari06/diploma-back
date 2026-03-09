-- Add avatar_url column to users table for profile avatar uploads
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Create storage bucket for user avatars (run in Supabase Dashboard or via API)
-- INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
-- VALUES (
--   'user-avatars',
--   'user-avatars',
--   true,
--   2097152, -- 2MB
--   ARRAY['image/png', 'image/jpeg', 'image/webp']
-- )
-- ON CONFLICT (id) DO NOTHING;
