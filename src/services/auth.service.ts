import { supabase, supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { AuthUser, AuthTokens } from '@/types';
import { env } from '@/config/env';

/**
 * Sign up with email and password
 * @param email - User email
 * @param password - User password
 * @param name - User name
 * @returns Auth tokens and user data
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  name?: string
): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name: name || email.split('@')[0],
        },
      },
    });

    if (error) throw error;
    if (!data.user || !data.session) {
      throw new Error('Sign up failed: no user or session returned');
    }

    logger.info('User signed up', { userId: data.user.id, email });

    return {
      user: {
        id: data.user.id,
        email: data.user.email!,
        name: data.user.user_metadata?.name,
        role: 'user',
      },
      tokens: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in!,
      },
    };
  } catch (error) {
    logger.error('Sign up error', error);
    throw error;
  }
}

/**
 * Sign in with email and password
 * @param email - User email
 * @param password - User password
 * @returns Auth tokens and user data
 */
export async function signInWithEmail(
  email: string,
  password: string
): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
    if (!data.user || !data.session) {
      throw new Error('Sign in failed: no user or session returned');
    }

    logger.info('User signed in', { userId: data.user.id, email });

    return {
      user: {
        id: data.user.id,
        email: data.user.email!,
        name: data.user.user_metadata?.name,
        role: 'user',
      },
      tokens: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in!,
      },
    };
  } catch (error) {
    logger.error('Sign in error', error);
    throw error;
  }
}

/**
 * Sign in with magic link
 * @param email - User email
 * @param redirectTo - Optional redirect URL after verification
 * @returns Success status
 */
export async function signInWithMagicLink(
  email: string,
  redirectTo?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
      },
    });

    if (error) throw error;

    logger.info('Magic link sent', { email });

    return {
      success: true,
      message: 'Magic link sent to your email',
    };
  } catch (error) {
    logger.error('Magic link error', error);
    throw error;
  }
}

/**
 * Get OAuth URL for provider
 * @param provider - OAuth provider (google, github, etc.)
 * @param redirectTo - Redirect URL after OAuth
 * @returns OAuth URL
 */
export async function getOAuthUrl(
  provider: 'google' | 'github' | 'gitlab' | 'bitbucket',
  redirectTo?: string
): Promise<{ url: string }> {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: redirectTo || `${env.FRONTEND_URL}/auth/callback`,
      },
    });

    if (error) throw error;
    if (!data.url) throw new Error('No OAuth URL returned');

    logger.info('OAuth URL generated', { provider });

    return { url: data.url };
  } catch (error) {
    logger.error('OAuth URL generation error', error);
    throw error;
  }
}

/**
 * Sign out user
 * Note: Supabase signOut invalidates all sessions for the user
 * @returns Success status
 */
export async function signOut(): Promise<{ success: boolean }> {
  try {
    const { error } = await supabase.auth.signOut();

    if (error) throw error;

    logger.info('User signed out');

    return { success: true };
  } catch (error) {
    logger.error('Sign out error', error);
    throw error;
  }
}

/**
 * Refresh access token
 * @param refreshToken - Refresh token
 * @returns New tokens
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<AuthTokens> {
  try {
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) throw error;
    if (!data.session) throw new Error('No session returned');

    logger.info('Token refreshed');

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in!,
    };
  } catch (error) {
    logger.error('Token refresh error', error);
    throw error;
  }
}

/**
 * Verify JWT token and get user
 * @param accessToken - Access token
 * @returns User data or null
 */
export async function verifyToken(accessToken: string): Promise<AuthUser | null> {
  try {
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error) {
      logger.debug('Token verification failed', { error: error.message });
      return null;
    }

    if (!data.user) return null;

    // Get additional user data from public.users
    const { data: userData } = await supabaseAdmin
      .from('users')
      .select('role, name')
      .eq('id', data.user.id)
      .maybeSingle();

    return {
      id: data.user.id,
      email: data.user.email!,
      name: userData?.name || data.user.user_metadata?.name,
      role: userData?.role || 'user',
    };
  } catch (error) {
    logger.error('Token verification error', error);
    return null;
  }
}

/**
 * Get current user from token
 * @param accessToken - Access token
 * @returns User data with credits and subscription
 */
export async function getCurrentUser(accessToken: string): Promise<any> {
  try {
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error) throw error;
    if (!data.user) throw new Error('User not found');

    // Get full user data from public.users
    const { data: userData, error: dbError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if (dbError) throw dbError;
    if (!userData) {
      logger.warn('User not found in public.users, may not be synced yet', { userId: data.user.id });
      throw new Error('User data not found. Please try logging in again.');
    }

    return {
      id: data.user.id,
      email: data.user.email,
      name: userData?.name,
      role: userData?.role,
      credits: userData?.credits,
      subscription: userData?.subscription,
      created_at: userData?.created_at,
    };
  } catch (error) {
    logger.error('Get current user error', error);
    throw error;
  }
}

/**
 * Reset password request
 * @param email - User email
 * @returns Success status
 */
export async function requestPasswordReset(
  email: string,
  redirectTo?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo || `${env.FRONTEND_URL}/auth/reset-password`,
    });

    if (error) throw error;

    logger.info('Password reset requested', { email });

    return {
      success: true,
      message: 'Password reset link sent to your email',
    };
  } catch (error) {
    logger.error('Password reset request error', error);
    throw error;
  }
}

/**
 * Update password
 * @param accessToken - User access token
 * @param newPassword - New password
 * @returns Success status
 */
export async function updatePassword(
  accessToken: string,
  newPassword: string
): Promise<{ success: boolean }> {
  try {
    // Verify token first
    const user = await verifyToken(accessToken);
    if (!user) throw new Error('Invalid token');

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) throw error;

    logger.info('Password updated', { userId: user.id });

    return { success: true };
  } catch (error) {
    logger.error('Password update error', error);
    throw error;
  }
}

/**
 * Verify email with token
 * @param token - Email verification token
 * @param type - Token type (signup, recovery, etc.)
 * @returns Auth tokens
 */
export async function verifyEmail(
  token: string,
  type: 'signup' | 'recovery' | 'invite' | 'magiclink' = 'signup'
): Promise<AuthTokens> {
  try {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: token,
      type,
    });

    if (error) throw error;
    if (!data.session) throw new Error('No session returned');

    logger.info('Email verified', { userId: data.user?.id });

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in!,
    };
  } catch (error) {
    logger.error('Email verification error', error);
    throw error;
  }
}
